import type { RuleMeta } from "../model.js";
import { finding, rule } from "./util.js";

const D001: RuleMeta = { id: "DB001", title: "Every table has a primary key", category: "data", severity: "error",
  why: "Without a primary key rows cannot be addressed reliably: replication, ORMs, upserts and de-duplication all break.",
  fix: "Add a primary key (a surrogate id or a natural key)." };
const D002: RuleMeta = { id: "DB002", title: "Foreign keys are indexed", category: "data", severity: "warning",
  why: "Joins and cascading deletes on an unindexed foreign key scan the whole child table. It is fast with 1,000 rows and an outage with 10 million.",
  fix: "Create an index whose leading column is the foreign key column." };
const D003: RuleMeta = { id: "DB003", title: "Money is not stored as floating point", category: "data", severity: "error",
  why: "FLOAT/REAL/DOUBLE cannot represent decimal fractions exactly, so totals drift and reconciliation fails.",
  fix: "Use NUMERIC/DECIMAL(p,s) or integer minor units." };
const D004: RuleMeta = { id: "DB004", title: "Destructive migrations use expand/contract", category: "data", severity: "warning",
  why: "Dropping or retyping a column in one step breaks the old application version that is still running during a rolling deploy.",
  fix: "Expand (add new), migrate data, switch code, then contract (drop) in a later release." };
const D005: RuleMeta = { id: "DB005", title: "New NOT NULL columns have a default", category: "data", severity: "error",
  why: "Adding NOT NULL without a default fails on a populated table or blocks old writers that do not know the column, and can lock the table while it rewrites.",
  fix: "Add the column nullable (or with a default), backfill, then add the constraint." };
const D006: RuleMeta = { id: "DB006", title: "Foreign keys state their delete behavior", category: "data", severity: "info",
  why: "The default (restrict/no action) is rarely a conscious choice. Orphans or surprise failures follow when a parent row is deleted.",
  fix: "State ON DELETE CASCADE, SET NULL or RESTRICT explicitly." };

export const dataRules = [
  rule(D001, ({ scan }) => Object.values(scan.sql.tables).filter(t => t.columns.length && !t.pk.length)
    .map(t => finding(D001, { message: `Table ${t.name} has no primary key`, file: t.file, line: t.line, nodeId: `table:${t.name}`, evidence: `columns: ${t.columns.map(c => c.name).join(", ")}` }))),

  rule(D002, ({ scan }) => {
    const out = [];
    for (const t of Object.values(scan.sql.tables)) {
      const idx = scan.sql.indexes.filter(i => i.table === t.name).map(i => i.columns[0]);
      if (t.pk[0]) idx.push(t.pk[0]);
      for (const u of t.uniques) if (u[0]) idx.push(u[0]);
      const fkCols = new Set(t.fks.flatMap(f => f.cols));
      for (const c of t.columns) {
        const isFk = fkCols.has(c.name);
        if (!isFk && !/_id$/.test(c.name)) continue;
        if (c.pk || idx.includes(c.name)) continue;
        out.push(finding(D002, { message: `${t.name}.${c.name} ${isFk ? "is a foreign key" : "looks like a foreign key"} with no index`, file: t.file, line: c.line, nodeId: `table:${t.name}`, confidence: isFk ? "high" : "medium", evidence: `${c.name} ${c.type}`.trim() }));
      }
    }
    return out;
  }),

  rule(D003, ({ scan }) => Object.values(scan.sql.tables).flatMap(t => t.columns
    .filter(c => /(price|amount|balance|cost|total|fee|salary|money|revenue)/i.test(c.name) && /\b(float|real|double)\b/i.test(c.type))
    .map(c => finding(D003, { message: `${t.name}.${c.name} stores money as ${c.type}`, file: t.file, line: c.line, nodeId: `table:${t.name}`, evidence: `${c.name} ${c.type}` })))),

  rule(D004, ({ scan }) => scan.sql.ops.filter(o => o.kind === "drop_table" || o.kind === "drop_column" || o.kind === "alter_type")
    .map(o => finding(D004, { message: `${o.kind.replace("_", " ")} on ${o.table}${o.column ? "." + o.column : ""} in a single step`, file: o.file, line: o.line, nodeId: `table:${o.table}`, evidence: o.text }))),

  rule(D005, ({ scan }) => scan.sql.ops.filter(o => o.kind === "add_column" && o.notNull && !o.hasDefault)
    .map(o => finding(D005, { message: `ADD COLUMN ${o.table}.${o.column} is NOT NULL with no default`, file: o.file, line: o.line, nodeId: `table:${o.table}`, evidence: o.text }))),

  rule(D006, ({ scan }) => Object.values(scan.sql.tables).flatMap(t => {
    const missing = t.fks.filter(f => !f.onDelete);
    return missing.length ? [finding(D006, { message: `${t.name}: ${missing.length} foreign key(s) with no ON DELETE behavior`, file: t.file, line: t.line, nodeId: `table:${t.name}`, evidence: missing.map(f => `${f.cols.join(",")} → ${f.refTable}`).join("; ") })] : [];
  })),
];
