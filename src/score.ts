import type { Category, Finding } from "./model.js";

const WEIGHT = { error: 8, warning: 3, info: 0.5 } as const;
const CAP_PER_RULE = 15;

export interface Score { overall: number; grade: string; byCategory: Record<Category, number>; counts: { error: number; warning: number; info: number } }

export const grade = (n: number) => (n >= 90 ? "A" : n >= 80 ? "B" : n >= 70 ? "C" : n >= 60 ? "D" : "F");

// Smooth decay instead of a linear subtraction: a few findings read as a high score, many findings approach (but never hit) zero,
// and one noisy rule cannot dominate because each rule's contribution is capped.
const K_OVERALL = 80, K_CATEGORY = 40;
const decay = (pts: number, k: number) => Math.round(100 * Math.exp(-pts / k) * 10) / 10;

export function scoreFindings(findings: Finding[]): Score {
  const perRule = new Map<string, { cat: Category; pts: number }>();
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity]++;
    const w = WEIGHT[f.severity] * (f.confidence === "low" ? 0.5 : 1);
    const cur = perRule.get(f.ruleId) ?? { cat: f.category, pts: 0 };
    cur.pts = Math.min(CAP_PER_RULE, cur.pts + w);
    perRule.set(f.ruleId, cur);
  }
  const catPts: Record<Category, number> = { http: 0, grpc: 0, data: 0, architecture: 0, resilience: 0, drift: 0 };
  let total = 0;
  for (const { cat, pts } of perRule.values()) { catPts[cat] += pts; total += pts; }
  const byCategory = Object.fromEntries((Object.keys(catPts) as Category[]).map(k => [k, decay(catPts[k], K_CATEGORY)])) as Record<Category, number>;
  const overall = decay(total, K_OVERALL);
  return { overall, grade: grade(overall), byCategory, counts };
}
