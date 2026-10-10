import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git } from "../diff/index.js";
import { readCommits, type Commit } from "../impact/git-log.js";
import { median, percentile } from "../impact/stats.js";

const execFileP = promisify(execFile);
const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$|(^|\/)(dist|build|vendor|node_modules)\//;
const DAY = 86400;

export interface OrgReport {
  window: { from: string; to: string; commits: number };
  authors: { id: string; commits: number; share: number }[];
  busFactor: { overall: number; dirs: { dir: string; commits: number; busFactor: number; topShare: number }[] };
  hotspots: { file: string; commits: number; lines: number }[];
  cadence: { weeks: { start: string; commits: number }[]; trend: "up" | "flat" | "down" };
  releases: { total: number; last?: string; medianGapDays?: number };
  github?: GithubMetrics | { error: string };
  notes: string[];
}
export interface GithubMetrics {
  repo: string; mergedPrs: number; openPrs: number;
  hoursToMerge: { median: number; p90: number }; hoursToFirstReview?: { median: number; p90: number };
  sizeLines: { median: number; p90: number };
  reviewLoad: { id: string; reviews: number }[];
  stale: { number: number; title: string; days: number }[];
}

const idOf = (c: Pick<Commit, "author" | "email">, names: boolean) => (names ? c.author : "dev-" + createHash("sha1").update(c.email.toLowerCase()).digest("hex").slice(0, 6));

/** Smallest set of authors whose commits cover at least half of the total. */
export function busFactorOf(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let acc = 0, n = 0;
  for (const c of [...counts].sort((a, b) => b - a)) { acc += c; n++; if (acc >= total / 2) break; }
  return n;
}

function monday(ts: number): number { const d = new Date(ts * 1000); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) / 1000; }

