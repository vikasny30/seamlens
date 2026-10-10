import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateTasks, validateTasks, runBenchmark, summarizeRun, difficultyOf } from "../src/bench/index.js";
import { analyzeOrgGit, busFactorOf, githubMetrics } from "../src/org/index.js";

function mk(): { dir: string; sh: (...a: string[]) => string; commit: (msg: string, who?: string, day?: number) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-bench-"));
  const base = { ...process.env };
  const sh = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe", env: base });
  sh("init", "-q"); sh("config", "commit.gpgsign", "false");
  const commit = (msg: string, who = "Dev One", day = 0) => {
    const email = who.toLowerCase().replace(/\s+/g, ".") + "@x.io", date = `${1_700_000_000 + day * 86400} +0000`;
    sh("add", "-A");
    execFileSync("git", ["-C", dir, "-c", `user.name=${who}`, "-c", `user.email=${email}`, "commit", "-q", "-m", msg], { stdio: "pipe", env: { ...base, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  return { dir, sh, commit };
}

function benchRepo() {
  const r = mk();
  fs.mkdirSync(path.join(r.dir, "src")); fs.mkdirSync(path.join(r.dir, "test"));
  fs.writeFileSync(path.join(r.dir, "src/math.js"), "exports.abs = n => n;\nexports.sq = n => n * n;\n");
  fs.writeFileSync(path.join(r.dir, "README.md"), "# demo\n");
  r.commit("initial commit with math helpers");
  fs.writeFileSync(path.join(r.dir, "src/math.js"), "exports.abs = n => Math.abs(n);\nexports.sq = n => n * n;\n");
  fs.writeFileSync(path.join(r.dir, "test/abs.test.js"), "const { abs } = require('../src/math.js');\nconst assert = require('assert');\nassert.strictEqual(abs(-3), 3);\nconsole.log('ok');\n");
  r.commit("fix: abs() returned negative numbers unchanged\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
  return r;
}
const TEST_CMD = "node test/abs.test.js";

test("bench generate: finds the fix commit with a test, builds gold and test patches, difficulty", () => {
  const { dir } = benchRepo();
  try {
    const tasks = generateTasks(dir);
    assert.equal(tasks.length, 1);
    const t = tasks[0];
    assert.deepEqual(t.source_files, ["src/math.js"]);
    assert.deepEqual(t.test_files, ["test/abs.test.js"]);
    assert.match(t.problem_statement, /abs\(\) returned negative/);
    assert.ok(!/Co-Authored-By/i.test(t.problem_statement), "trailers are stripped from the statement");
    assert.ok(t.gold_patch.includes("Math.abs") && !t.gold_patch.includes("assert"));
    assert.ok(t.test_patch.includes("assert.strictEqual") && !t.test_patch.includes("Math.abs"));
    assert.ok(t.difficulty.score > 0 && ["easy", "medium", "hard"].includes(t.difficulty.bucket));
    assert.equal(t.difficulty.bucket, "easy");
    assert.notEqual(t.base_commit, t.fix_commit);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bench generate: skips commits without tests, merges, and oversized changes", () => {
  const r = mk();
  try {
    fs.mkdirSync(path.join(r.dir, "src"));
    fs.writeFileSync(path.join(r.dir, "src/a.js"), "a\n"); r.commit("initial");
    fs.writeFileSync(path.join(r.dir, "src/a.js"), "a\nb\nc\n"); r.commit("fix: handle the b case properly");      // no tests: skipped
    assert.equal(generateTasks(r.dir).length, 0);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  assert.ok(difficultyOf(["a/x.ts", "b/y.ts", "c/z.ts"], "@@\n@@\n@@\n@@\n@@\n", 500).bucket !== "easy");
});

test("bench validate: fail-before / pass-after is proven in an isolated worktree", async () => {
  const { dir } = benchRepo();
  try {
    const tasks = generateTasks(dir);
    const before = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
    const [v] = await validateTasks(dir, tasks, { testCmd: TEST_CMD });
    assert.equal(v.validated?.fail_before, true, JSON.stringify(v.validated));
    assert.equal(v.validated?.pass_after, true, JSON.stringify(v.validated));
    assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }), before, "main working tree untouched");
    assert.equal(execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length, 1, "temporary worktrees were removed");
    // a test command that always passes can never prove the fix
    const [bad] = await validateTasks(dir, tasks, { testCmd: "true" });
    assert.equal(bad.validated?.fail_before, false);
    assert.match(bad.validated?.note ?? "", /already pass/);
    // timeout kills the process group
    const [slow] = await validateTasks(dir, tasks, { testCmd: "sleep 30", timeoutMs: 400 });
    assert.match(slow.validated?.note ?? "", /timed out/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bench run: solved vs unsolved, hidden tests protected, scope creep measured", async () => {
  const { dir } = benchRepo();
  try {
    const validated = await validateTasks(dir, generateTasks(dir), { testCmd: TEST_CMD });
    const fixCmd = `node -e "const fs=require('fs');const f='src/math.js';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('abs = n => n','abs = n => Math.abs(n)'))"`;
    const [good] = await runBenchmark(dir, validated, { testCmd: TEST_CMD, agentCmd: fixCmd });
    assert.equal(good.solved, true, JSON.stringify(good));
    assert.equal(good.scopeCreepRatio, 0);
    assert.deepEqual(good.filesChanged, ["src/math.js"]);

    const [creepy] = await runBenchmark(dir, validated, { testCmd: TEST_CMD, agentCmd: `${fixCmd} && echo junk > unrelated.txt && echo x >> README.md` });
    assert.equal(creepy.solved, true);
    assert.equal(creepy.outsideGold.sort().join(","), "README.md,unrelated.txt");
    assert.equal(creepy.scopeCreepRatio, 0.67);

    const [idle] = await runBenchmark(dir, validated, { testCmd: TEST_CMD, agentCmd: "true" });
    assert.equal(idle.solved, false);

    // cheating: the agent rewrites the hidden test file; the edit must be discarded and the real test still decides
    const cheat = `${fixCmd.replace("abs = n => Math.abs(n)", "abs = n => n")} && mkdir -p test && echo "console.log('fake pass')" > test/abs.test.js`;
    const [cheater] = await runBenchmark(dir, validated, { testCmd: TEST_CMD, agentCmd: cheat });
    assert.equal(cheater.solved, false, "tampering with the tests must not count as a solve");

    const s = summarizeRun([good, creepy, idle, cheater]);
    assert.deepEqual([s.tasks, s.solved, s.solvedNarrowly, s.solvedWithScopeCreep], [4, 2, 1, 1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bench run: only validated tasks are run", async () => {
  const { dir } = benchRepo();
  try {
    const tasks = generateTasks(dir);       // not validated
    assert.deepEqual(await runBenchmark(dir, tasks, { testCmd: TEST_CMD, agentCmd: "true" }), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("org: bus factor, pseudonymised authors, hotspots, cadence", () => {
  assert.equal(busFactorOf([10]), 1);
  assert.equal(busFactorOf([6, 3, 1]), 1);
  assert.equal(busFactorOf([4, 3, 3]), 2);
  assert.equal(busFactorOf([]), 0);
  const r = mk();
  try {
    fs.mkdirSync(path.join(r.dir, "svc")); fs.mkdirSync(path.join(r.dir, "ui"));
    for (let i = 0; i < 24; i++) { fs.writeFileSync(path.join(r.dir, `svc/f${i % 3}.ts`), `v${i}\n`); r.commit(`svc ${i}`, "Alice Smith", i); }
    for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(r.dir, `ui/g${i % 2}.ts`), `v${i}\n`); r.commit(`ui ${i}`, i < 9 ? "Bob Jones" : "Cy Lee", 30 + i); }
    r.sh("tag", "v1"); fs.writeFileSync(path.join(r.dir, "ui/h.ts"), "x"); r.commit("later", "Bob Jones", 60); r.sh("tag", "v2");
    const rep = analyzeOrgGit(r.dir);
    assert.equal(rep.window.commits, 37);
    assert.ok(rep.authors.every(a => /^dev-[0-9a-f]{6}$/.test(a.id)), "pseudonyms by default");
    assert.ok(!JSON.stringify(rep).includes("Alice"));
    const named = analyzeOrgGit(r.dir, { names: true });
    assert.equal(named.authors[0].id, "Alice Smith");
    assert.equal(rep.busFactor.dirs.find(d => d.dir === "svc")!.busFactor, 1);
    assert.equal(rep.busFactor.dirs.find(d => d.dir === "svc")!.topShare, 1);
    assert.ok(rep.hotspots.length > 0 && rep.hotspots[0].commits >= 3);
    assert.equal(rep.cadence.weeks.length, 12);
    assert.equal(rep.releases.total, 2);
    assert.ok(rep.notes.length >= 2);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test("github metrics: repo argument is validated before anything runs", async () => {
  for (const bad of ["no-slash", "a/b; rm -rf /", "--repo=x/y", "a/b/c", "$(id)/x"]) await assert.rejects(() => githubMetrics(bad), /owner\/name/, bad);
});
