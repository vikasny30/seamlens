import type { Finding, RuleMeta, Severity } from "./model.js";
import { SEVERITY_RANK } from "./model.js";
import type { Report } from "./index.js";

export function toText(r: Report, min: Severity = "info"): string {
  const L: string[] = [];
  L.push(`SeamLens: ${r.summary.root}`);
  const none = !(r.summary.operations + r.summary.rpcs + r.summary.tables + r.summary.routes + r.summary.sourceFiles);
  L.push(none ? "Nothing to analyse: no contracts, routes or code were found here (a score would be meaningless)." : `Contract health ${r.score.overall}/100 (grade ${r.score.grade})   ${r.score.counts.error} errors, ${r.score.counts.warning} warnings, ${r.score.counts.info} info`);
  L.push(`Found: ${r.summary.operations} operations, ${r.summary.rpcs} rpcs, ${r.summary.tables} tables, ${r.summary.routes} routes, ${r.summary.sourceFiles} source files`);
  L.push("");
  for (const f of r.findings.filter(f => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[min])) {
    L.push(`${f.severity.toUpperCase().padEnd(7)} ${f.ruleId.padEnd(7)} ${f.file ?? ""}${f.line ? ":" + f.line : ""}`);
    L.push(`        ${f.message}`);
    if (f.evidence) L.push(`        evidence: ${f.evidence}`);
  }
  if (r.warnings.length) { L.push(""); L.push(`${r.warnings.length} warning(s) while scanning:`); r.warnings.slice(0, 5).forEach(w => L.push(`  ${w}`)); }
  return L.join("\n");
}

export function toMarkdown(r: Report, min: Severity = "info"): string {
  const L: string[] = [];
  L.push(`# SeamLens report`, "");
  L.push(`**Contract health: ${r.score.overall}/100 (grade ${r.score.grade})**  `);
  L.push(`${r.score.counts.error} errors, ${r.score.counts.warning} warnings, ${r.score.counts.info} info. Found ${r.summary.operations} operations, ${r.summary.rpcs} rpcs, ${r.summary.tables} tables, ${r.summary.routes} routes.`, "");
  L.push("| Category | Score |", "|---|---|");
  for (const [k, v] of Object.entries(r.score.byCategory)) L.push(`| ${k} | ${v} |`);
  L.push("");
  const byRule = new Map<string, Finding[]>();
  for (const f of r.findings.filter(f => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[min])) (byRule.get(f.ruleId) ?? byRule.set(f.ruleId, []).get(f.ruleId)!).push(f);
  for (const [id, fs] of byRule) {
    const meta = r.rules.find(x => x.id === id);
    L.push(`## ${id}: ${meta?.title ?? ""} (${fs.length})`, "");
    if (meta) L.push(`*Why it matters:* ${meta.why}  `, `*Fix:* ${meta.fix}`, "");
    for (const f of fs.slice(0, 25)) L.push(`- **${f.severity}** \`${f.file ?? ""}${f.line ? ":" + f.line : ""}\`: ${f.message}${f.evidence ? ` (evidence: \`${f.evidence.replace(/`/g, "'")}\`)` : ""}`);
    if (fs.length > 25) L.push(`- …and ${fs.length - 25} more`);
    L.push("");
  }
  return L.join("\n");
}

export function toSarif(r: Report, version: string): object {
  const level = (s: Severity) => (s === "error" ? "error" : s === "warning" ? "warning" : "note");
  const used = new Set(r.findings.map(f => f.ruleId));
  const rules = r.rules.filter((m: RuleMeta) => used.has(m.id)).map((m: RuleMeta) => ({
    id: m.id, name: m.title, shortDescription: { text: m.title }, fullDescription: { text: m.why }, help: { text: m.fix }, defaultConfiguration: { level: level(m.severity) },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0",
    runs: [{
      tool: { driver: { name: "seamlens", version, informationUri: "https://github.com/vikasny30/seamlens", rules } },
      results: r.findings.map(f => ({
        ruleId: f.ruleId, level: level(f.severity), message: { text: f.message + (f.fix ? ` Fix: ${f.fix}` : "") },
        ...(f.file ? { locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: Math.max(1, f.line ?? 1) } } }] } : {}),
        properties: { confidence: f.confidence, evidence: f.evidence },
      })),
    }],
  };
}
