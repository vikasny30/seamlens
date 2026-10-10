import type { SqlColumn, SqlSchema, SqlTable } from "../model.js";

export const emptySchema = (): SqlSchema => ({ tables: {}, indexes: [], ops: [] });

const unq = (s: string) => s.replace(/^[`"[]+|[`"\]]+$/g, "").replace(/^.*\./, "").trim();
const norm = (s: string) => unq(s).toLowerCase();

function stripComments(sql: string): string {
  let out = "", i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c; out += c; i++;
      while (i < n && sql[i] !== q) { out += sql[i]; i++; }
      out += q; i++; continue;
    }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { i += 2; while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) { if (sql[i] === "\n") out += "\n"; i++; } i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/** Split on `;` outside quotes. Returns statements with the line they start on. */
function splitStatements(sql: string, baseLine: number): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let cur = "", line = baseLine, startLine = -1, q = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) { cur += c; if (c === q) q = ""; if (c === "\n") line++; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; cur += c; if (startLine < 0) startLine = line; continue; }
    if (c === ";") { if (cur.trim()) out.push({ text: cur.trimStart(), line: startLine < 0 ? line : startLine }); cur = ""; startLine = -1; continue; }
    if (c === "\n") line++;
    if (startLine < 0 && !/\s/.test(c)) startLine = line;
    cur += c;
  }
  if (cur.trim()) out.push({ text: cur.trimStart(), line: startLine < 0 ? line : startLine });
  return out;
}

function balanced(s: string, open: number): number {
  let depth = 0, q = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitTop(s: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0, q = "", start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { out.push({ text: s.slice(start, i), offset: start }); start = i + 1; }
  }
  if (s.slice(start).trim()) out.push({ text: s.slice(start), offset: start });
  return out;
}

