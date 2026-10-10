import type { ProtoFile, ProtoMessage } from "../model.js";
import type { Change } from "./types.js";

// Scalar types that share a wire encoding can be swapped without corrupting data (but still change JSON/semantics).
const WIRE_GROUPS = [["int32", "uint32", "int64", "uint64", "bool"], ["sint32", "sint64"], ["fixed32", "sfixed32"], ["fixed64", "sfixed64"], ["string", "bytes"]];
const wireCompatible = (a: string, b: string) => WIRE_GROUPS.some(g => g.includes(a) && g.includes(b));
const isReserved = (m: ProtoMessage, n: number) => m.reserved.numbers.includes(n) || m.reserved.ranges.some(([a, b]) => n >= a && n <= b);

export function diffProto(base: ProtoFile[], head: ProtoFile[]): Change[] {
  const out: Change[] = [];
  const key = (pf: ProtoFile, n: string) => `${pf.package}.${n}`;
  const bMsgs = new Map<string, { m: ProtoMessage; f: ProtoFile }>(), hMsgs = new Map<string, { m: ProtoMessage; f: ProtoFile }>();
  for (const pf of base) for (const m of pf.messages) bMsgs.set(key(pf, m.fullName), { m, f: pf });
  for (const pf of head) for (const m of pf.messages) hMsgs.set(key(pf, m.fullName), { m, f: pf });

  for (const [k, { m: bm }] of bMsgs) {
    const h = hMsgs.get(k);
    if (!h) { out.push({ level: "potentially-breaking", kind: "message-removed", subject: k, message: "message removed (breaking if any rpc or field still uses it)" }); continue; }
    const hm = h.m, file = h.f.file;
    const hByNum = new Map(hm.fields.map(f => [f.number, f]));
    for (const bf of bm.fields) {
      const hf = hByNum.get(bf.number);
      const subj = `${k}.${bf.name}`;
      if (!hf) {
        out.push(isReserved(hm, bf.number)
          ? { level: "safe", kind: "field-removed-reserved", subject: subj, message: `field ${bf.number} removed and reserved`, file }
          : { level: "breaking", kind: "field-removed-not-reserved", subject: subj, message: `field number ${bf.number} removed without \`reserved\`: it can be reused and corrupt old clients`, file });
        continue;
      }
      if (hf.name !== bf.name) out.push({ level: "potentially-breaking", kind: "field-renamed", subject: subj, message: `field ${bf.number} renamed ${bf.name} → ${hf.name} (wire-compatible, breaks JSON and text format)`, file });
      if (hf.type !== bf.type) out.push(wireCompatible(bf.type, hf.type)
        ? { level: "potentially-breaking", kind: "field-type-compatible", subject: subj, message: `field ${bf.number} type ${bf.type} → ${hf.type} (same wire encoding, different meaning or range)`, file }
        : { level: "breaking", kind: "field-type-changed", subject: subj, message: `field ${bf.number} type ${bf.type} → ${hf.type} (wire-incompatible)`, file });
      if (hf.repeated !== bf.repeated) out.push({ level: "breaking", kind: "field-cardinality-changed", subject: subj, message: `field ${bf.number} ${bf.repeated ? "repeated → singular" : "singular → repeated"}`, file });
    }
    for (const hf of hm.fields) if (!bm.fields.some(f => f.number === hf.number)) {
      out.push(isReserved(bm, hf.number)
        ? { level: "breaking", kind: "reserved-number-reused", subject: `${k}.${hf.name}`, message: `field number ${hf.number} was reserved in the base version and is reused`, file }
        : { level: "safe", kind: "field-added", subject: `${k}.${hf.name}`, message: `field ${hf.number} added`, file });
    }
  }
  for (const k of hMsgs.keys()) if (!bMsgs.has(k)) out.push({ level: "safe", kind: "message-added", subject: k, message: "message added" });

  // enums
  const enumMap = (fs: ProtoFile[]) => { const m = new Map<string, { e: ProtoFile["enums"][number]; f: ProtoFile }>(); for (const f of fs) for (const e of f.enums) m.set(key(f, e.fullName), { e, f }); return m; };
  const bEn = enumMap(base), hEn = enumMap(head);
  for (const [k, { e: be }] of bEn) {
    const h = hEn.get(k);
    if (!h) { out.push({ level: "potentially-breaking", kind: "enum-removed", subject: k, message: "enum removed" }); continue; }
    for (const bv of be.values) {
      const hv = h.e.values.find(v => v.name === bv.name);
      if (!hv) out.push({ level: h.e.values.some(v => v.number === bv.number) ? "potentially-breaking" : "breaking", kind: "enum-value-removed", subject: `${k}.${bv.name}`, message: `enum value ${bv.name} = ${bv.number} removed`, file: h.f.file });
      else if (hv.number !== bv.number) out.push({ level: "breaking", kind: "enum-value-renumbered", subject: `${k}.${bv.name}`, message: `enum value ${bv.name} changed number ${bv.number} → ${hv.number}`, file: h.f.file });
    }
    for (const hv of h.e.values) if (!be.values.some(v => v.name === hv.name)) out.push({ level: "safe", kind: "enum-value-added", subject: `${k}.${hv.name}`, message: `enum value ${hv.name} added`, file: h.f.file });
  }

  // services
  const svcMap = (fs: ProtoFile[]) => { const m = new Map<string, { s: ProtoFile["services"][number]; f: ProtoFile }>(); for (const f of fs) for (const s of f.services) m.set(key(f, s.name), { s, f }); return m; };
  const bS = svcMap(base), hS = svcMap(head);
  for (const [k, { s: bs }] of bS) {
    const h = hS.get(k);
    if (!h) { out.push({ level: "breaking", kind: "service-removed", subject: k, message: "service removed" }); continue; }
    for (const br of bs.rpcs) {
      const hr = h.s.rpcs.find(r => r.name === br.name);
      const subj = `${k}.${br.name}`;
      if (!hr) { out.push({ level: "breaking", kind: "rpc-removed", subject: subj, message: "rpc removed", file: h.f.file }); continue; }
      if (hr.request !== br.request) out.push({ level: "breaking", kind: "rpc-request-changed", subject: subj, message: `request type ${br.request} → ${hr.request}`, file: h.f.file });
      if (hr.response !== br.response) out.push({ level: "breaking", kind: "rpc-response-changed", subject: subj, message: `response type ${br.response} → ${hr.response}`, file: h.f.file });
      if (hr.clientStream !== br.clientStream || hr.serverStream !== br.serverStream) out.push({ level: "breaking", kind: "rpc-streaming-changed", subject: subj, message: "streaming mode changed", file: h.f.file });
    }
    for (const hr of h.s.rpcs) if (!bs.rpcs.some(r => r.name === hr.name)) out.push({ level: "safe", kind: "rpc-added", subject: `${k}.${hr.name}`, message: "rpc added", file: h.f.file });
  }
  for (const k of hS.keys()) if (!bS.has(k)) out.push({ level: "safe", kind: "service-added", subject: k, message: "service added" });
  return out;
}
