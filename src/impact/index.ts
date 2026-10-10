import { isTestFile, CODE_EXT } from "../scan/extract-code.js";
import { loadConfig } from "../scan/index.js";
import { readCommits, type Commit } from "./git-log.js";
import { classify, compilePatterns, type Cohort } from "./attribution.js";
import { median, percentile, rate, type Rate } from "./stats.js";

const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|bun\.lockb)$|\.min\.(js|css)$|(^|\/)(dist|build|vendor|node_modules)\//;
const FIX = /\b(fix(es|ed)?|bug|regression|hotfix|patch|revert)\b/i;
const MIN_N = 30;

export interface CohortMetrics {
  commits: number;
  medianLines: number; p90Lines: number; medianFiles: number;
  testTouch: Rate;     // of commits that change source: also change tests (higher is better)
  reverted: Rate;      // of eligible commits: later reverted (lower is better)
  fixFollowUp: Rate;   // of eligible non-fix commits: a fix touches the same files within 7 days (lower is better)
  rework: Rate;        // of eligible commits: a different commit touches the same files within 14 days (lower is better)
}
export type Verdict = "insufficient data" | "no detectable difference" | "agent-assisted is better" | "agent-assisted is worse";
export interface Comparison { metric: string; better: "higher" | "lower"; agent: Rate; other: Rate; verdict: Verdict }
export interface ImpactReport {
  window: { sinceDays?: number; from: string; to: string; commits: number };
  cohorts: { agent: CohortMetrics; other: CohortMetrics; bot: number };
  comparison: Comparison[];
  caveats: string[];
}

const significant = (c: Commit) => c.files.filter(f => !LOCK.test(f.path));
const isSource = (p: string) => CODE_EXT.has(p.slice(p.lastIndexOf("."))) && !isTestFile(p);
const lines = (c: Commit) => significant(c).reduce((n, f) => n + f.added + f.deleted, 0);

function verdict(a: Rate, o: Rate, better: "higher" | "lower"): Verdict {
  if (a.n < MIN_N || o.n < MIN_N) return "insufficient data";
  if (a.hi >= o.lo && o.hi >= a.lo) return "no detectable difference";
  const agentHigher = a.rate > o.rate;
  return agentHigher === (better === "higher") ? "agent-assisted is better" : "agent-assisted is worse";
}

