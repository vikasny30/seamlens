import type { RuleMeta } from "../model.js";
import { finding, rule } from "./util.js";

const P001: RuleMeta = { id: "PRO001", title: "Protobuf package is versioned", category: "grpc", severity: "warning",
  why: "Without a version in the package (acme.orders.v1) a breaking redesign has to rename or fork every message and service.",
  fix: "Use a versioned package such as `acme.orders.v1` and create `v2` for incompatible changes." };
const P002: RuleMeta = { id: "PRO002", title: "Enums start with an UNSPECIFIED zero value", category: "grpc", severity: "warning",
  why: "In proto3 an unset enum field reads as the zero value. If that is a real value, a missing field silently means something.",
  fix: "Make the first enum value 0 and name it `<ENUM>_UNSPECIFIED`." };
const P003: RuleMeta = { id: "PRO003", title: "RPCs have their own request and response messages", category: "grpc", severity: "warning",
  why: "Reusing one message for request and response, or passing a domain message directly, means any field you add to one side leaks into the other and blocks independent evolution.",
  fix: "Give each rpc dedicated `<Rpc>Request` and `<Rpc>Response` messages." };
const P004: RuleMeta = { id: "PRO004", title: "Removed fields are reserved", category: "grpc", severity: "warning",
  why: "A gap in field numbers usually means a field was deleted. If its number is not reserved, a later field can reuse it and old clients will decode garbage without any error.",
  fix: "Add `reserved <numbers>;` (and `reserved \"old_name\";`) for every removed field." };
const P005: RuleMeta = { id: "PRO005", title: "List rpcs are paginated", category: "grpc", severity: "warning",
  why: "An unpaginated List rpc returns the whole table once it grows, blowing message size limits and memory.",
  fix: "Add `page_size` and `page_token` to the request and `next_page_token` to the response." };
const P006: RuleMeta = { id: "PRO006", title: "Money is not a float", category: "grpc", severity: "warning",
  why: "Floating point cannot represent decimal currency exactly; sums drift and equality checks fail.",
  fix: "Use integer minor units (int64 cents) or a decimal message such as `google.type.Money`." };
const P007: RuleMeta = { id: "PRO007", title: "Naming follows the style guide", category: "grpc", severity: "info",
  why: "rpc names are PascalCase and fields snake_case in the protobuf style guide; generated code in every language relies on it.",
  fix: "Rename (before the first release, since renaming a field is wire-compatible but renaming an rpc is not)." };

const lastSeg = (t: string) => t.replace(/^\./, "").split(".").pop()!;
const isWellKnown = (t: string) => /^\.?google\./.test(t);

