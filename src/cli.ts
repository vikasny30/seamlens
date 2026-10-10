#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyze } from "./index.js";
import { toText, toMarkdown, toSarif } from "./report.js";
import { SEVERITY_RANK, type Severity } from "./model.js";
import { catalog, ruleMeta } from "./rules/index.js";
import { diffRepo, diffToText, diffToMarkdown } from "./diff/index.js";
import { analyzeImpact, impactToText, impactToMarkdown } from "./impact/index.js";
import { analyzeOrg, orgToText } from "./org/index.js";
import { generateTasks, validateTasks, runBenchmark, summarizeRun, type BenchTask } from "./bench/index.js";
import { startServer } from "./web/server.js";

const VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `SeamLens ${VERSION}: see the seams of your system

Usage: seamlens <command> [path] [options]

Commands
  scan     Summary and contract-health score
  check    Findings. --format text|json|md|sarif  --severity info|warning|error  --fail-on error|warning|none (default error)
  diff     Breaking changes against a git ref.  --base <ref> (default HEAD~1)  --format text|json|md
  serve    Visual map in your browser (local only).  --port <n>
  impact   AI-coding-agent impact vs other work.  --since <days>  --format text|json|md
  org      Ownership, bus factor, cadence.  --since <days>  --github owner/repo  --names
  bench    generate | validate | run   (see "seamlens bench --help")
  rules    List rules, or explain one:  seamlens rules API003

Common options: --out <file>  --json  --help  --version
`;
const BENCH_HELP = `seamlens bench generate [path] [--limit 25] [--out tasks.json]
seamlens bench validate [path] --tasks tasks.json --test-cmd "npm test" [--link-node-modules] [--timeout 300] [--out validated.json]
seamlens bench run      [path] --tasks validated.json --test-cmd "npm test" --agent-cmd "<your agent command>" [--out results.json]

validate and run EXECUTE commands you provide, inside temporary git worktrees with a scrubbed environment and a timeout.
They are CLI-only by design (not available through the MCP server). Run untrusted agents in a container or VM.
The agent command receives the problem statement on stdin and SEAMLENS_TASK_FILE / SEAMLENS_WORKDIR in its environment.`;