const colList = (s: string) => s.replace(/[()]/g, "").split(",").map(x => norm(x.trim().split(/\s+/)[0])).filter(Boolean);
const lineAt = (stmt: string, off: number, base: number) => base + (stmt.slice(0, off).match(/\n/g)?.length ?? 0);
const REF = /references\s+([`"\[\]\w.]+)\s*(?:\(([^)]*)\))?([^,]*)/i;
const ONDEL = /on\s+delete\s+(cascade|restrict|set\s+null|set\s+default|no\s+action)/i;

function parseColumn(item: string, off: number, stmt: string, baseLine: number): SqlColumn | null {
  const m = /^\s*([`"\[\]\w]+)\s+([\s\S]*)$/.exec(item);
  if (!m) return null;
  const name = norm(m[1]);
  const rest = m[2];
  const typeEnd = rest.search(/\b(not\s+null|null|default|primary|references|unique|check|constraint|generated|collate|autoincrement|auto_increment)\b/i);
  const type = (typeEnd < 0 ? rest : rest.slice(0, typeEnd)).trim().replace(/\s+/g, " ");
  const pk = /primary\s+key/i.test(rest);
  const col: SqlColumn = {
    name, type, pk, notNull: pk || /not\s+null/i.test(rest), hasDefault: /\bdefault\b/i.test(rest) || /autoincrement|auto_increment|serial/i.test(rest + type),
    line: lineAt(stmt, off + (item.length - item.trimStart().length), baseLine),
  };
  const r = REF.exec(rest);
  if (r) col.references = { table: norm(r[1]), column: r[2] ? norm(r[2]) : undefined, onDelete: ONDEL.exec(r[3] ?? "")?.[1]?.toLowerCase() };
  return col;
}

/** Parse DDL into `into` (so migrations apply in order). `baseLine` is the line of the first character of `sql`. */
export function parseSql(sql: string, file: string, baseLine = 1, into: SqlSchema = emptySchema()): SqlSchema {
  const clean = stripComments(sql);
  for (const { text: stmt, line } of splitStatements(clean, baseLine)) {
    const t = stmt.trim();

    let m = /^create\s+(?:global\s+|local\s+)?(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"\[\]\w.]+)\s*\(/i.exec(t);
    if (m) {
      const open = stmt.indexOf("(", stmt.toLowerCase().indexOf(m[1].toLowerCase()));
      const close = balanced(stmt, open);
      if (close < 0) continue;
      const body = stmt.slice(open + 1, close);
      const table: SqlTable = { name: norm(m[1]), columns: [], pk: [], fks: [], uniques: [], file, line };
      for (const { text: item, offset } of splitTop(body)) {
        const it = item.trim();
        let c: RegExpExecArray | null;
        if ((c = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(it))) table.pk = colList(c[1]);
        else if ((c = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([`"\[\]\w.]+)\s*(?:\(([^)]*)\))?([\s\S]*)/i.exec(it)))
          table.fks.push({ cols: colList(c[1]), refTable: norm(c[2]), refCols: c[3] ? colList(c[3]) : [], onDelete: ONDEL.exec(c[4] ?? "")?.[1]?.toLowerCase() });
        else if ((c = /^(?:constraint\s+\S+\s+)?unique\s*(?:key|index)?\s*(?:\S+\s*)?\(([^)]*)\)/i.exec(it))) table.uniques.push(colList(c[1]));
        else if (/^(constraint|check|index|key|fulltext|spatial|exclude)\b/i.test(it)) continue;
        else {
          const col = parseColumn(item, offset + 1 + (stmt.slice(0, open).length - stmt.slice(0, open).trimStart().length) * 0, stmt, line);
          if (col) {
            // column line = statement line + newlines before the item in the statement text
            col.line = lineAt(stmt, open + 1 + offset + (item.length - item.trimStart().length), line);
            table.columns.push(col);
            if (col.pk && !table.pk.includes(col.name)) table.pk.push(col.name);
            if (col.references) table.fks.push({ cols: [col.name], refTable: col.references.table, refCols: col.references.column ? [col.references.column] : [], onDelete: col.references.onDelete });
          }
        }
      }
      into.tables[table.name] = table;
      continue;
    }

    if ((m = /^create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(?:concurrently\s+)?([`"\[\]\w.]+)\s+on\s+(?:only\s+)?([`"\[\]\w.]+)\s*(?:using\s+\w+\s*)?\(([^)]*)\)/i.exec(t))) {
      into.indexes.push({ name: norm(m[2]), table: norm(m[3]), columns: colList(m[4]), unique: !!m[1], file, line });
      continue;
    }

    if ((m = /^drop\s+table\s+(?:if\s+exists\s+)?([`"\[\]\w.]+)/i.exec(t))) {
      const name = norm(m[1]);
      into.ops.push({ kind: "drop_table", table: name, file, line, text: t.slice(0, 120) });
      delete into.tables[name];
      continue;
    }

    if ((m = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([`"\[\]\w.]+)\s+([\s\S]*)$/i.exec(t))) {
      const table = norm(m[1]);
      const action = m[2];
      let a: RegExpExecArray | null;
      if ((a = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([`"\[\]\w]+)\s+([\s\S]*)$/i.exec(action)) && !/^(constraint|primary|foreign|unique|check|index|key)$/i.test(unq(a[1]))) {
        const col = parseColumn(`${a[1]} ${a[2]}`, 0, stmt, line);
        if (col) {
          into.ops.push({ kind: "add_column", table, column: col.name, notNull: col.notNull, hasDefault: col.hasDefault, file, line, text: t.slice(0, 120) });
          const tb = into.tables[table]; if (tb && !tb.columns.some(c => c.name === col.name)) tb.columns.push(col);
          if (col.references && tb) tb.fks.push({ cols: [col.name], refTable: col.references.table, refCols: col.references.column ? [col.references.column] : [], onDelete: col.references.onDelete });
        }
      } else if ((a = /^add\s+(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(action))) { const tb = into.tables[table]; if (tb) tb.pk = colList(a[1]); }
      else if ((a = /^add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([`"\[\]\w.]+)\s*(?:\(([^)]*)\))?([\s\S]*)/i.exec(action))) {
        const tb = into.tables[table]; if (tb) tb.fks.push({ cols: colList(a[1]), refTable: norm(a[2]), refCols: a[3] ? colList(a[3]) : [], onDelete: ONDEL.exec(a[4] ?? "")?.[1]?.toLowerCase() });
      } else if ((a = /^drop\s+column\s+(?:if\s+exists\s+)?([`"\[\]\w]+)/i.exec(action))) {
        into.ops.push({ kind: "drop_column", table, column: norm(a[1]), file, line, text: t.slice(0, 120) });
        const tb = into.tables[table]; if (tb) tb.columns = tb.columns.filter(c => c.name !== norm(a![1]));
      } else if ((a = /^(?:alter\s+column\s+([`"\[\]\w]+)\s+(?:set\s+data\s+)?type|modify\s+(?:column\s+)?([`"\[\]\w]+))/i.exec(action))) {
        into.ops.push({ kind: "alter_type", table, column: norm(a[1] ?? a[2]), file, line, text: t.slice(0, 120) });
      }
    }
  }
  return into;
}

/** Pull DDL out of code files (SQL kept in template strings or string literals). */
export function extractEmbeddedSql(text: string): { sql: string; line: number }[] {
  const out: { sql: string; line: number }[] = [];
  const re = /\b(create\s+(?:unique\s+)?(?:temp(?:orary)?\s+)?(?:table|index)|alter\s+table|drop\s+table)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let end: number;
    if (/^create\s+(?:temp(?:orary)?\s+)?table/i.test(m[0])) {
      // the body contains quotes and newlines: run to the matching close paren
      const open = text.indexOf("(", m.index);
      const close = open >= 0 ? balanced(text, open) : -1;
      if (close < 0) continue;
      end = close + 1;
    } else {
      const stop = text.slice(m.index).search(/[;`"']/);
      end = stop > 0 ? m.index + stop : text.length;
    }
    out.push({ sql: text.slice(m.index, end), line: text.slice(0, m.index).split("\n").length });
    re.lastIndex = Math.max(end, m.index + 1);
  }
  return out;
}
