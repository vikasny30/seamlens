# SeamLens: design

Working title. Package `seamlens` (free on npm as of 2026-10-10). A "seam" is the boundary between two parts of a system: an HTTP API, a gRPC service, a database schema, a module import. Seams are where systems break, so SeamLens makes them visible and checks them.

## 1. Why this exists

Two questions land on every engineering director's desk in 2026:

1. **Is our system design still sound as the code gets written faster, often by agents?** Contracts drift, layers get bypassed, retries and timeouts go missing. Nobody sees it until an incident.
2. **Are our AI coding agents actually paying off?** The honest answer needs measurement on real production history, not vendor claims or toy benchmarks.

SeamLens answers both from the repository itself, locally, with no data leaving the machine. It is built as four modules that share one engine, because the answers connect: agent-written code that breaks a contract is the interesting case.

| Module | Question it answers | Primary output |
|---|---|---|
| **Map** | What does the system look like end to end, and are its contracts sound? | Visual flow map + findings + score |
| **Diff** | Will this change break a consumer? | Breaking-change report (CI gate) |
| **Impact** | Is agent-assisted work better or worse than the rest? | Cohort metrics with confidence intervals |
| **Org** | Where is the organization bottlenecked or fragile? | Ownership, cadence, review-load metrics |
| **Bench** | Can we turn our own history into agent evaluations? | Validated task set + scope-creep-aware runner |

Surfaces: **CLI** (`seamlens`), **web UI** (`seamlens serve`), **MCP server** (`seamlens-mcp`), **CI** (SARIF output, GitHub Action).

## 2. Principles

1. **Local and read-only by default.** Nothing is uploaded. The scanner never executes the code it analyzes. The only features that run user commands (`bench validate`, `bench run`) are CLI-only, off by default in MCP, and run in disposable git worktrees.
2. **Evidence over opinion.** Every finding carries rule ID, file, line, a quoted snippet, why it matters, and how to fix it. No finding without evidence.
3. **Honest about heuristics.** Static analysis of routes, SQL in strings, and imports is approximate. Every extractor reports a confidence level, and the UI says so. Contract files (OpenAPI, protobuf, SQL) are exact; framework route detection is not.
4. **Statistics with error bars.** Agent-impact numbers always show sample size and a Wilson confidence interval. Below 30 commits per cohort the report says "not enough data" instead of a verdict.
5. **Deterministic.** No LLM in the analysis path. The same repo and commit give the same report.
6. **Useful on day one.** Works with zero config on a repo that has an OpenAPI file or a `.proto`. Config (`.seamlens.json`) only refines.

## 3. Architecture

```
                         ┌──────────────────────────── surfaces ───────────────────────────┐
                         │   CLI            Web UI (SVG)        MCP server        CI/SARIF  │
                         └─────┬──────────────┬───────────────────┬─────────────────┬───────┘
                               │              │                   │                 │
                         ┌─────▼──────────────▼───────────────────▼─────────────────▼───────┐
                         │                       core API  (src/index.ts)                    │
                         └─────┬────────────┬────────────┬────────────┬────────────┬────────┘
                               │            │            │            │            │
                          ┌────▼───┐   ┌────▼───┐   ┌────▼───┐   ┌────▼───┐   ┌────▼───┐
                          │  scan  │   │  diff  │   │ impact │   │  org   │   │ bench  │
                          └────┬───┘   └────┬───┘   └────┬───┘   └────┬───┘   └────┬───┘
                               │            │            └──────┬─────┘            │
              ┌────────────────┼────────────┘                   │                  │
              │   extractors   │                          ┌─────▼──────────────────▼──┐
   openapi · proto · sql ·     │                          │  git layer (log, show,     │
   routes · imports · calls    │                          │  worktree, numstat, gh)    │
              │                │                          └────────────────────────────┘
        ┌─────▼─────┐   ┌──────▼──────┐
        │  graph    │──▶│ rule engine │──▶ findings ──▶ score ──▶ reporters (json, md, sarif)
        └───────────┘   └─────────────┘
```

Single npm package, ESM, TypeScript strict, Node >= 18. Runtime dependencies: `yaml`, `@modelcontextprotocol/sdk`, `zod`. Everything else (protobuf parser, SQL DDL parser, graph layout, Wilson intervals, SARIF writer) is in-repo, small, and tested.

### 3.1 Data model (`src/model.ts`)

