import type { ProtoEnum, ProtoField, ProtoFile, ProtoMessage, ProtoReserved, ProtoService } from "../model.js";

interface Tok { t: string; line: number; kind: "id" | "num" | "str" | "sym" }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1; let s = "";
      while (j < n && src[j] !== q) { if (src[j] === "\\") j++; s += src[j]; j++; }
      toks.push({ t: s, line, kind: "str" }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1; while (j < n && /[0-9xXa-fA-F.]/.test(src[j])) j++;
      toks.push({ t: src.slice(i, j), line, kind: "num" }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c) || (c === "." && /[A-Za-z_]/.test(src[i + 1] ?? ""))) {
      let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++;
      toks.push({ t: src.slice(i, j), line, kind: "id" }); i = j; continue;
    }
    toks.push({ t: c, line, kind: "sym" }); i++;
  }
  return toks;
}

const num = (s: string) => (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s, 16) : parseInt(s, 10));

export function parseProto(file: string, text: string): ProtoFile {
  const toks = tokenize(text);
  let p = 0;
  const out: ProtoFile = { file, syntax: "proto2", package: "", messages: [], enums: [], services: [] };
  const peek = (o = 0) => toks[p + o];
  const next = () => toks[p++];
  const isSym = (s: string, o = 0) => peek(o)?.kind === "sym" && peek(o).t === s;

  const skipStatement = () => {
    let depth = 0;
    while (p < toks.length) {
      const t = next();
      if (t.kind === "sym") {
        if (t.t === "{" || t.t === "[" || t.t === "(") depth++;
        else if (t.t === "}" || t.t === "]" || t.t === ")") { depth--; if (depth < 0) { p--; return; } if (depth === 0 && t.t === "}") return; }
        else if (t.t === ";" && depth === 0) return;
      }
    }
  };

  const parseReserved = (): ProtoReserved => {
    const r: ProtoReserved = { numbers: [], ranges: [], names: [] };
    while (p < toks.length && !isSym(";")) {
      const t = next();
      if (t.kind === "str") r.names.push(t.t);
      else if (t.kind === "num") {
        const lo = num(t.t);
        if (peek()?.t === "to") {
          next(); const hiTok = next();
          r.ranges.push([lo, hiTok.t === "max" ? 536870911 : num(hiTok.t)]);
        } else r.numbers.push(lo);
      }
    }
    if (isSym(";")) next();
    return r;
  };

  const parseEnum = (prefix: string): void => {
    const nameTok = next();
    const e: ProtoEnum = { name: nameTok.t, fullName: prefix ? `${prefix}.${nameTok.t}` : nameTok.t, values: [], line: nameTok.line };
    if (isSym("{")) next();
    while (p < toks.length && !isSym("}")) {
      const t = peek();
      if (t.kind === "id" && (t.t === "option" || t.t === "reserved")) { skipStatement(); continue; }
      if (t.kind === "id" && isSym("=", 1)) {
        next(); next(); const v = next(); e.values.push({ name: t.t, number: num(v.t), line: t.line }); skipStatement();
      } else next();
    }
    if (isSym("}")) next();
    out.enums.push(e);
  };

  const parseMessage = (prefix: string): void => {
    const nameTok = next();
    const full = prefix ? `${prefix}.${nameTok.t}` : nameTok.t;
    const m: ProtoMessage = { name: nameTok.t, fullName: full, fields: [], reserved: { numbers: [], ranges: [], names: [] }, line: nameTok.line };
    if (isSym("{")) next();
    const parseFields = (oneof?: string) => {
      while (p < toks.length && !isSym("}")) {
        const t = peek();
        if (t.kind === "id") {
          if (t.t === "message") { next(); parseMessage(full); continue; }
          if (t.t === "enum") { next(); parseEnum(full); continue; }
          if (t.t === "oneof") { next(); const o = next(); if (isSym("{")) next(); parseFields(o.t); if (isSym("}")) next(); continue; }
          if (t.t === "reserved") { next(); const r = parseReserved(); m.reserved.numbers.push(...r.numbers); m.reserved.ranges.push(...r.ranges); m.reserved.names.push(...r.names); continue; }
          if (t.t === "option" || t.t === "extensions" || t.t === "extend" || t.t === "group") { skipStatement(); continue; }
          // field: [label] type name = N [options] ;
          let repeated = false, optional = false, map = false;
          if (t.t === "repeated" || t.t === "optional" || t.t === "required") { const l = next(); repeated = l.t === "repeated"; optional = l.t === "optional"; }
          let type: string;
          if (peek()?.t === "map" && isSym("<", 1)) {
            next(); next(); const k = next(); next(); const v = next(); next(); type = `map<${k.t},${v.t}>`; map = true;
          } else type = next().t;
          const nm = next();
          if (!nm || !isSym("=")) { skipStatement(); continue; }
          next(); const nTok = next();
          const f: ProtoField = { name: nm.t, type, number: num(nTok.t), repeated, optional: optional || !!oneof, map, line: nm.line };
          m.fields.push(f);
          skipStatement();
        } else next();
      }
    };
    parseFields();
    if (isSym("}")) next();
    out.messages.push(m);
  };

  const parseService = (): void => {
    const nameTok = next();
    const s: ProtoService = { name: nameTok.t, rpcs: [], line: nameTok.line };
    if (isSym("{")) next();
    while (p < toks.length && !isSym("}")) {
      const t = peek();
      if (t.kind === "id" && t.t === "rpc") {
        next(); const rn = next();
        if (isSym("(")) next();
        let clientStream = false, serverStream = false;
        if (peek()?.t === "stream") { next(); clientStream = true; }
        const req = next();
        if (isSym(")")) next();
        if (peek()?.t === "returns") next();
        if (isSym("(")) next();
        if (peek()?.t === "stream") { next(); serverStream = true; }
        const res = next();
        if (isSym(")")) next();
        s.rpcs.push({ name: rn.t, request: req.t, response: res.t, clientStream, serverStream, line: rn.line });
        if (isSym("{")) skipStatement(); else if (isSym(";")) next();
      } else if (t.kind === "id" && t.t === "option") skipStatement();
      else next();
    }
    if (isSym("}")) next();
    out.services.push(s);
  };

  while (p < toks.length) {
    const t = next();
    if (t.kind !== "id") continue;
    if (t.t === "syntax") { if (isSym("=")) next(); const v = next(); out.syntax = v?.t ?? "proto2"; skipStatement(); }
    else if (t.t === "package") { out.package = next().t; skipStatement(); }
    else if (t.t === "message") parseMessage("");
    else if (t.t === "enum") parseEnum("");
    else if (t.t === "service") parseService();
    else if (t.t === "import" || t.t === "option") skipStatement();
  }
  return out;
}