export const grpcRules = [
  rule(P001, ({ scan }) => scan.protos.flatMap(pf => {
    if (!pf.services.length && !pf.messages.length) return [];
    if (!pf.package) return [finding(P001, { message: "No `package` declared", file: pf.file, line: 1 })];
    if (!/\.v\d+((alpha|beta)\d*)?$/.test(pf.package)) return [finding(P001, { message: `Package "${pf.package}" has no version suffix`, file: pf.file, line: 1, evidence: `package ${pf.package};` })];
    return [];
  })),

  rule(P002, ({ scan }) => scan.protos.flatMap(pf => pf.enums.flatMap(e => {
    const first = e.values[0];
    if (!first) return [];
    if (first.number !== 0) return [finding(P002, { message: `Enum ${e.fullName} does not start at 0 (first value ${first.name} = ${first.number})`, file: pf.file, line: first.line, evidence: `${first.name} = ${first.number};` })];
    if (pf.syntax === "proto3" && !/(UNSPECIFIED|UNKNOWN|UNSET|INVALID|NONE|DEFAULT)$/i.test(first.name))
      return [finding(P002, { message: `Enum ${e.fullName} uses a real value (${first.name}) as its zero value`, file: pf.file, line: first.line, evidence: `${first.name} = 0;` })];
    return [];
  }))),

  rule(P003, ({ scan }) => scan.protos.flatMap(pf => pf.services.flatMap(s => s.rpcs.flatMap(r => {
    const id = `rpc:${pf.package ? pf.package + "." : ""}${s.name}.${r.name}`;
    if (r.request === r.response && !isWellKnown(r.request)) return [finding(P003, { message: `${s.name}.${r.name} uses ${r.request} as both request and response`, file: pf.file, line: r.line, nodeId: id, evidence: `rpc ${r.name}(${r.request}) returns (${r.response})` })];
    const bad: string[] = [];
    if (!isWellKnown(r.request) && !/Request$/.test(lastSeg(r.request))) bad.push(`request ${lastSeg(r.request)}`);
    if (!isWellKnown(r.response) && !/Response$/.test(lastSeg(r.response))) bad.push(`response ${lastSeg(r.response)}`);
    return bad.length ? [finding(P003, { severity: "info", message: `${s.name}.${r.name}: ${bad.join(" and ")} not named *Request/*Response`, file: pf.file, line: r.line, nodeId: id, evidence: `rpc ${r.name}(${r.request}) returns (${r.response})` })] : [];
  })))),

  rule(P004, ({ scan }) => scan.protos.flatMap(pf => pf.messages.flatMap(m => {
    if (!m.fields.length) return [];
    const reserved = (n: number) => m.reserved.numbers.includes(n) || m.reserved.ranges.some(([a, b]) => n >= a && n <= b);
    const nums = m.fields.map(f => f.number).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let n = 1; n < nums[nums.length - 1]; n++) if (!nums.includes(n) && !reserved(n)) gaps.push(n);
    return gaps.length ? [finding(P004, { message: `${m.fullName} skips field number(s) ${gaps.slice(0, 5).join(", ")} without reserving them`, file: pf.file, line: m.line, evidence: `used: ${nums.join(", ")}; reserved: ${[...m.reserved.numbers, ...m.reserved.ranges.map(r => r.join("-"))].join(", ") || "none"}` })] : [];
  }))),

  rule(P005, ({ scan }) => scan.protos.flatMap(pf => pf.services.flatMap(s => s.rpcs.flatMap(r => {
    if (!/^List/.test(r.name)) return [];
    const req = pf.messages.find(m => m.name === lastSeg(r.request));
    if (!req) return [];
    if (req.fields.some(f => /^(page_?size|page_?token|limit|cursor|offset|page|after|before)$/i.test(f.name))) return [];
    return [finding(P005, { message: `${s.name}.${r.name} has no pagination fields in ${req.name}`, file: pf.file, line: r.line, nodeId: `rpc:${pf.package ? pf.package + "." : ""}${s.name}.${r.name}`, evidence: `fields: ${req.fields.map(f => f.name).join(", ") || "none"}` })];
  })))),

  rule(P006, ({ scan }) => scan.protos.flatMap(pf => pf.messages.flatMap(m => m.fields
    .filter(f => /(price|amount|balance|cost|total|fee|salary|money|revenue)/i.test(f.name) && /^(float|double)$/.test(f.type))
    .map(f => finding(P006, { message: `${m.fullName}.${f.name} is a ${f.type} but looks like money`, file: pf.file, line: f.line, evidence: `${f.type} ${f.name} = ${f.number};` }))))),

  rule(P007, ({ scan }) => scan.protos.flatMap(pf => {
    const bad: string[] = [];
    for (const s of pf.services) for (const r of s.rpcs) if (!/^[A-Z][A-Za-z0-9]*$/.test(r.name)) bad.push(`rpc ${r.name}`);
    for (const m of pf.messages) for (const f of m.fields) if (!/^[a-z][a-z0-9_]*$/.test(f.name)) bad.push(`${m.name}.${f.name}`);
    return bad.length ? [finding(P007, { message: `${bad.length} name(s) break protobuf style`, file: pf.file, line: 1, evidence: bad.slice(0, 5).join(", ") })] : [];
  })),
];