```ts
Scan      { root, files[], openapi[], protos[], sql, routes[], imports[], calls[], tables[] }
Graph     { nodes: Node[], edges: Edge[] }
Node      { id, kind: 'module'|'route'|'operation'|'rpc'|'table'|'external'|'service', label, file?, line?, meta }
Edge      { from, to, kind: 'imports'|'implements'|'documents'|'reads'|'writes'|'calls', weight }
Finding   { ruleId, severity: 'error'|'warning'|'info', category, message, file?, line?, nodeId?, evidence?, fix?, confidence }
Rule      { id, title, category, severity, why, fix, check(scan, graph) -> Finding[] }
```

Findings attach to nodes, so the map can color a node by its worst finding and the side panel can list everything about it.

## 4. Contract sources and extractors

| Source | How | Exact or heuristic |
|---|---|---|
| OpenAPI 3.x / Swagger 2 (`.yaml`, `.yml`, `.json`) | `yaml` parser, local `$ref` resolution, line numbers from the document AST | Exact |
| Protobuf (`.proto`, proto3) | In-repo tokenizer and parser: package, messages, nested messages, enums, services, rpcs, fields, `reserved`, options | Exact |
| SQL DDL (`.sql`, and `CREATE TABLE` inside `.ts/.js/.py` strings) | In-repo parser: tables, columns, types, PK, FK, indexes, unique, `ALTER TABLE`, `DROP` | Exact for standard DDL, best effort for dialect extras |
| HTTP routes in code | Regex families: Express/Fastify/Hono/Koa (`app.get('/x')`, `router.route('/x').post`), NestJS decorators, FastAPI/Flask decorators, raw Node `pathname === '/x'` | Heuristic (medium confidence) |
| Imports | JS/TS `import`/`require`/dynamic `import()`, Python `import`/`from`, resolved to repo files | Exact for relative imports, ignores aliases unless `tsconfig` paths present |
| Outbound calls | `fetch`, `axios`, `got`, `requests`, `httpx` with literal URLs | Heuristic |
| Table access | Known table names found inside SQL-looking strings with verb classification (read vs write) | Heuristic |

Out of scope for v0.1 (tracked in the roadmap): GraphQL SDL, AsyncAPI, JSON Schema registries, Thrift, ORM model introspection (Prisma, SQLAlchemy).

## 5. Rule catalog

Severity reflects production risk, not style. Each rule has a rationale (`why`) and a remediation (`fix`) that the UI and `explain_rule` return verbatim.

### HTTP / OpenAPI (`API*`)
| ID | Sev | Checks |
|---|---|---|
| API001 | warn | Missing `operationId`; duplicate `operationId` is an error (breaks client generation) |
| API002 | warn | Operation defines no error response (4xx/5xx/default); or more than one distinct error schema across the API |
| API003 | warn | Collection `GET` returning an array with no pagination parameter (`limit`, `cursor`, `page`, `offset`, `page_size`, `after`) |
| API004 | warn | Payment-like `POST` (`order`, `payment`, `charge`, `transfer`, `invoice`, `checkout`) with no `Idempotency-Key` header: retries create duplicates |
| API005 | warn | No authentication defined (no `securitySchemes`, no `security`); explicit `security: []` operations listed as info |
| API006 | warn | No versioning strategy (no `/v1` path prefix, no version in `servers`, no `info.version`) |
| API007 | warn | Mixed property casing (camelCase and snake_case) across schemas; verbs in resource paths (info) |
| API008 | info | Unbounded input: request strings without `maxLength`, arrays without `maxItems` (one aggregated finding) |
| API009 | info | No `429` response anywhere: rate limiting is not part of the contract |
| API010 | warn | Write operation (`POST/PUT/PATCH`) without a `400` or `422` validation response |
| API011 | info | `POST` that creates a resource returns `200` instead of `201`/`202` |
| API012 | warn | `DELETE` or `GET` with a request body (proxies and clients drop it) |

### gRPC / Protobuf (`PRO*`)
| ID | Sev | Checks |
|---|---|---|
| PRO001 | warn | Package has no version suffix (`foo.v1`) |
| PRO002 | warn | Enum's first value is not `0` or not named `*_UNSPECIFIED`/`*_UNKNOWN`: unset fields silently become a real value |
| PRO003 | warn | RPC reuses one message for request and response, or request/response not named `*Request`/`*Response` (info): blocks independent evolution |
| PRO004 | warn | Gaps in field numbers without `reserved`: a removed field's number can be reused, corrupting old clients |
| PRO005 | warn | `List*` rpc request lacks `page_size`/`page_token` |
| PRO006 | warn | Money-like field (`price`, `amount`, `balance`, `cost`) typed `float`/`double` |
| PRO007 | info | Naming: rpc not `PascalCase`, field not `snake_case` |

