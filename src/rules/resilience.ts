import type { Finding, RuleMeta } from "../model.js";
import { finding, rule } from "./util.js";

const S001: RuleMeta = { id: "RES001", title: "Outbound calls have timeouts", category: "resilience", severity: "warning",
  why: "A call with no timeout waits forever when the dependency hangs, holding a connection and a request open until the whole service is saturated.",
  fix: "Set an explicit timeout (AbortSignal.timeout(ms) with fetch, `timeout` with axios, `timeout=` with requests) and choose it from the caller's own latency budget." };
const S002: RuleMeta = { id: "RES002", title: "Retries back off", category: "resilience", severity: "info",
  why: "Immediate retries from many clients turn a brief dependency blip into a retry storm that keeps it down.",
  fix: "Use exponential backoff with jitter and a retry budget; retry only idempotent operations." };
const S003: RuleMeta = { id: "RES003", title: "Errors are not swallowed", category: "resilience", severity: "warning",
  why: "An empty catch hides the failure from logs, metrics and callers, so the first symptom is corrupted data or a mystery outage.",
  fix: "Handle the error, or log it with context and rethrow. If ignoring is intended, say why in a comment and log at debug." };
const S004: RuleMeta = { id: "RES004", title: "No calls in loops", category: "resilience", severity: "warning",
  why: "A network or database call inside a loop is the classic N+1: latency grows with the data and dependency load multiplies.",
  fix: "Batch (IN queries, bulk endpoints), or fetch concurrently with a bounded pool." };
const S005: RuleMeta = { id: "RES005", title: "Service exposes a health endpoint", category: "resilience", severity: "info",
  why: "Orchestrators and load balancers need a cheap liveness/readiness probe to restart or drain a sick instance.",
  fix: "Expose /health (liveness) and /ready (dependencies reachable)." };

export const resilienceRules = [
  rule(S001, ({ scan }) => scan.outbound.filter(c => !c.hasTimeout)
    .map(c => finding(S001, { message: `${c.kind} call${c.host ? " to " + c.host : ""} has no timeout`, file: c.file, line: c.line, confidence: "medium", evidence: c.text }))),
  rule(S002, ({ scan }) => scan.smells.filter(s => s.kind === "retry_no_backoff")
    .map(s => finding(S002, { message: "Retry logic with no backoff or jitter nearby", file: s.file, line: s.line, confidence: "low", evidence: s.text }))),
  rule(S003, ({ scan }) => scan.smells.filter(s => s.kind === "empty_catch")
    .map(s => finding(S003, { message: "Error is swallowed by an empty handler", file: s.file, line: s.line, evidence: s.text }))),
  rule(S004, ({ scan }): Finding[] => [
    ...scan.outbound.filter(c => c.inLoop).map(c => finding(S004, { message: `${c.kind} call${c.host ? " to " + c.host : ""} inside a loop`, file: c.file, line: c.line, confidence: "medium", evidence: c.text })),
    ...scan.smells.filter(s => s.kind === "db_in_loop").map(s => finding(S004, { message: "Database call inside a loop (N+1)", file: s.file, line: s.line, confidence: "medium", evidence: s.text })),
  ]),
  rule(S005, ({ scan }) => {
    if (scan.routes.length < 3 || scan.routes.some(r => /(health|ready|live|ping|status)/i.test(r.path))) return [];
    return [finding(S005, { message: `${scan.routes.length} routes found but none looks like a health or readiness endpoint`, file: scan.routes[0].file, line: scan.routes[0].line, confidence: "medium" })];
  }),
];
