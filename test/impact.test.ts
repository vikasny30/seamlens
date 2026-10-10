import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { wilson, percentile, median, rate } from "../src/impact/stats.js";
import { classify, compilePatterns } from "../src/impact/attribution.js";
import { analyzeImpact, analyzeCommits, impactToText, impactToMarkdown } from "../src/impact/index.js";
import type { Commit } from "../src/impact/git-log.js";

const near = (a: number, b: number, eps = 0.002) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("wilson interval matches known values", () => {
  const [l0, h0] = wilson(0, 10); near(l0, 0); near(h0, 0.2775);
  const [l5, h5] = wilson(5, 10); near(l5, 0.2366); near(h5, 0.7634);
  const [l50, h50] = wilson(50, 100); near(l50, 0.4038); near(h50, 0.5962);
  const [l10, h10] = wilson(10, 10); near(l10, 0.7225); near(h10, 1);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const r = rate(3, 12); assert.equal(r.rate, 0.25); assert.ok(r.lo < 0.25 && r.hi > 0.25);
});

test("percentile and median", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 4.6);
});

const commit = (over: Partial<Commit>): Commit => ({ sha: "a".repeat(40), parents: ["b"], author: "Dev", email: "dev@x.io", ts: 0, subject: "work", body: "", files: [], ...over });