### Data (`DB*`)
| ID | Sev | Checks |
|---|---|---|
| DB001 | error | Table without a primary key |
| DB002 | warn | Foreign-key-like column (`*_id`, `REFERENCES`) with no supporting index |
| DB003 | error | Money-like column stored as `FLOAT`/`REAL`/`DOUBLE` |
| DB004 | warn | Destructive migration (`DROP TABLE`, `DROP COLUMN`, `ALTER ... TYPE`) in one step: breaks rolling deploys; use expand/contract |
| DB005 | error | `ALTER TABLE ... ADD COLUMN ... NOT NULL` with no default: breaks old writers and can lock the table |
| DB006 | info | Foreign key with no `ON DELETE` behavior stated |

### Architecture (`ARC*`)
| ID | Sev | Checks |
|---|---|---|
| ARC001 | error (warning for 2-file cycles) | Circular runtime dependency between files (strongly connected component of size > 1), reported with the cycle path. Type-only imports are erased at compile time and are not edges |
| ARC002 | warn | Layer violation: handlers/controllers importing the data layer directly while a services layer exists; or data layer importing handlers (inverted dependency, error). Configurable layers in `.seamlens.json` |
| ARC003 | warn | God module: fan-out >= 15 or fan-in >= 25 |
| ARC004 | warn | Deep import into a sibling package/service bypassing its public entry |

### Resilience (`RES*`)
| ID | Sev | Checks |
|---|---|---|
| RES001 | warn | Outbound HTTP call with no timeout (`fetch` without signal, `axios` without `timeout`, `requests` without `timeout=`) |
| RES002 | info | Retry logic with no backoff or jitter keyword nearby |
| RES003 | warn | Swallowed errors: empty `catch`, Python `except: pass` |
| RES004 | warn | Outbound call or database query inside a loop (N+1 / sequential fan-out) |
| RES005 | info | Service exposes routes but no health/readiness endpoint |

### Cross-contract drift (`X*`)
| ID | Sev | Checks |
|---|---|---|
| X001 | warn | Operation documented in the spec but no matching route found in code |
| X002 | warn | Route found in code but absent from the spec (undocumented API) |
| X003 | info | Matching route and operation disagree on path parameter count |

Route-to-spec matching normalizes parameter syntax (`:id`, `{id}`, `<id>`) and allows an unknown mount prefix (suffix match), downgrading confidence when it does.

### 5.1 Scoring

Per-category and overall **Contract Health** 0 to 100. Each finding adds penalty points (error 8, warning 3, info 0.5; half for low-confidence findings), capped at 15 points per rule so one noisy rule cannot dominate. The score is `100 * exp(-points / K)` (K = 80 overall, 40 per category): a few findings still read as a high score, many findings approach but never reach zero, and the number never hits a hard floor that hides further decay. Grade bands: A >= 90, B >= 80, C >= 70, D >= 60, F below. Scores are for trend and gating, not for comparing unrelated repos. The report always lists the contributing findings.

## 6. Diff: breaking-change detection

`seamlens diff --base <git-ref>` loads each contract file as of `<ref>` (`git show`) and as of the working tree, then compares semantically.

**OpenAPI breaking:** removed path or operation; removed success response; new required parameter or required request property; changed type or format of an existing property; request enum value removed; request constraint narrowed (`maxLength` lowered, `minimum` raised); response property removed; operation newly requires security.
**OpenAPI potentially breaking:** response enum value added (strict consumers fail); response property made nullable.
**Non-breaking:** new operations, new optional request fields, new response fields.

**Protobuf breaking:** field number removed without `reserved`; field number reused with a different type or name; field type changed (wire-incompatible); rpc removed or its request/response type changed; enum value removed; `repeated` toggled; package renamed.

Exit code is non-zero when breaking changes exist, so it works as a CI gate. Output formats: text, JSON, Markdown, SARIF.

## 7. The visual workflow (web UI)

`seamlens serve [path]` starts a local server on `127.0.0.1` (random free port by default). Views:

1. **Flow map.** Lanes left to right: *Contracts* (operations, rpcs) → *Entry points* (routes) → *Modules* → *Data and external* (tables, outbound hosts). Nodes are colored by their worst finding (green, amber, red, grey for none). Edges: `implements`, `imports`, `reads`/`writes`, `calls`. Pan and zoom. Filters by kind and minimum severity.
2. **End-to-end trace.** Click an operation or route: everything downstream (handler module, its transitive imports, tables read and written, external hosts called) and everything upstream stays lit; the rest dims. The side panel lists the **hops with a check at each hop**: contract defined, route implemented, error model present, timeout on outbound call, table has primary key and index. A hop fails visibly. Trace is based on the static import closure, so the panel labels it approximate.
3. **Findings.** Sortable table by severity, category, file. Click opens the file viewer at the offending line with the evidence highlighted.
4. **Contracts.** Every operation, rpc and table with its own health, so a reviewer can scan a contract and see its issues.
5. **Diff.** Choose a base ref; shows breaking, potentially breaking and safe changes grouped by contract.
6. **Impact.** Agent-assisted vs other cohorts with intervals and a plain-language reading of how much to trust them.
7. **Rules.** The catalog with rationale and fix, and per-rule enable/disable written back to `.seamlens.json`.

