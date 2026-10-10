import type { GEdge, GNode, Graph, Scan } from "./model.js";
import { matchRoute } from "./scan/match.js";

const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".");

/** Pick module granularity: one node per file for small repos, otherwise per directory at a depth that keeps the map readable. */
export function moduleOf(scan: Scan): (file: string) => string {
  const files = scan.sourceFiles;
  if (files.length <= 80 && !scan.config.moduleDepth) return f => f;
  const dirs = (depth: number) => (f: string) => { const d = dirOf(f); return d === "." ? "." : d.split("/").slice(0, depth).join("/"); };
  const want = scan.config.moduleDepth;
  if (want) return dirs(want);
  for (let depth = 6; depth >= 1; depth--) if (new Set(files.map(dirs(depth))).size <= 60) return dirs(depth);
  return dirs(1);
}

export function buildGraph(scan: Scan): Graph {
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  const node = (n: GNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return nodes.get(n.id)!; };
  const edge = (from: string, to: string, kind: GEdge["kind"], weight = 1) => {
    if (from === to) return;
    const k = `${from}>${to}>${kind}`;
    const e = edges.get(k);
    if (e) e.weight += weight; else edges.set(k, { from, to, kind, weight });
  };
  const mod = moduleOf(scan);
  const modId = (file: string) => `mod:${mod(file)}`;
  const touchMod = (file: string) => { const m = mod(file); return node({ id: `mod:${m}`, kind: "module", label: m, file: m === "." ? undefined : (scan.sourceFiles.includes(m) ? m : undefined), meta: { files: [] as string[] } }); };
  for (const f of scan.sourceFiles) (touchMod(f).meta!.files as string[]).push(f);

  for (const e of scan.imports) edge(modId(e.from), modId(e.to), "imports");

  // contracts: operations, rpcs, tables
  for (const doc of scan.openapi) for (const op of doc.ops) {
    const id = `op:${doc.file}:${op.key}`;
    node({ id, kind: "operation", label: op.key, file: op.file, line: op.line, meta: { operationId: op.operationId, doc: doc.file } });
  }
  for (const pf of scan.protos) for (const s of pf.services) for (const r of s.rpcs) {
    const id = `rpc:${pf.package ? pf.package + "." : ""}${s.name}.${r.name}`;
    node({ id, kind: "rpc", label: `${s.name}.${r.name}`, file: pf.file, line: r.line, meta: { request: r.request, response: r.response } });
  }
  for (const t of Object.values(scan.sql.tables)) node({ id: `table:${t.name}`, kind: "table", label: t.name, file: t.file, line: t.line, meta: { columns: t.columns.length } });
  for (const t of Object.values(scan.sql.tables)) for (const fk of t.fks) if (scan.sql.tables[fk.refTable]) edge(`table:${t.name}`, `table:${fk.refTable}`, "references");

  // routes and their handler modules; spec operations implemented by routes
  const basePath = scan.config.basePath ?? "";
  for (const r of scan.routes) {
    const id = `route:${r.method} ${r.path}@${r.file}:${r.line}`;
    node({ id, kind: "route", label: `${r.method} ${r.path}`, file: r.file, line: r.line, meta: { framework: r.framework, confidence: r.confidence } });
    edge(id, modId(r.file), "handles");
    for (const doc of scan.openapi) for (const op of doc.ops) {
      const m = matchRoute(op, r, basePath);
      if (m) edge(`op:${doc.file}:${op.key}`, id, "implements", m === "exact" ? 2 : 1);
    }
  }
  // gRPC rpc → module that mentions the rpc name (low confidence, names of 6+ chars only)
  for (const pf of scan.protos) for (const s of pf.services) for (const r of s.rpcs) {
    if (r.name.length < 6) continue;
    const re = new RegExp(`\\b${r.name}\\b`, "i");
    for (const f of scan.sourceFiles) if (re.test(scan.read(f))) edge(`rpc:${pf.package ? pf.package + "." : ""}${s.name}.${r.name}`, modId(f), "implements");
  }
  for (const c of scan.outbound) if (c.host) { node({ id: `ext:${c.host}`, kind: "external", label: c.host }); edge(modId(c.file), `ext:${c.host}`, "calls"); }
  for (const a of scan.tableAccess) if (nodes.has(`table:${a.table}`)) edge(modId(a.file), `table:${a.table}`, a.mode === "write" ? "writes" : "reads");

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Everything reachable downstream of a node (via imports/handles/reads/writes/calls) and upstream (who implements/handles/imports it). */
export function trace(graph: Graph, startId: string): { down: Set<string>; up: Set<string>; path: string[] } {
  const out = new Map<string, string[]>(), inn = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind === "references") continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e.from);
  }
  const bfs = (adj: Map<string, string[]>) => {
    const seen = new Set<string>([startId]);
    const q = [startId];
    while (q.length) { const n = q.shift()!; for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); q.push(m); } }
    seen.delete(startId);
    return seen;
  };
  const down = bfs(out), up = bfs(inn);
  return { down, up, path: [startId, ...down] };
}
