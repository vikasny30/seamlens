import type { DetectedRoute, OaOperation } from "../model.js";

/** Normalise any parameter syntax (:id, {id}, <id>, <int:id>, {id:\d+}) to `{}` and drop trailing slashes. */
export function normPath(p: string): string {
  let s = p.trim().replace(/\{[^}]*\}/g, "{}").replace(/<[^>]*>/g, "{}").replace(/:[A-Za-z_]\w*/g, "{}").replace(/\*+/g, "{}");
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s.startsWith("/") ? s : "/" + s;
}

export const paramCount = (p: string) => (normPath(p).match(/\{\}/g) ?? []).length;

export type MatchKind = "exact" | "prefixed";

/** Does a detected route implement a documented operation? Allows an unknown mount prefix (suffix match). */
export function matchRoute(op: Pick<OaOperation, "method" | "path">, route: DetectedRoute, basePath = ""): MatchKind | null {
  const m = route.method.toUpperCase();
  if (m !== op.method && m !== "ANY" && m !== "ALL") return null;
  const a = normPath(op.path), b = normPath(route.path);
  if (a === b) return "exact";
  if (basePath && normPath(basePath + op.path) === b) return "exact";
  if (b !== "/" && a.endsWith(b) && a !== b) return "prefixed";   // spec path has a prefix the code mounts elsewhere
  if (a !== "/" && b.endsWith(a)) return "prefixed";               // code path carries a mount prefix
  return null;
}