Design: dense but quiet, light and dark themes, keyboard navigation, no external network requests (no CDN, no fonts, no analytics).

### 7.1 Layout algorithm
Deterministic layered layout: fixed lane x positions; within a lane, nodes ordered by the barycenter of connected nodes in the previous lane (two sweeps); vertical spacing constant; edges drawn as cubic Béziers. Graphs over 250 nodes are aggregated to directory level with a "expand" control. No physics simulation, so layouts are stable between runs and diffable in screenshots.

### 7.2 Web server security
Binds to loopback only. Rejects requests whose `Host` is not loopback (DNS rebinding). `GET /api/file` serves only files under the scanned root, resolved with `realpath`, blocking `..`, symlink escapes, files over 1 MB, and binary files. No endpoint executes anything. Mutating endpoints (rescan, save config) require a custom header so cross-site pages cannot call them.

## 8. Impact analyzer (agent vs other work)

**Attribution** (configurable regexes in `.seamlens.json`): a commit is *agent-assisted* when any of these hold: a `Co-authored-by`/`Assisted-by` trailer naming Claude, Copilot, Cursor, Codex, Gemini, Devin, Aider, OpenHands; body contains `Generated with` plus a known agent; author e-mail at a known agent domain; message prefix `aider:`. Everything else is *other*. Attribution is a **lower bound**: unmarked agent work lands in *other*, which biases toward understating the effect. The report says this up front.

**Metrics per cohort**, each with n and a 95% Wilson interval for rates:
- Median and p90 lines changed; files per commit.
- **Test-touch rate:** commits that change source also change tests.
- **Revert rate:** subject starts with `Revert` or body says `This reverts commit`.
- **Fix-follow-up rate:** a later commit whose subject matches `fix|bug|regression|hotfix` touches the same files within 7 days (a proxy for escaped defects).
- **Rework rate:** share of a commit's files modified again by any later commit within 14 days (churn).
- **Contract-health delta (optional, `--with-contracts`):** run the Map rules on the parent and on the commit and report whether it introduced new findings. This is the cross-module metric nobody else has: *do agent commits degrade the contracts more often than human ones?*

**Reading rules:** fewer than 30 commits in a cohort prints "insufficient data"; intervals that overlap print "no detectable difference"; the Markdown report states the biases (attribution lower bound, squash merges hide authorship, commit size is not value). It never reports a ranking of people.

## 9. Org metrics

Offline from git: ownership concentration and **bus factor** per top-level directory (smallest author set covering 50% of changes); churn hotspots (commit count x recent activity); weekly cadence trend; release cadence from tags. With `--github owner/repo` and an authenticated `gh`: PR cycle time (open to merge), time to first review, PR size, review load per reviewer, stale open PRs. Reviewer and author identifiers are hashed in exported reports unless `--names` is passed, so a report can be shared without turning into a people ranking.

## 10. Bench: turn your history into agent evaluations

Inspired by SWE-bench, built from the user's own repo.

1. **generate**: find candidate commits (non-merge; touches source and tests; 1 to 8 files; under 300 changed lines; message suggests a fix or feature). For each, emit a task: base commit (the parent), problem statement (subject and body), `gold_patch` (source diff), `test_patch` (test diff), difficulty score (files, hunks, lines, directory spread), languages.
2. **validate** (CLI only): in a disposable `git worktree` at the base commit, apply `test_patch`, run the user's test command, expect **fail**; apply `gold_patch`, run again, expect **pass**. Only fail-then-pass tasks are kept. Timeouts and process-group kill on every run.
3. **run** (CLI only): give each validated task to an agent command; after it finishes, apply `test_patch`, run tests; record pass/fail, wall time, files changed. The headline extra metric is **scope-creep ratio**: share of files the agent changed that are outside the gold patch's files, computed with the same scope idea as the Aletheia paper's S3 signature. The report separates "solved narrowly" from "solved by rewriting half the repo".

Safety: the runner executes user-supplied commands, so it runs only from the CLI with explicit flags, in temp worktrees, with a timeout, with a scrubbed environment (no inherited tokens), and never from the MCP server.

