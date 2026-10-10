# Security policy

## Reporting a vulnerability

Please do not open a public issue. Email **Vikas Shivpuriya <vikas.ny30@gmail.com>** with a reproduction and the impact you see. You will get an acknowledgement within 48 hours.

## What SeamLens does and does not do

SeamLens is a local analysis tool. It reads files and git history in the directories you point it at, and never sends data anywhere.

| Surface | Can read | Can write | Can execute commands |
|---|---|---|---|
| `scan`, `check`, `diff`, `impact`, `org`, `rules` | the repo and its git history | only the file you pass to `--out` | `git` (read-only subcommands), and `gh` for `org --github` |
| `serve` (web UI) | files under the scanned root | nothing | no |
| `seamlens-mcp` | directories allowed by `SEAMLENS_ROOTS` | nothing | no |
| `bench validate` / `bench run` | the repo | temporary git worktrees | **yes: commands you supply**, CLI only |

### Controls
- **Parsers never execute analysed code.** Contracts, routes and imports are extracted with parsers and regular expressions.
- **No shell for git or gh.** Arguments are passed as arrays. Git refs must match a strict pattern, so values like `--upload-pack=…` are rejected. The GitHub repo argument must look like `owner/name`.
- **Web UI:** binds to `127.0.0.1`, rejects any `Host` that is not loopback (DNS rebinding), sets a Content-Security-Policy, serves files only after `realpath` confinement to the scanned root (blocks `..`, absolute paths, NUL bytes and symlink escapes; 1 MB and binary limits), and requires a custom header on every state-changing request so other websites cannot call it. All repository text is inserted into the page as text, never as HTML.
- **MCP server:** exposes no tool that runs commands. Paths are confined to `SEAMLENS_ROOTS` when set (set it). Responses are size-capped, structured, and carry a notice that repository-derived text is untrusted data, which reduces the chance of a prompt injection hidden in a repo file being followed by the host model.
- **Benchmark runner:** executes commands you give it, in disposable worktrees, with a scrubbed environment (no inherited tokens), a timeout and process-group kill, and discards agent edits to the hidden tests. **It is not a sandbox.** Run untrusted agents in a container or VM.

### Known limits
- Route, call and table-access detection is heuristic, so findings carry a confidence label.
- Agent attribution from commit metadata is a lower bound.
- A scanned repository can still be hostile in ways that only matter to the person reading the output (misleading text in findings). Treat evidence strings as untrusted.