test("attribution: trailers and generated-with lines count; mentions in the subject do not", () => {
  assert.equal(classify(commit({ body: "Add thing\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>" })), "agent");
  assert.equal(classify(commit({ body: "🤖 Generated with [Claude Code](https://claude.com/claude-code)" })), "agent");
  assert.equal(classify(commit({ body: "Co-authored-by: Copilot <copilot@github.com>" })), "agent");
  assert.equal(classify(commit({ subject: "aider: refactor parser" })), "agent");
  assert.equal(classify(commit({ email: "bot@anthropic.com" })), "agent");
  assert.equal(classify(commit({ subject: "update claude config docs", body: "documents how Claude Code is configured" })), "other", "a mere mention is not attribution");
  assert.equal(classify(commit({ body: "Co-authored-by: Jane Doe <jane@x.io>" })), "other");
  assert.equal(classify(commit({ author: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" })), "bot");
  assert.equal(classify(commit({ body: "pair: ai-pairing-session" }), compilePatterns(["ai-pairing"])), "agent");
  assert.deepEqual(compilePatterns(["(unclosed", "ok"]).length, 1, "invalid user regexes are ignored");
});

const DAY = 86400;
function build(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-impact-"));
  const sh = (env: Record<string, string>, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...process.env, ...env } });
  sh({}, "init", "-q"); sh({}, "config", "user.email", "t@t.t"); sh({}, "config", "user.name", "t"); sh({}, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "src")); fs.mkdirSync(path.join(dir, "test"));
  const t0 = 1_700_000_000;
  let n = 0;
  const make = (day: number, msg: string, files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
    const date = `${t0 + day * DAY} +0000`;
    sh({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "add", "-A");
    sh({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "commit", "-q", "-m", msg);
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  // 40 other commits (all touch tests), then 40 agent commits (none touch tests), spread over 160 days, plus one fix, one revert
  for (let i = 0; i < 40; i++) make(i * 2, `feat: other ${i}`, { [`src/o${i}.ts`]: `export const o${i} = ${i};\n`, [`test/o${i}.test.ts`]: `// t${i}\n` });
  let revertTarget = "";
  for (let i = 0; i < 40; i++) {
    const sha = make(i * 2 + 1, `feat: agent ${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`, { [`src/a${i}.ts`]: `export const a${i} = ${i};\n` });
    if (i === 3) revertTarget = sha;
  }
  void revertTarget;
  return dir;
}

test("impact: scripted history gives the expected cohorts, rates and verdicts", () => {
  const dir = build();
  try {
    // add a fix commit that touches an agent file within 7 days of its creation (agent commit #3 is at day 7)
    const t0 = 1_700_000_000;
    const sh = (date: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    fs.writeFileSync(path.join(dir, "src/a3.ts"), "export const a3 = 33;\n");
    sh(`${t0 + 8 * DAY} +0000`, "add", "-A"); sh(`${t0 + 8 * DAY} +0000`, "commit", "-q", "-m", "fix: a3 off by one");
    const target = execFileSync("git", ["-C", dir, "log", "--format=%H", "--grep=feat: agent 5$", "-n", "1"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(dir, "src/a5.ts"), "export const a5 = 0;\n");
    sh(`${t0 + 100 * DAY} +0000`, "add", "-A"); sh(`${t0 + 100 * DAY} +0000`, "commit", "-q", "-m", `Revert "feat: agent 5"\n\nThis reverts commit ${target}.`);

    const r = analyzeImpact(dir);
    assert.equal(r.cohorts.agent.commits, 40);
    assert.equal(r.cohorts.other.commits, 40 + 2, "40 feature commits plus the fix and the revert are unattributed");
    assert.equal(r.cohorts.bot, 0);
    assert.equal(r.cohorts.agent.testTouch.k, 0);
    assert.equal(r.cohorts.agent.testTouch.n, 40);
    assert.equal(r.cohorts.other.testTouch.k, 40);
    const byMetric = Object.fromEntries(r.comparison.map(c => [c.metric, c]));
    assert.equal(byMetric["Test-touch rate"].verdict, "agent-assisted is worse");
    assert.equal(r.cohorts.agent.reverted.k, 1, "commit 5 was reverted");
    assert.equal(r.cohorts.agent.fixFollowUp.k, 1, "commit 3 was followed by a fix on its file within a week");
    assert.equal(byMetric["Later reverted"].verdict, "no detectable difference", "1/40 vs 0/42 overlaps");
    assert.ok(impactToText(r).includes("Read this with care"));
    assert.ok(impactToMarkdown(r).includes("| Metric |"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("impact: small cohorts are never given a verdict", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-small-"));
  try {
    const sh = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
    sh("init", "-q"); sh("config", "user.email", "t@t.t"); sh("config", "user.name", "t"); sh("config", "commit.gpgsign", "false");
    for (let i = 0; i < 5; i++) { fs.writeFileSync(path.join(dir, `f${i}.ts`), "x"); sh("add", "-A"); sh("commit", "-q", "-m", i % 2 ? "feat\n\nCo-Authored-By: Claude <noreply@anthropic.com>" : "feat"); }
    const r = analyzeImpact(dir);
    assert.ok(r.comparison.every(c => c.verdict === "insufficient data"));
    const none = (() => { const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-none-")); const s2 = (...a: string[]) => execFileSync("git", ["-C", d2, ...a], { stdio: "pipe" }); s2("init", "-q"); s2("config", "user.email", "t@t.t"); s2("config", "user.name", "t"); s2("config", "commit.gpgsign", "false"); fs.writeFileSync(path.join(d2, "a.ts"), "x"); s2("add", "-A"); s2("commit", "-q", "-m", "one"); const out = analyzeImpact(d2); fs.rmSync(d2, { recursive: true, force: true }); return out; })();
    assert.match(none.caveats[0], /No agent-attributed commits/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- size confounding: the lesson from running this on real open-source history ------------------------------------------
const SIZES: Record<string, number> = { small: 5, mid: 30, large: 100, xl: 300 };   // + 5 test lines when a test is touched, so each stays inside its band
let counter = 0;
function synth(cohort: "agent" | "other", band: keyof typeof SIZES, n: number, testRate: number): Commit[] {
  const out: Commit[] = [];
  for (let i = 0; i < n; i++) {
    const withTest = i < Math.round(n * testRate);
    counter++;
    out.push({
      sha: counter.toString(16).padStart(40, "0"), parents: ["p"], author: "Dev", email: `dev${counter % 7}@x.io`, ts: 1_700_000_000 + counter * 3600,
      subject: `change ${counter}`, body: cohort === "agent" ? "Co-Authored-By: Claude <noreply@anthropic.com>" : "",
      files: [{ path: `src/mod${counter % 13}.ts`, added: SIZES[band], deleted: 0 }, ...(withTest ? [{ path: `test/mod${counter % 13}.test.ts`, added: 5, deleted: 0 }] : [])],
    });
  }
  return out;
}
const TOUCH = { small: 0.1, mid: 0.4, large: 0.7, xl: 0.8 };

test("size confounding: a gap that commit size explains is flagged, not reported as an agent effect", () => {
  // identical test-touch behaviour inside every size band; agents just write bigger commits
  const commits = [
    ...synth("other", "small", 400, TOUCH.small), ...synth("other", "mid", 100, TOUCH.mid), ...synth("other", "large", 60, TOUCH.large), ...synth("other", "xl", 40, TOUCH.xl),
    ...synth("agent", "small", 40, TOUCH.small), ...synth("agent", "mid", 60, TOUCH.mid), ...synth("agent", "large", 100, TOUCH.large), ...synth("agent", "xl", 100, TOUCH.xl),
  ];
  const r = analyzeCommits(commits);
  const t = r.comparison.find(c => c.metric === "Test-touch rate")!;
  assert.equal(t.verdict, "agent-assisted is better", "the pooled comparison is fooled by size");
  assert.match(t.sizeAdjusted ?? "", /may be explained by commit size/, t.sizeAdjusted);
  assert.equal(r.stratified.length, 4);
  for (const st of r.stratified) assert.equal(st.comparison[0].verdict, "no detectable difference", st.band);
  assert.match(impactToText(r), /size-adjusted: no size band shows a detectable difference/);
  assert.match(impactToMarkdown(r), /Size-adjusted reading/);
});

test("size confounding: a genuine effect that holds in every band is reported as holding", () => {
  const commits: Commit[] = [];
  for (const band of ["small", "mid", "large", "xl"] as const) commits.push(...synth("other", band, 80, 0.3), ...synth("agent", band, 80, 0.9));
  const t = analyzeCommits(commits).comparison.find(c => c.metric === "Test-touch rate")!;
  assert.equal(t.verdict, "agent-assisted is better");
  assert.match(t.sizeAdjusted ?? "", /holds in 4 of 4 size bands/);
});

test("size confounding: bands with too few commits are not over-interpreted", () => {
  const commits = [...synth("other", "small", 200, 0.1), ...synth("agent", "small", 40, 0.9), ...synth("other", "xl", 10, 0.5), ...synth("agent", "xl", 10, 0.5)];
  const r = analyzeCommits(commits);
  const xl = r.stratified.find(s => s.band === "201+ lines")!;
  assert.equal(xl.comparison[0].verdict, "insufficient data");
  const t = r.comparison.find(c => c.metric === "Test-touch rate")!;
  assert.match(t.sizeAdjusted ?? "", /not enough commits in each size band|holds in/);
});
