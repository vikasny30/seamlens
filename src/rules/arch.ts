import type { Finding, RuleMeta, Scan } from "../model.js";
import { finding, rule } from "./util.js";

const R001: RuleMeta = { id: "ARC001", title: "No circular dependencies", category: "architecture", severity: "error",
  why: "Cycles make modules impossible to test, deploy or reason about in isolation and turn a small change into a change everywhere in the cycle.",
  fix: "Extract the shared piece into a module both sides depend on, or invert one dependency behind an interface." };
const R002: RuleMeta = { id: "ARC002", title: "Layers depend in one direction", category: "architecture", severity: "warning",
  why: "Handlers that reach into the data layer bypass business rules; a data layer that imports handlers inverts the dependency and makes the core untestable.",
  fix: "Route handler → service → repository. Configure your own layers in .seamlens.json if your names differ." };
const R003: RuleMeta = { id: "ARC003", title: "No god modules", category: "architecture", severity: "warning",
  why: "A file that imports dozens of others is doing too much; a file imported by dozens makes every change risky.",
  fix: "Split by responsibility; put widely shared types in a small stable module." };
const R004: RuleMeta = { id: "ARC004", title: "Packages are used through their public entry", category: "architecture", severity: "warning",
  why: "Deep imports into a sibling package couple you to its internals, so the owner cannot refactor without breaking you.",
  fix: "Import from the package's index/entry point and export what you need there." };

const COMMON = /\.(test|spec)\.|(^|\/)(tests?|__tests__)\//;

function sccs(nodes: string[], adj: Map<string, string[]>): string[][] {
  let idx = 0; const index = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), st: string[] = [], out: string[][] = [];
  const strong = (v: string) => {
    index.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) { const comp: string[] = []; let w: string; do { w = st.pop()!; on.delete(w); comp.push(w); } while (w !== v); if (comp.length > 1) out.push(comp); }
  };
  for (const v of nodes) if (!index.has(v)) strong(v);
  return out;
}

function cyclePath(comp: string[], adj: Map<string, string[]>): string[] {
  const set = new Set(comp), start = comp.sort()[0];
  const path: string[] = [start], seen = new Set([start]);
  const dfs = (v: string): boolean => {
    for (const w of adj.get(v) ?? []) {
      if (!set.has(w)) continue;
      if (w === start && path.length > 1) return true;
      if (seen.has(w)) continue;
      seen.add(w); path.push(w);
      if (dfs(w)) return true;
      path.pop(); seen.delete(w);
    }
    return false;
  };
  dfs(start);
  return [...path, start];
}

const HANDLER = /(^|\/)(routes?|controllers?|handlers?|api|endpoints|views|resolvers)(\/|\.|$)/i;
const SERVICE = /(^|\/)(services?|usecases?|use-cases?|domain|interactors?)(\/|\.|$)/i;
const DATA = /(^|\/)(repositor(y|ies)|dao|daos|persistence|database|db|store|stores)(\/|\.|$)/i;

function layerOf(scan: Scan, file: string): string | null {
  for (const l of scan.config.layers ?? []) {
    const re = new RegExp("^" + l.match.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
    if (re.test(file)) return l.name;
  }
  return null;
}

export const archRules = [
  rule(R001, ({ scan }) => {
    const files = scan.sourceFiles.filter(f => !COMMON.test(f));
    const adj = new Map<string, string[]>();
    for (const e of scan.imports) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    return sccs(files, adj).map((comp): Finding => {
      const cyc = cyclePath([...comp], adj);
      return finding(R001, { severity: comp.length > 2 ? "error" : "warning", message: `Circular dependency across ${comp.length} files`, file: cyc[0], line: 1, evidence: cyc.join(" → ") });
    });
  }),

  rule(R002, ({ scan }) => {
    const out: Finding[] = [];
    const configured = (scan.config.layers ?? []).length > 0;
    const hasServices = scan.sourceFiles.some(f => SERVICE.test(f) && !COMMON.test(f));
    const mayImport = new Map((scan.config.layers ?? []).map(l => [l.name, l.mayImport]));
    for (const e of scan.imports) {
      if (COMMON.test(e.from)) continue;
      if (configured) {
        const a = layerOf(scan, e.from), b = layerOf(scan, e.to);
        const allowed = a ? mayImport.get(a) : undefined;
        if (a && b && a !== b && allowed && !allowed.includes(b)) out.push(finding(R002, { message: `Layer "${a}" must not import layer "${b}"`, file: e.from, line: 1, evidence: `${e.from} → ${e.to}` }));
        continue;
      }
      if (HANDLER.test(e.from) && DATA.test(e.to) && !DATA.test(e.from) && hasServices) out.push(finding(R002, { message: "Handler imports the data layer directly, bypassing services", file: e.from, line: 1, confidence: "medium", evidence: `${e.from} → ${e.to}` }));
      if (DATA.test(e.from) && HANDLER.test(e.to) && !HANDLER.test(e.from)) out.push(finding(R002, { severity: "error", message: "Data layer imports a handler (inverted dependency)", file: e.from, line: 1, confidence: "medium", evidence: `${e.from} → ${e.to}` }));
      if (SERVICE.test(e.from) && HANDLER.test(e.to) && !HANDLER.test(e.from)) out.push(finding(R002, { message: "Service imports a handler (inverted dependency)", file: e.from, line: 1, confidence: "medium", evidence: `${e.from} → ${e.to}` }));
    }
    return out;
  }),

  rule(R003, ({ scan }) => {
    const fanOut = new Map<string, Set<string>>(), fanIn = new Map<string, Set<string>>();
    for (const e of scan.imports) {
      if (COMMON.test(e.from)) continue;
      (fanOut.get(e.from) ?? fanOut.set(e.from, new Set()).get(e.from)!).add(e.to);
      (fanIn.get(e.to) ?? fanIn.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    const out: Finding[] = [];
    for (const [f, s] of fanOut) if (s.size >= 15) out.push(finding(R003, { message: `${f} imports ${s.size} other files`, file: f, line: 1, evidence: [...s].slice(0, 4).join(", ") + ", …" }));
    for (const [f, s] of fanIn) if (s.size >= 25) out.push(finding(R003, { message: `${f} is imported by ${s.size} files; changes here ripple widely`, file: f, line: 1, confidence: "medium" }));
    return out;
  }),

  rule(R004, ({ scan }) => {
    const pkgOf = (f: string) => { const m = /^((?:packages|services|apps|libs)\/[^/]+)\//.exec(f); return m?.[1]; };
    const out: Finding[] = [];
    for (const e of scan.imports) {
      const a = pkgOf(e.from), b = pkgOf(e.to);
      if (!a || !b || a === b) continue;
      const rest = e.to.slice(b.length + 1);
      if (/^(src\/)?index\.[a-z]+$/.test(rest)) continue;
      out.push(finding(R004, { message: `${a} reaches into ${b} internals`, file: e.from, line: 1, evidence: `${e.from} → ${e.to}` }));
    }
    return out;
  }),
];
