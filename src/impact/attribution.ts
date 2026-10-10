import type { Commit } from "./git-log.js";

export type Cohort = "agent" | "bot" | "other";

const AGENTS = "claude|anthropic|copilot|cursor|codex|gemini|devin|aider|openhands|openai|windsurf|cody|amazon q|q developer|jules|continue\\.dev";
const TRAILER = new RegExp(`^(co-authored-by|assisted-by|generated-by|ai-assisted-by)\\s*:.*\\b(${AGENTS})\\b`, "im");
const GENERATED = new RegExp(`(generated with|created with|written with|made with)[^\\n]{0,40}\\b(${AGENTS})\\b`, "i");
const AGENT_EMAIL = /@(anthropic\.com|cursor\.(sh|com)|devin\.ai|openai\.com|codeium\.com|windsurf\.\w+)$/i;
const BOT = /(\[bot\]|dependabot|renovate|github-actions|greenkeeper|snyk-bot|release-please|semantic-release)/i;

/** Attribution is a LOWER BOUND on agent work: anything not marked in the commit metadata lands in "other". */
export function classify(c: Commit, extra: RegExp[] = []): Cohort {
  if (BOT.test(c.author) || BOT.test(c.email)) return "bot";
  const msg = `${c.subject}\n${c.body}`;
  if (TRAILER.test(c.body) || GENERATED.test(msg) || AGENT_EMAIL.test(c.email) || /^aider:/i.test(c.subject)) return "agent";
  if (extra.some(r => r.test(msg) || r.test(c.author) || r.test(c.email))) return "agent";
  return "other";
}

export const compilePatterns = (src: string[] = []): RegExp[] => src.flatMap(s => { try { return [new RegExp(s, "i")]; } catch { return []; } });
