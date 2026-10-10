import type { Config, Finding, Graph, RuleMeta, Scan } from "./model.js";
import { scanRepo } from "./scan/index.js";
import { buildGraph } from "./graph.js";
import { runRules, catalog, ruleMeta } from "./rules/index.js";
import { scoreFindings, type Score } from "./score.js";

export interface Summary { root: string; sourceFiles: number; operations: number; rpcs: number; tables: number; routes: number; openapiFiles: string[]; protoFiles: string[] }
export interface Report { summary: Summary; score: Score; findings: Finding[]; graph: Graph; rules: RuleMeta[]; warnings: string[] }

export function analyze(root: string, override: Config = {}): { report: Report; scan: Scan } {
  const scan = scanRepo(root, override);
  const graph = buildGraph(scan);
  const findings = runRules(scan, graph);
  const summary: Summary = {
    root: scan.root, sourceFiles: scan.sourceFiles.length,
    operations: scan.openapi.reduce((n, d) => n + d.ops.length, 0), rpcs: scan.protos.reduce((n, p) => n + p.services.reduce((m, s) => m + s.rpcs.length, 0), 0),
    tables: Object.keys(scan.sql.tables).length, routes: scan.routes.length,
    openapiFiles: scan.openapi.map(d => d.file), protoFiles: scan.protos.map(p => p.file),
  };
  return { report: { summary, score: scoreFindings(findings), findings, graph, rules: catalog(), warnings: scan.warnings }, scan };
}

export { scanRepo, buildGraph, runRules, catalog, ruleMeta, scoreFindings };
export type { Config, Finding, Graph, Scan, RuleMeta, Score };
