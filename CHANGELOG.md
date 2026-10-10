# Changelog

## 0.1.0

First release.

- **Map:** OpenAPI 3 / Swagger 2, protobuf, SQL DDL (including DDL embedded in TypeScript/JavaScript/Python strings), HTTP routes (Express-like, Fastify, Hono, NestJS, FastAPI, Flask, raw Node), imports, outbound calls. 37 rules across HTTP, gRPC, data, architecture, resilience and spec-versus-code drift. Contract-health score. JSON, Markdown, text and SARIF 2.1.0 output.
- **Visual workflow:** local web UI with a lane-based flow map, end-to-end trace with a check at every hop, findings with code viewer, contract list, rule catalog.
- **Diff:** semantic breaking-change detection for OpenAPI and protobuf against any git ref; exits non-zero on breaking changes.
- **Impact:** agent-assisted vs other commits with Wilson confidence intervals, an explicit insufficient-data state, and a size-adjusted reading that re-checks every difference inside commit-size bands (agent commits are larger, and size drives the metrics).
- **Org:** ownership concentration, bus factor, hotspots, cadence, tags, GitHub PR metrics through `gh`; authors pseudonymised by default.
- **Bench:** generate SWE-bench-style tasks from your own history; validate (fail before, pass after) and run an agent command with scope-creep measurement (CLI only).
- **MCP server:** eight read-only tools over stdio.