## 11. MCP server

Stdio transport, low-level `Server` with Zod-validated tool inputs (same pattern as `aletheia-mcp`). Read-only tools:

| Tool | Purpose |
|---|---|
| `scan_contracts` | Scan a repo; return summary, score, counts by rule |
| `check_contracts` | Findings filtered by severity, category or rule |
| `explain_rule` | Rationale and fix for a rule ID |
| `contract_diff` | Breaking-change report against a base ref |
| `impact_report` | Agent-assisted vs other cohort metrics |
| `org_metrics` | Ownership, cadence, bus factor |
| `generate_benchmark_tasks` | Candidate tasks as JSON (no execution) |
| `open_visual_map` | Start the local UI, return its URL |

Threat model: tool arguments are untrusted. Paths must resolve to a directory under the optional `SEAMLENS_ROOTS` allowlist; the server never executes repo code or shell strings; output size is capped; contents of scanned files are treated as data and returned inside clearly delimited fields so an instruction hidden in a repo file cannot be mistaken for server output by the host (prompt-injection hygiene).

## 12. CLI

```
seamlens scan [path]            summary + score
seamlens check [path]           findings; --severity, --format text|json|md|sarif, --fail-on error|warning
seamlens diff  [path] --base R  breaking changes; exits 1 on breaking
seamlens serve [path]           web UI
seamlens impact [path]          agent vs other cohorts; --since 180d, --with-contracts
seamlens org [path]             ownership and cadence; --github owner/repo
seamlens bench generate|validate|run [path]
seamlens rules [id]             catalog or one rule
```

## 13. CI integration
SARIF 2.1.0 output uploads to GitHub code scanning, so findings appear as annotations on the PR. A reusable GitHub Action runs `check --fail-on error` and `diff --base ${{ github.base_ref }}`; a Markdown summary is posted to the job summary.

## 14. Testing strategy
- **Unit:** each extractor and rule against small inline inputs, including malformed files.
- **Fixture repo** (`fixtures/shop`) with deliberately planted issues; the test asserts the exact set of rule IDs found, so a regression in any rule is caught.
- **Diff:** golden before/after specs for each breaking and non-breaking class.
- **Statistics:** Wilson interval against known values.
- **Impact/Org/Bench:** run against a temporary git repo built in the test with scripted commits.
- **Web:** start the server, assert `/api/scan` shape, file endpoint path-traversal rejections, Host-header rejection.
- **MCP:** spawn the server over stdio with the SDK client; list tools; call each.
- **Dogfood:** CI runs SeamLens on itself and on the `harness` project.

## 15. Roadmap
- **M1 (built, v0.1.0):** Map, Diff, Impact, Org (git and GitHub PRs via `gh`), Bench generate/validate/run, CLI, web UI, MCP, SARIF, tests. The Action file and registry manifest are included but nothing is published yet.
- **M2:** Bench validate/run with isolation hardening; GitHub PR metrics; GitHub Action; `.seamlens.json` rule editor in the UI.
- **M3:** GraphQL and AsyncAPI; ORM model extraction; `tsconfig` path aliases; Python framework depth.
- **M4:** Trend store (SQLite) for score over time; PR comment bot; multi-repo system view.

## 16. Discoverability plan (honest version)
Search ranking cannot be guaranteed. What reliably helps is real proof plus clear naming:
- Descriptive README title and first paragraph using the phrases people actually search ("OpenAPI breaking changes", "AI coding agent impact", "engineering metrics MCP").
- GitHub topics, npm keywords, MCP registry listing (`server.json`), and a short demo GIF.
- One methodology article per module (agent-impact methodology and its statistical limits; "contracts as the seams of a system"; how scope creep is measured in agent benchmarks). These are what a hiring manager at an AI lab reads.
- A public methodology page and reproducible results on named open-source repos.
- Consistent author identity across GitHub, npm, the paper repo and LinkedIn.

## 17. Risks and honest limitations
- Route and call detection is heuristic; false positives and negatives are expected. Mitigation: confidence labels, per-rule disable, config for layers and base paths.
- Agent attribution from commit metadata undercounts agent work. Mitigation: stated bias, optional custom patterns.
- Small cohorts make fragile comparisons. Mitigation: intervals and an explicit "insufficient data" state.
- Scores can be gamed by satisfying rules mechanically. Mitigation: scores are labeled as a trend signal, with every finding shown.
- The benchmark runner executes commands. Mitigation: CLI-only, worktree isolation, scrubbed env, timeouts. It is not a security sandbox; run it in a container or VM for untrusted agents.
