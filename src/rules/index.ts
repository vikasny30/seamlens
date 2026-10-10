import type { Finding, Graph, Rule, RuleMeta, Scan } from "../model.js";
import { SEVERITY_RANK } from "../model.js";
import { moduleOf } from "../graph.js";
import { httpRules } from "./http.js";
import { grpcRules } from "./grpc.js";
import { dataRules } from "./data.js";
import { archRules } from "./arch.js";
import { resilienceRules } from "./resilience.js";
import { driftRules } from "./drift.js";

export const ALL_RULES: Rule[] = [...httpRules, ...grpcRules, ...dataRules, ...archRules, ...resilienceRules, ...driftRules];
export const ruleMeta = (id: string): RuleMeta | undefined => { const r = ALL_RULES.find(x => x.id.toLowerCase() === id.toLowerCase()); return r && { id: r.id, title: r.title, category: r.category, severity: r.severity, why: r.why, fix: r.fix }; };
export const catalog = (): RuleMeta[] => ALL_RULES.map(r => ({ id: r.id, title: r.title, category: r.category, severity: r.severity, why: r.why, fix: r.fix }));

export function runRules(scan: Scan, graph: Graph): Finding[] {
  const disabled = new Set((scan.config.disabledRules ?? []).map(s => s.toUpperCase()));
  const nodeIds = new Set(graph.nodes.map(n => n.id));
  const mod = moduleOf(scan);
  const out: Finding[] = [];
  for (const r of ALL_RULES) {
    if (disabled.has(r.id)) continue;
    let found: Finding[] = [];
    try { found = r.check({ scan, graph }); } catch (e) { scan.warnings.push(`rule ${r.id} failed: ${(e as Error).message}`); }
    for (const f of found) {
      if (!f.nodeId && f.file) { const id = `mod:${mod(f.file)}`; if (nodeIds.has(id)) f.nodeId = id; }
      out.push(f);
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.ruleId.localeCompare(b.ruleId) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
}
