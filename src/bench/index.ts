import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../diff/index.js";
import { readCommits, type Commit } from "../impact/git-log.js";
import { CODE_EXT, isTestFile } from "../scan/extract-code.js";

const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$|\.min\.(js|css)$|(^|\/)(dist|build|vendor|node_modules)\//;
const SAFE_PATH = /^[\w@.+\-/ ]+$/;
const FIXISH = /\b(fix(es|ed)?|bug|issue|resolve[sd]?|close[sd]?|regression|crash|error|fail(s|ed|ure)?|broken|wrong|incorrect|handle|support|add|implement)\b/i;

export interface Difficulty { files: number; hunks: number; lines: number; dirs: number; score: number; bucket: "easy" | "medium" | "hard" }
export interface BenchTask {
  id: string; repo: string; base_commit: string; fix_commit: string; problem_statement: string;
  source_files: string[]; test_files: string[]; gold_patch: string; test_patch: string;
  difficulty: Difficulty; languages: string[]; created_at: string;
  validated?: { fail_before: boolean; pass_after: boolean; seconds: number; note?: string };
}

const ext = (p: string) => p.slice(p.lastIndexOf("."));
function patchFor(root: string, base: string, head: string, files: string[]): string {
  if (!files.length) return "";
  return git(root, ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--binary", base, head, "--", ...files], 50_000_000);
}
const hunks = (p: string) => (p.match(/^@@ /gm) ?? []).length;

export function difficultyOf(files: string[], gold: string, linesChanged: number): Difficulty {
  const dirs = new Set(files.map(f => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".")));
  const h = hunks(gold);
  // Log-scaled lines dominate; files, hunks and directory spread add. 0..100.
  const score = Math.min(100, Math.round(12 * Math.log2(1 + linesChanged) + 5 * files.length + 3 * h + 6 * (dirs.size - 1)));
  return { files: files.length, hunks: h, lines: linesChanged, dirs: dirs.size, score, bucket: score < 35 ? "easy" : score < 60 ? "medium" : "hard" };
}

/** Find commits that fix or add behavior with tests, and package them as SWE-bench-style tasks (not yet validated). */
export function generateTasks(root: string, opts: { limit?: number; maxFiles?: number; maxLines?: number; sinceDays?: number } = {}): BenchTask[] {
  const maxFiles = opts.maxFiles ?? 8, maxLines = opts.maxLines ?? 300, limit = opts.limit ?? 25;
  let remote = path.basename(root);
  try { remote = git(root, ["config", "--get", "remote.origin.url"]).trim() || remote; } catch { /* no remote */ }
  const out: BenchTask[] = [];
  for (const c of readCommits(root, { sinceDays: opts.sinceDays, max: 3000 })) {
    if (out.length >= limit) break;
    if (c.parents.length !== 1) continue;
    const files = c.files.filter(f => !LOCK.test(f.path) && SAFE_PATH.test(f.path));
    if (files.length !== c.files.filter(f => !LOCK.test(f.path)).length) continue;      // a path we refuse to pass to git: skip the whole commit
    const src = files.filter(f => CODE_EXT.has(ext(f.path)) && !isTestFile(f.path)).map(f => f.path);
    const tests = files.filter(f => isTestFile(f.path)).map(f => f.path);
    const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
    if (!src.length || !tests.length || files.length > maxFiles || lines > maxLines || lines < 3) continue;
    if (files.length !== src.length + tests.length) continue;                            // mixed with docs/config: ambiguous gold patch
    if (!FIXISH.test(c.subject) || c.subject.length < 12) continue;
    const gold = patchFor(root, c.parents[0], c.sha, src), testPatch = patchFor(root, c.parents[0], c.sha, tests);
    if (!gold.trim() || !testPatch.trim() || /^Binary files|GIT binary patch/m.test(gold + testPatch)) continue;
    const body = c.body.split("\n").filter(l => !/^(co-authored-by|signed-off-by|generated with|🤖)/i.test(l.trim())).join("\n").trim();
    out.push({
      id: `${path.basename(root)}__${c.sha.slice(0, 8)}`, repo: remote, base_commit: c.parents[0], fix_commit: c.sha,
      problem_statement: `${c.subject}${body ? "\n\n" + body : ""}`, source_files: src, test_files: tests, gold_patch: gold, test_patch: testPatch,
      difficulty: difficultyOf(src, gold, files.filter(f => src.includes(f.path)).reduce((n, f) => n + f.added + f.deleted, 0)), languages: [...new Set(src.map(ext))], created_at: new Date(c.ts * 1000).toISOString(),
    });
  }
  return out;
}

