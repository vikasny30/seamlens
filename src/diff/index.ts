import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OaDoc, ProtoFile } from "../model.js";
import { looksLikeOpenApi, loadOpenApi } from "../scan/extract-openapi.js";
import { parseProto } from "../scan/extract-proto.js";
import { scanRepo } from "../scan/index.js";
import { diffOpenApi } from "./openapi-diff.js";
import { diffProto } from "./proto-diff.js";
import { LEVEL_RANK, type Change } from "./types.js";

export { diffOpenApi, diffProto };
export type { Change };

const SAFE_REF = /^[A-Za-z0-9][\w./@^~-]{0,200}$/;

export function git(root: string, args: string[], maxBuffer = 20_000_000): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" } });
}

export interface DiffResult { base: string; changes: Change[]; breaking: number; potentially: number; safe: number; filesCompared: string[]; errors: string[] }

/** Compare every contract file at `baseRef` with the working tree. Reads old versions with `git show`; never checks anything out. */
export function diffRepo(rootIn: string, baseRef: string): DiffResult {
  if (!SAFE_REF.test(baseRef)) throw new Error(`"${baseRef}" is not a valid git ref`);
  const root = fs.realpathSync(rootIn);
  const errors: string[] = [];
  let top: string;
  try { top = git(root, ["rev-parse", "--show-toplevel"]).trim(); } catch { throw new Error("Not a git repository; the diff needs history to compare against"); }
  try { git(root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]); } catch { throw new Error(`Cannot resolve git ref "${baseRef}"`); }
  const prefix = path.relative(top, root).split(path.sep).join("/");
  const inScope = (p: string) => !prefix || p.startsWith(prefix + "/");
  const rel = (p: string) => (prefix ? p.slice(prefix.length + 1) : p);

  const names = git(root, ["ls-tree", "-r", "--name-only", baseRef]).split("\n").filter(Boolean)
    .filter(p => inScope(p) && /\.(ya?ml|json|proto)$/.test(p) && !/(^|\/)(node_modules|dist|build|vendor)\//.test(p));
  const baseOa: OaDoc[] = [], baseProto: ProtoFile[] = [];
  for (const p of names) {
    let text: string;
    try { text = git(root, ["show", `${baseRef}:${p}`], 2_000_000); } catch (e) { errors.push(`${p}: could not read at ${baseRef}`); continue; }
    try {
      if (p.endsWith(".proto")) baseProto.push(parseProto(rel(p), text));
      else if (looksLikeOpenApi(text)) { const d = loadOpenApi(rel(p), text); if (d) baseOa.push(d); }
    } catch (e) { errors.push(`${p}: ${(e as Error).message}`); }
  }

  const head = scanRepo(root);
  const changes: Change[] = [];
  const compared: string[] = [];
  const headByTitle = new Map(head.openapi.map(d => [d.title, d]));
  for (const bd of baseOa) {
    const hd = head.openapi.find(d => d.file === bd.file) ?? headByTitle.get(bd.title);
    if (!hd) { changes.push({ level: "breaking", kind: "contract-removed", subject: bd.file, message: `OpenAPI contract "${bd.title}" no longer exists`, file: bd.file }); continue; }
    compared.push(hd.file);
    changes.push(...diffOpenApi(bd, hd));
  }
  for (const hd of head.openapi) if (!baseOa.some(b => b.file === hd.file || b.title === hd.title)) changes.push({ level: "safe", kind: "contract-added", subject: hd.file, message: `new OpenAPI contract "${hd.title}"`, file: hd.file });
  if (baseProto.length || head.protos.length) { compared.push(...head.protos.map(p => p.file)); changes.push(...diffProto(baseProto, head.protos)); }

  changes.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.subject.localeCompare(b.subject));
  const count = (l: Change["level"]) => changes.filter(c => c.level === l).length;
  return { base: baseRef, changes, breaking: count("breaking"), potentially: count("potentially-breaking"), safe: count("safe"), filesCompared: compared, errors };
}

export function diffToText(r: DiffResult): string {
  const L = [`SeamLens diff against ${r.base}: ${r.breaking} breaking, ${r.potentially} potentially breaking, ${r.safe} safe`, ""];
  for (const c of r.changes) L.push(`${c.level === "breaking" ? "BREAKING " : c.level === "potentially-breaking" ? "POSSIBLY " : "safe     "} ${c.subject}: ${c.message}`);
  if (r.errors.length) L.push("", ...r.errors.map(e => `note: ${e}`));
  return L.join("\n");
}

export function diffToMarkdown(r: DiffResult): string {
  const L = [`# Contract diff against \`${r.base}\``, "", `**${r.breaking} breaking**, ${r.potentially} potentially breaking, ${r.safe} safe.`, ""];
  for (const [title, lvl] of [["Breaking", "breaking"], ["Potentially breaking", "potentially-breaking"], ["Safe", "safe"]] as const) {
    const cs = r.changes.filter(c => c.level === lvl);
    if (!cs.length) continue;
    L.push(`## ${title} (${cs.length})`, "");
    for (const c of cs) L.push(`- \`${c.subject}\`: ${c.message}`);
    L.push("");
  }
  return L.join("\n");
}
