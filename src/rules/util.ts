import type { Finding, Rule, RuleMeta } from "../model.js";

export type Check = Rule["check"];
export const rule = (meta: RuleMeta, check: Check): Rule => ({ ...meta, check });

/** Build a finding for a rule, inheriting severity/category from its metadata unless overridden. */
export const finding = (meta: RuleMeta, p: Partial<Finding> & { message: string }): Finding => ({
  ruleId: meta.id, severity: meta.severity, category: meta.category, confidence: "high", fix: meta.fix, ...p,
});