type Flags = Record<string, string | boolean>;
function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [], flags: Flags = {};
  const BOOL = new Set(["json", "help", "version", "names", "link-node-modules", "open"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}
const str = (f: Flags, k: string, d?: string) => (typeof f[k] === "string" ? (f[k] as string) : d);
const num = (f: Flags, k: string) => { const v = Number(f[k]); return Number.isFinite(v) && v > 0 ? v : undefined; };
const out = (text: string, f: Flags) => { const file = str(f, "out"); if (file) { fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n"); console.error(`wrote ${file}`); } else console.log(text); };
const dirArg = (pos: string[]) => { const p = path.resolve(pos[0] ?? "."); if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`not a directory: ${p}`); return p; };

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos.shift();
  if (flags.version) return console.log(VERSION);
  if (!cmd || flags.help && !cmd) return console.log(HELP);
  const fmt = str(flags, "format", flags.json ? "json" : "text")!;

  switch (cmd) {
    case "scan": case "check": {
      const { report } = analyze(dirArg(pos));
      const min = (str(flags, "severity", "info") as Severity);
      if (cmd === "scan") { out(fmt === "json" ? JSON.stringify({ summary: report.summary, score: report.score }, null, 2) : toText({ ...report, findings: [] }), flags); return; }
      const shown = { ...report, findings: report.findings.filter(f => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[min]) };
      out(fmt === "json" ? JSON.stringify(shown, null, 2) : fmt === "md" ? toMarkdown(shown, min) : fmt === "sarif" ? JSON.stringify(toSarif(shown, VERSION), null, 2) : toText(shown, min), flags);
      const failOn = str(flags, "fail-on", "error")!;
      if (failOn !== "none" && report.findings.some(f => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn as Severity])) process.exitCode = 1;
      return;
    }
    case "diff": {
      const r = diffRepo(dirArg(pos), str(flags, "base", "HEAD~1")!);
      out(fmt === "json" ? JSON.stringify(r, null, 2) : fmt === "md" ? diffToMarkdown(r) : diffToText(r), flags);
      if (r.breaking > 0) process.exitCode = 1;
      return;
    }
    case "serve": {
      const root = dirArg(pos);
      const h = await startServer(root, { port: num(flags, "port") ?? 0 });
      console.log(`SeamLens is running at ${h.url}  (local only; press Ctrl+C to stop)`);
      if (flags.open) { const { execFile } = await import("node:child_process"); execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", process.platform === "win32" ? ["/c", "start", h.url] : [h.url]); }
      return;
    }
    case "impact": { const r = analyzeImpact(dirArg(pos), { sinceDays: num(flags, "since") }); out(fmt === "json" ? JSON.stringify(r, null, 2) : fmt === "md" ? impactToMarkdown(r) : impactToText(r), flags); return; }
    case "org": { const r = await analyzeOrg(dirArg(pos), { sinceDays: num(flags, "since"), names: !!flags.names, github: str(flags, "github") }); out(fmt === "json" ? JSON.stringify(r, null, 2) : orgToText(r), flags); return; }
    case "rules": {
      if (pos[0]) { const m = ruleMeta(pos[0]); if (!m) throw new Error(`unknown rule ${pos[0]}`); console.log(`${m.id}  ${m.title}  [${m.severity}, ${m.category}]\n\nWhy: ${m.why}\n\nFix: ${m.fix}`); return; }
      for (const m of catalog()) console.log(`${m.id.padEnd(7)} ${m.severity.padEnd(8)} ${m.title}`);
      return;
    }
    case "bench": {
      const sub = pos.shift();
      if (!sub || flags.help) return console.log(BENCH_HELP);
      const root = dirArg(pos);
      const read = (): BenchTask[] => { const f = str(flags, "tasks"); if (!f) throw new Error("--tasks <file> is required"); return JSON.parse(fs.readFileSync(f, "utf8")); };
      if (sub === "generate") { const t = generateTasks(root, { limit: num(flags, "limit") ?? 25 }); out(JSON.stringify(t, null, 2), flags); console.error(`${t.length} candidate task(s). Next: seamlens bench validate --tasks <file> --test-cmd "<your tests>"`); return; }
      const testCmd = str(flags, "test-cmd"); if (!testCmd) throw new Error("--test-cmd is required");
      const common = { testCmd, linkNodeModules: !!flags["link-node-modules"], timeoutMs: (num(flags, "timeout") ?? 300) * 1000, onProgress: (m: string) => console.error(m) };
      if (sub === "validate") {
        const v = await validateTasks(root, read(), common);
        const ok = v.filter(t => t.validated?.fail_before && t.validated.pass_after);
        out(JSON.stringify(v, null, 2), flags);
        console.error(`${ok.length} of ${v.length} task(s) are valid (fail before the fix, pass after).`);
        return;
      }
      if (sub === "run") {
        const agentCmd = str(flags, "agent-cmd"); if (!agentCmd) throw new Error("--agent-cmd is required");
        const rows = await runBenchmark(root, read(), { ...common, agentCmd });
        const s = summarizeRun(rows);
        out(JSON.stringify({ summary: s, results: rows }, null, 2), flags);
        console.error(`solved ${s.solved}/${s.tasks} (${s.solvedNarrowly} narrowly, ${s.solvedWithScopeCreep} with scope creep); mean scope-creep ratio ${s.meanScopeCreepRatio}`);
        return;
      }
      throw new Error(`unknown bench command "${sub}"`);
    }
    default: throw new Error(`unknown command "${cmd}". Run seamlens --help`);
  }
}
main().catch(e => { console.error(`seamlens: ${(e as Error).message}`); process.exit(2); });