export function analyzeImpact(root: string, opts: { sinceDays?: number; max?: number } = {}): ImpactReport {
  const cfg = loadConfig(root);
  const extra = compilePatterns(cfg.agentPatterns);
  const all = readCommits(root, opts).sort((a, b) => a.ts - b.ts);   // oldest first
  const cohortOf = new Map<string, Cohort>(all.map(c => [c.sha, classify(c, extra)]));
  const maxTs = all.length ? all[all.length - 1].ts : 0;

  // later reverts → mark the originals
  const reverted = new Set<string>();
  const bySubject = new Map<string, Commit>();
  for (const c of all) {
    for (const m of c.body.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) { const t = all.find(x => x.sha.startsWith(m[1])); if (t) reverted.add(t.sha); }
    const rv = /^Revert "(.+)"$/.exec(c.subject);
    if (rv && bySubject.has(rv[1])) reverted.add(bySubject.get(rv[1])!.sha);
    bySubject.set(c.subject, c);
  }

  // per-file timeline for fix follow-up and rework
  const touches = new Map<string, Commit[]>();
  for (const c of all) for (const f of significant(c)) (touches.get(f.path) ?? touches.set(f.path, []).get(f.path)!).push(c);
  const DAY = 86400;
  const fixedAfter = new Set<string>();
  for (const fx of all.filter(c => FIX.test(c.subject))) for (const f of significant(fx)) {
    for (const prev of touches.get(f.path) ?? []) if (prev.ts < fx.ts && fx.ts - prev.ts <= 7 * DAY && !FIX.test(prev.subject)) fixedAfter.add(prev.sha);
  }
  const reworked = new Set<string>();
  for (const c of all) for (const f of significant(c)) {
    for (const later of touches.get(f.path) ?? []) if (later.ts > c.ts && later.ts - c.ts <= 14 * DAY && later.sha !== c.sha) { reworked.add(c.sha); break; }
  }

  const metrics = (cohort: Cohort): CohortMetrics => {
    const cs = all.filter(c => cohortOf.get(c.sha) === cohort);
    const sizes = cs.map(lines).filter(n => n > 0);
    const eligible = (days: number) => cs.filter(c => c.ts <= maxTs - days * DAY && significant(c).length > 0);
    const src = cs.filter(c => significant(c).some(f => isSource(f.path)));
    const e14 = eligible(14), e7 = eligible(7).filter(c => !FIX.test(c.subject));
    return {
      commits: cs.length, medianLines: Math.round(median(sizes)), p90Lines: Math.round(percentile(sizes, 0.9)), medianFiles: median(cs.map(c => significant(c).length).filter(n => n > 0)),
      testTouch: rate(src.filter(c => significant(c).some(f => isTestFile(f.path))).length, src.length),
      reverted: rate(e14.filter(c => reverted.has(c.sha)).length, e14.length),
      fixFollowUp: rate(e7.filter(c => fixedAfter.has(c.sha)).length, e7.length),
      rework: rate(e14.filter(c => reworked.has(c.sha)).length, e14.length),
    };
  };
  const agent = metrics("agent"), other = metrics("other");
  const cmp = (metric: string, key: "testTouch" | "reverted" | "fixFollowUp" | "rework", better: "higher" | "lower"): Comparison =>
    ({ metric, better, agent: agent[key], other: other[key], verdict: verdict(agent[key], other[key], better) });

  const caveats = [
    "Agent attribution comes from commit metadata (Co-authored-by and similar trailers, \"Generated with\" lines, agent author e-mails). It is a lower bound: unmarked agent work is counted as \"other\", which biases results toward no difference.",
    `Rates are shown with 95% Wilson confidence intervals. A comparison needs at least ${MIN_N} commits in each cohort, and intervals must not overlap, before this report calls one side better or worse.`,
    "Commits from the last 14 days are excluded from revert, fix-follow-up and rework rates, because their outcome is not known yet.",
    "Squash merges hide who wrote what; commit size is not value; fix-follow-up and rework are proxies, not measured defects. This report never ranks people.",
  ];
  if (agent.commits === 0) caveats.unshift("No agent-attributed commits were found. Add a `Co-authored-by` trailer (Claude Code does this by default) or set `agentPatterns` in .seamlens.json.");
  return {
    window: { sinceDays: opts.sinceDays, from: all.length ? new Date(all[0].ts * 1000).toISOString().slice(0, 10) : "", to: all.length ? new Date(maxTs * 1000).toISOString().slice(0, 10) : "", commits: all.length },
    cohorts: { agent, other, bot: all.filter(c => cohortOf.get(c.sha) === "bot").length },
    comparison: [cmp("Test-touch rate", "testTouch", "higher"), cmp("Later reverted", "reverted", "lower"), cmp("Fix follow-up within 7 days", "fixFollowUp", "lower"), cmp("Rework within 14 days", "rework", "lower")],
    caveats,
  };
}

const pct = (r: Rate) => `${(r.rate * 100).toFixed(1)}% (${r.k}/${r.n}, 95% CI ${(r.lo * 100).toFixed(0)}-${(r.hi * 100).toFixed(0)}%)`;

export function impactToText(r: ImpactReport): string {
  const L = [`SeamLens impact: ${r.window.commits} commits, ${r.window.from} to ${r.window.to}`, `Agent-assisted: ${r.cohorts.agent.commits}   Other: ${r.cohorts.other.commits}   Bots (excluded): ${r.cohorts.bot}`, ""];
  L.push(`Median lines changed: agent ${r.cohorts.agent.medianLines}, other ${r.cohorts.other.medianLines}   (p90: ${r.cohorts.agent.p90Lines} vs ${r.cohorts.other.p90Lines})`);
  L.push(`Median files per commit: agent ${r.cohorts.agent.medianFiles}, other ${r.cohorts.other.medianFiles}`, "");
  for (const c of r.comparison) { L.push(`${c.metric} (${c.better} is better)`, `  agent: ${pct(c.agent)}`, `  other: ${pct(c.other)}`, `  => ${c.verdict}`, ""); }
  L.push("Read this with care:", ...r.caveats.map(c => `  - ${c}`));
  return L.join("\n");
}

export function impactToMarkdown(r: ImpactReport): string {
  const L = [`# Agent impact report`, "", `${r.window.commits} non-merge commits from ${r.window.from} to ${r.window.to}. Agent-assisted: **${r.cohorts.agent.commits}**, other: **${r.cohorts.other.commits}**, bots excluded: ${r.cohorts.bot}.`, ""];
  L.push("| Metric | Agent-assisted | Other | Reading |", "|---|---|---|---|");
  for (const c of r.comparison) L.push(`| ${c.metric} (${c.better} is better) | ${pct(c.agent)} | ${pct(c.other)} | ${c.verdict} |`);
  L.push("", `Median lines changed: ${r.cohorts.agent.medianLines} (agent) vs ${r.cohorts.other.medianLines} (other).`, "", "## How to read this", ...r.caveats.map(c => `- ${c}`));
  return L.join("\n");
}