// ---- running user commands (validate / run). CLI only; never exposed through MCP. -----------------------------------

interface RunResult { code: number | null; seconds: number; tail: string; timedOut: boolean }

/** Run a command string with a scrubbed environment, a timeout, and process-group kill. */
function sh(cmd: string, cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}, stdin?: string): Promise<RunResult> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir(), TMPDIR: os.tmpdir(), CI: "1", LANG: "C.UTF-8", ...extraEnv };
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", timedOut = false;
    const take = (d: Buffer) => { buf += d.toString(); if (buf.length > 40_000) buf = buf.slice(-20_000); };
    child.stdout.on("data", take); child.stderr.on("data", take);
    // An agent that exits without reading its input closes the pipe; the resulting EPIPE must not crash the harness.
    child.stdin.on("error", () => {}); child.stdout.on("error", () => {}); child.stderr.on("error", () => {});
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    const killer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.on("close", code => { clearTimeout(killer); resolve({ code, seconds: Math.round((Date.now() - t0) / 100) / 10, tail: buf.slice(-1500), timedOut }); });
    child.on("error", e => { clearTimeout(killer); resolve({ code: 127, seconds: 0, tail: String(e), timedOut: false }); });
  });
}

function worktree(root: string, commit: string, linkNodeModules: boolean): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-wt-"));
  git(root, ["worktree", "add", "--detach", "--quiet", dir, commit]);
  if (linkNodeModules && fs.existsSync(path.join(root, "node_modules"))) { try { fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir"); } catch { /* ignore */ } }
  return { dir, cleanup: () => { try { git(root, ["worktree", "remove", "--force", dir]); } catch { fs.rmSync(dir, { recursive: true, force: true }); } } };
}
const apply = (dir: string, patch: string) => { execFileSync("git", ["-C", dir, "apply", "--whitespace=nowarn", "--binary", "-"], { input: patch, stdio: ["pipe", "pipe", "pipe"] }); };

export interface ValidateOptions { testCmd: string; timeoutMs?: number; linkNodeModules?: boolean; onProgress?: (msg: string) => void }

/** A task is valid when its tests FAIL on the base commit with the test patch applied and PASS once the gold patch is applied. */
export async function validateTasks(root: string, tasks: BenchTask[], opts: ValidateOptions): Promise<BenchTask[]> {
  const out: BenchTask[] = [];
  for (const t of tasks) {
    opts.onProgress?.(`validating ${t.id}`);
    const wt = worktree(root, t.base_commit, !!opts.linkNodeModules);
    try {
      apply(wt.dir, t.test_patch);
      const before = await sh(opts.testCmd, wt.dir, opts.timeoutMs ?? 300_000);
      apply(wt.dir, t.gold_patch);
      const after = await sh(opts.testCmd, wt.dir, opts.timeoutMs ?? 300_000);
      const failBefore = before.code !== 0 && !before.timedOut, passAfter = after.code === 0;
      const v = { fail_before: failBefore, pass_after: passAfter, seconds: Math.round((before.seconds + after.seconds) * 10) / 10, note: failBefore && passAfter ? undefined : before.timedOut || after.timedOut ? "timed out" : !failBefore ? "tests already pass without the fix" : "tests still fail with the fix" };
      out.push({ ...t, validated: v });
    } catch (e) { out.push({ ...t, validated: { fail_before: false, pass_after: false, seconds: 0, note: `could not apply patches: ${((e as Error).message || "").split("\n")[0].slice(0, 120)}` } }); }
    finally { wt.cleanup(); }
  }
  return out;
}

export interface RunOptions extends ValidateOptions { agentCmd: string; agentTimeoutMs?: number }
export interface RunResultRow { id: string; solved: boolean; seconds: number; filesChanged: string[]; outsideGold: string[]; scopeCreepRatio: number; note?: string }

/**
 * Give each validated task to an agent command. The agent sees only the problem statement and the base checkout, never the tests.
 * Afterwards: any edit the agent made to the hidden test files is discarded, the real test patch is applied, and the tests run.
 * Scope-creep ratio = share of the agent's (non-test) changed files that are not files the gold patch touched.
 */
export async function runBenchmark(root: string, tasks: BenchTask[], opts: RunOptions): Promise<RunResultRow[]> {
  const rows: RunResultRow[] = [];
  for (const t of tasks.filter(x => x.validated?.fail_before && x.validated.pass_after)) {
    opts.onProgress?.(`running agent on ${t.id}`);
    const wt = worktree(root, t.base_commit, !!opts.linkNodeModules);
    const taskFile = path.join(os.tmpdir(), `seamlens-task-${process.pid}-${t.id}.json`);
    try {
      fs.writeFileSync(taskFile, JSON.stringify({ id: t.id, problem_statement: t.problem_statement }), { mode: 0o600 });
      const t0 = Date.now();
      const agent = await sh(opts.agentCmd, wt.dir, opts.agentTimeoutMs ?? 1_200_000, { SEAMLENS_TASK_FILE: taskFile, SEAMLENS_WORKDIR: wt.dir }, t.problem_statement);
      const g = (...a: string[]) => execFileSync("git", ["-C", wt.dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      g("add", "-A");
      const tests = new Set(t.test_files);
      const changed = g("diff", "--cached", "--name-only").split("\n").filter(Boolean).filter(f => !tests.has(f));
      const outside = changed.filter(f => !t.source_files.includes(f));
      // neutralise any agent edits to the hidden tests (restore from the base commit, or delete if the file did not exist)
      for (const f of t.test_files) {
        try { g("checkout", "HEAD", "--", f); } catch { try { g("rm", "-f", "--cached", "-q", "--", f); } catch { /* not tracked */ } fs.rmSync(path.join(wt.dir, f), { force: true }); }
      }
      let note: string | undefined = agent.timedOut ? "agent timed out" : undefined;
      let solved = false;
      try {
        apply(wt.dir, t.test_patch);
        const res = await sh(opts.testCmd, wt.dir, opts.timeoutMs ?? 300_000);
        solved = res.code === 0 && !res.timedOut;
        if (res.timedOut) note = "tests timed out";
      } catch (e) { note = `test patch did not apply: ${((e as Error).message || "").split("\n")[0].slice(0, 100)}`; }
      rows.push({ id: t.id, solved, seconds: Math.round((Date.now() - t0) / 100) / 10, filesChanged: changed, outsideGold: outside, scopeCreepRatio: changed.length ? Math.round((outside.length / changed.length) * 100) / 100 : 0, note });
    } catch (e) { rows.push({ id: t.id, solved: false, seconds: 0, filesChanged: [], outsideGold: [], scopeCreepRatio: 0, note: `error: ${((e as Error).message || "").split("\n")[0].slice(0, 120)}` }); }
    finally { fs.rmSync(taskFile, { force: true }); wt.cleanup(); }
  }
  return rows;
}

export function summarizeRun(rows: RunResultRow[]) {
  const n = rows.length, solved = rows.filter(r => r.solved).length;
  const narrow = rows.filter(r => r.solved && r.scopeCreepRatio === 0).length;
  const mean = n ? rows.reduce((a, r) => a + r.scopeCreepRatio, 0) / n : 0;
  return { tasks: n, solved, solvedNarrowly: narrow, solvedWithScopeCreep: solved - narrow, meanScopeCreepRatio: Math.round(mean * 100) / 100 };
}
