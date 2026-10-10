export type ChangeLevel = "breaking" | "potentially-breaking" | "safe";
export interface Change {
  level: ChangeLevel;
  kind: string;          // machine-readable class, e.g. "request-property-required"
  subject: string;       // "POST /orders" or "shop.Order.price"
  message: string;
  file?: string;
}
export const LEVEL_RANK: Record<ChangeLevel, number> = { breaking: 3, "potentially-breaking": 2, safe: 1 };
