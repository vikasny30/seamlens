import fs from "node:fs";
import path from "node:path";
import type { SourceFile } from "../model.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "venv", ".venv", "__pycache__", "coverage",
  "vendor", "target", ".idea", ".vscode", ".gradle", ".cache", ".turbo", "Pods", "DerivedData", ".pytest_cache",
]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".kt", ".rb", ".rs", ".php", ".cs",
  ".yaml", ".yml", ".json", ".proto", ".sql", ".graphql", ".gql", ".md",
]);
const MAX_BYTES = 1_000_000;

export function walk(root: string, extraIgnore: string[] = []): SourceFile[] {
  const out: SourceFile[] = [];
  const ignore = extraIgnore.map(g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "(/|$)"));
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (ignore.some(r => r.test(rel))) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
        visit(abs);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXT.has(ext)) continue;
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { continue; }
        if (size > MAX_BYTES) continue;
        out.push({ path: rel, ext, size });
      }
    }
  };
  visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolve a user-supplied relative path inside root, refusing traversal and symlink escapes. */
export function safeResolve(root: string, rel: string): string | null {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, rel);
  let real: string;
  try { real = fs.realpathSync(abs); } catch { return null; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return real;
}

export const lineOf = (text: string, index: number) => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};
