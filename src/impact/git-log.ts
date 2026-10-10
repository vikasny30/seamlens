import { git } from "../diff/index.js";

export interface FileChange { path: string; added: number; deleted: number }
export interface Commit { sha: string; parents: string[]; author: string; email: string; ts: number; subject: string; body: string; files: FileChange[] }

/** Read non-merge commits with numstat. `since` is a number of days. Uses a record separator so bodies can contain anything. */
export function readCommits(root: string, opts: { sinceDays?: number; max?: number } = {}): Commit[] {
  const args = ["log", "--no-merges", "--no-renames", "--numstat", "--date=unix", `--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1f`, `-n`, String(Math.min(opts.max ?? 5000, 50000))];
  if (opts.sinceDays && Number.isFinite(opts.sinceDays) && opts.sinceDays > 0) args.splice(1, 0, `--since=${Math.floor(opts.sinceDays)}.days.ago`);
  let raw: string;
  try { raw = git(root, args, 200_000_000); } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    if (/not a git repository/i.test(msg)) throw new Error("Not a git repository: this analysis needs git history");
    if (/does not have any commits yet|bad default revision|unknown revision/i.test(msg)) throw new Error("This repository has no commits yet, so there is no history to analyse");
    throw new Error("Could not read git history: " + msg.split("\n").find(l => l.trim()) );
  }
  const out: Commit[] = [];
  for (const rec of raw.split("\x1e")) {
    if (!rec.trim()) continue;
    const f = rec.split("\x1f");
    if (f.length < 8) continue;
    const files: FileChange[] = [];
    for (const line of f[7].split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) files.push({ path: m[3], added: m[1] === "-" ? 0 : +m[1], deleted: m[2] === "-" ? 0 : +m[2] });
    }
    out.push({ sha: f[0], parents: f[1].split(" ").filter(Boolean), author: f[2], email: f[3], ts: +f[4], subject: f[5], body: f[6], files });
  }
  return out;
}