export function analyzeOrgGit(root: string, opts: { sinceDays?: number; names?: boolean } = {}): OrgReport {
  const names = !!opts.names;
  const all = readCommits(root, { sinceDays: opts.sinceDays }).filter(c => !/\[bot\]|dependabot|renovate/i.test(c.author + c.email));
  const maxTs = all.reduce((m, c) => Math.max(m, c.ts), 0), minTs = all.reduce((m, c) => Math.min(m, c.ts), maxTs);

  const byAuthor = new Map<string, number>();
  for (const c of all) byAuthor.set(idOf(c, names), (byAuthor.get(idOf(c, names)) ?? 0) + 1);
  const authors = [...byAuthor].map(([id, commits]) => ({ id, commits, share: commits / (all.length || 1) })).sort((a, b) => b.commits - a.commits).slice(0, 15);

  const dirs = new Map<string, Map<string, number>>();
  for (const c of all) {
    const touched = new Set(c.files.filter(f => !LOCK.test(f.path)).map(f => { const d = f.path.split("/").slice(0, -1); return d.length ? d.slice(0, 2).join("/") : "(root)"; }));
    for (const d of touched) { const m = dirs.get(d) ?? dirs.set(d, new Map()).get(d)!; const a = idOf(c, names); m.set(a, (m.get(a) ?? 0) + 1); }
  }
  const dirRows = [...dirs].map(([dir, m]) => { const counts = [...m.values()], total = counts.reduce((a, b) => a + b, 0); return { dir, commits: total, busFactor: busFactorOf(counts), topShare: Math.max(...counts) / total }; })
    .filter(d => d.commits >= 10).sort((a, b) => a.busFactor - b.busFactor || b.commits - a.commits).slice(0, 12);

  const recent = all.filter(c => c.ts >= maxTs - 90 * DAY);
  const file = new Map<string, { commits: number; lines: number }>();
  for (const c of recent) for (const f of c.files) { if (LOCK.test(f.path)) continue; const x = file.get(f.path) ?? file.set(f.path, { commits: 0, lines: 0 }).get(f.path)!; x.commits++; x.lines += f.added + f.deleted; }
  const hotspots = [...file].map(([f, v]) => ({ file: f, ...v })).filter(h => h.commits >= 3).sort((a, b) => b.commits * Math.log2(2 + b.lines) - a.commits * Math.log2(2 + a.lines)).slice(0, 10);

  const weeks: { start: string; commits: number }[] = [];
  const last = monday(maxTs || 0);
  for (let i = 11; i >= 0; i--) { const start = last - i * 7 * DAY; weeks.push({ start: new Date(start * 1000).toISOString().slice(0, 10), commits: all.filter(c => c.ts >= start && c.ts < start + 7 * DAY).length }); }
  const sum = (xs: typeof weeks) => xs.reduce((n, w) => n + w.commits, 0);
  const a = sum(weeks.slice(8)), b = sum(weeks.slice(4, 8));
  const trend: "up" | "flat" | "down" = b === 0 ? (a > 0 ? "up" : "flat") : a > b * 1.15 ? "up" : a < b * 0.85 ? "down" : "flat";

  let tags: number[] = [];
  try { tags = git(root, ["tag", "--sort=creatordate", "--format=%(creatordate:unix)"]).split("\n").filter(Boolean).map(Number).filter(Number.isFinite); } catch { /* no tags */ }
  const gaps = tags.slice(1).map((t, i) => (t - tags[i]) / DAY);

  const notes = ["Authors are shown as stable pseudonyms (dev-xxxxxx) unless --names is passed, so this report can be shared without becoming a people ranking.",
    "Bus factor here is the smallest set of authors covering half of a directory's commits. It measures concentration of knowledge, not individual performance."];
  if (all.length < 50) notes.push("Fewer than 50 commits in the window: concentration and trend numbers are fragile.");
  return {
    window: { from: all.length ? new Date(minTs * 1000).toISOString().slice(0, 10) : "", to: all.length ? new Date(maxTs * 1000).toISOString().slice(0, 10) : "", commits: all.length },
    authors, busFactor: { overall: busFactorOf([...byAuthor.values()]), dirs: dirRows }, hotspots, cadence: { weeks, trend },
    releases: { total: tags.length, last: tags.length ? new Date(tags[tags.length - 1] * 1000).toISOString().slice(0, 10) : undefined, medianGapDays: gaps.length ? Math.round(median(gaps) * 10) / 10 : undefined }, notes,
  };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const hours = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

/** Pull-request metrics through the user's own authenticated `gh` CLI. Read-only; the repo argument is validated and never passed to a shell. */
export async function githubMetrics(repo: string, names = false): Promise<GithubMetrics> {
  if (!REPO_RE.test(repo)) throw new Error("repo must look like owner/name");
  const gh = async (args: string[]) => (await execFileP("gh", args, { timeout: 60_000, maxBuffer: 50_000_000 })).stdout;
  const merged = JSON.parse(await gh(["pr", "list", "--repo", repo, "--state", "merged", "--limit", "200", "--json", "number,createdAt,mergedAt,additions,deletions,author,reviews"]));
  const open = JSON.parse(await gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,createdAt,updatedAt,author"]));
  const ttm = merged.filter((p: any) => p.mergedAt).map((p: any) => hours(p.createdAt, p.mergedAt));
  const ttr = merged.map((p: any) => { const t = (p.reviews ?? []).map((r: any) => r.submittedAt).filter(Boolean).sort()[0]; return t ? hours(p.createdAt, t) : null; }).filter((x: number | null): x is number => x !== null && x >= 0);
  const sizes = merged.map((p: any) => (p.additions ?? 0) + (p.deletions ?? 0));
  const load = new Map<string, number>();
  for (const p of merged) for (const r of p.reviews ?? []) { const login = r.author?.login; if (!login || login === p.author?.login) continue; const id = names ? login : "rev-" + createHash("sha1").update(login).digest("hex").slice(0, 6); load.set(id, (load.get(id) ?? 0) + 1); }
  const now = Date.now();
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    repo, mergedPrs: merged.length, openPrs: open.length,
    hoursToMerge: { median: r1(median(ttm)), p90: r1(percentile(ttm, 0.9)) },
    hoursToFirstReview: ttr.length ? { median: r1(median(ttr)), p90: r1(percentile(ttr, 0.9)) } : undefined,
    sizeLines: { median: Math.round(median(sizes)), p90: Math.round(percentile(sizes, 0.9)) },
    reviewLoad: [...load].map(([id, reviews]) => ({ id, reviews })).sort((a, b) => b.reviews - a.reviews).slice(0, 10),
    stale: open.map((p: any) => ({ number: p.number, title: String(p.title).slice(0, 80), days: Math.round((now - new Date(p.updatedAt).getTime()) / 86_400_000) })).filter((p: any) => p.days >= 14).sort((a: any, b: any) => b.days - a.days).slice(0, 10),
  };
}

export async function analyzeOrg(root: string, opts: { sinceDays?: number; names?: boolean; github?: string } = {}): Promise<OrgReport> {
  const r = analyzeOrgGit(root, opts);
  if (opts.github) { try { r.github = await githubMetrics(opts.github, opts.names); } catch (e) { r.github = { error: ((e as Error).message || "gh failed").split("\n")[0] }; } }
  return r;
}

export function orgToText(r: OrgReport): string {
  const L = [`SeamLens org: ${r.window.commits} commits, ${r.window.from} to ${r.window.to}`, `Overall bus factor: ${r.busFactor.overall}   Commit trend: ${r.cadence.trend}   Tags: ${r.releases.total}${r.releases.medianGapDays ? ` (median gap ${r.releases.medianGapDays} days)` : ""}`, ""];
  L.push("Authors:", ...r.authors.slice(0, 8).map(a => `  ${a.id}  ${a.commits} commits  ${(a.share * 100).toFixed(0)}%`), "");
  L.push("Knowledge concentration by area (lowest bus factor first):", ...r.busFactor.dirs.map(d => `  ${d.dir.padEnd(32)} bus factor ${d.busFactor}   top author ${(d.topShare * 100).toFixed(0)}%   ${d.commits} commits`), "");
  L.push("Hotspots (last 90 days):", ...r.hotspots.map(h => `  ${h.file}  ${h.commits} commits, ${h.lines} lines`), "");
  L.push("Weekly commits: " + r.cadence.weeks.map(w => w.commits).join(" "));
  if (r.github) {
    L.push("");
    if ("error" in r.github) L.push(`GitHub: ${r.github.error}`);
    else { const g = r.github; L.push(`GitHub ${g.repo}: ${g.mergedPrs} merged, ${g.openPrs} open. Time to merge median ${g.hoursToMerge.median}h (p90 ${g.hoursToMerge.p90}h). ${g.hoursToFirstReview ? `First review median ${g.hoursToFirstReview.median}h. ` : ""}PR size median ${g.sizeLines.median} lines.`); if (g.stale.length) L.push(`  Stale open PRs: ${g.stale.map(s => `#${s.number} (${s.days}d)`).join(", ")}`); }
  }
  L.push("", ...r.notes.map(n => `Note: ${n}`));
  return L.join("\n");
}
