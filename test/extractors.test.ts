import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOpenApi, deref } from "../src/scan/extract-openapi.js";
import { parseProto } from "../src/scan/extract-proto.js";
import { parseSql, extractEmbeddedSql, emptySchema } from "../src/scan/extract-sql.js";
import { maskComments, extractRoutes, extractImports, extractOutbound, extractSmells, extractTableAccess, resolveImport } from "../src/scan/extract-code.js";
import { normPath, matchRoute } from "../src/scan/match.js";

test("openapi: operations, params, $ref, v2 body, malformed input", () => {
  const doc = loadOpenApi("a.yaml", `openapi: 3.0.0
info: {title: T, version: "2"}
servers: [{url: "https://x.io/v2"}]
paths:
  /pets/{id}:
    parameters: [{name: id, in: path, required: true, schema: {type: string}}]
    get:
      operationId: getPet
      parameters: [{name: expand, in: query, schema: {type: string}}]
      responses: {"200": {description: ok, content: {application/json: {schema: {$ref: "#/components/schemas/Pet"}}}}}
components:
  schemas:
    Pet: {type: object, properties: {name: {type: string}}}
`)!;
  assert.equal(doc.ops.length, 1);
  assert.equal(doc.ops[0].key, "GET /pets/{id}");
  assert.deepEqual(doc.ops[0].parameters.map(p => p.name).sort(), ["expand", "id"]);
  assert.equal(doc.servers[0], "https://x.io/v2");
  assert.equal(deref(doc.raw, doc.ops[0].responses[0].schema).properties.name.type, "string");
  const v2 = loadOpenApi("s.json", JSON.stringify({ swagger: "2.0", info: { title: "s", version: "1" }, host: "h.io", basePath: "/api", paths: { "/x": { post: { parameters: [{ in: "body", name: "b", required: true, schema: { type: "object" } }], responses: { "200": { description: "ok", schema: { type: "string" } } } } } } }))!;
  assert.equal(v2.ops[0].requestBody?.required, true);
  assert.equal(v2.servers[0], "https://h.io/api");
  assert.equal(loadOpenApi("bad.yaml", "key: [unclosed"), null);
  assert.equal(loadOpenApi("notapi.yaml", "name: x\nversion: 1"), null);
});

test("openapi: cyclic $ref does not hang", () => {
  const doc = loadOpenApi("c.yaml", `openapi: 3.0.0
info: {title: T, version: "1"}
paths: {}
components: {schemas: {A: {$ref: "#/components/schemas/B"}, B: {$ref: "#/components/schemas/A"}}}`)!;
  assert.ok(deref(doc.raw, { $ref: "#/components/schemas/A" }));
});

test("proto: messages, nested, enums, services, streams, reserved, map, oneof", () => {
  const p = parseProto("x.proto", `
syntax = "proto3";
package acme.v1;
import "google/protobuf/empty.proto";
// comment with message Fake { }
enum Color { COLOR_UNSPECIFIED = 0; RED = 1; }
message Outer {
  reserved 2, 5 to 7, 100 to max;
  reserved "old";
  string a = 1;
  map<string, int32> counts = 3;
  repeated Inner items = 4;
  oneof pick { string x = 8; int32 y = 9; }
  message Inner { optional string v = 1; }
  enum Kind { K0 = 0; }
}
service Svc {
  rpc Unary(Req) returns (Res);
  rpc Server(Req) returns (stream Res) { option deprecated = true; }
  rpc Client(stream Req) returns (google.protobuf.Empty);
}
message Req {} message Res {}
`);
  assert.equal(p.package, "acme.v1");
  assert.equal(p.syntax, "proto3");
  const outer = p.messages.find(m => m.fullName === "Outer")!;
  assert.deepEqual(outer.fields.map(f => `${f.name}:${f.number}`), ["a:1", "counts:3", "items:4", "x:8", "y:9"]);
  assert.equal(outer.fields.find(f => f.name === "counts")!.map, true);
  assert.equal(outer.fields.find(f => f.name === "items")!.repeated, true);
  assert.deepEqual(outer.reserved.numbers, [2]);
  assert.deepEqual(outer.reserved.ranges[0], [5, 7]);
  assert.equal(outer.reserved.ranges[1][1], 536870911);
  assert.deepEqual(outer.reserved.names, ["old"]);
  assert.ok(p.messages.some(m => m.fullName === "Outer.Inner"));
  assert.ok(p.enums.some(e => e.fullName === "Outer.Kind"));
  assert.equal(p.messages.some(m => m.name === "Fake"), false);
  const rpcs = p.services[0].rpcs;
  assert.equal(rpcs.length, 3);
  assert.equal(rpcs[1].serverStream, true);
  assert.equal(rpcs[2].clientStream, true);
  assert.equal(rpcs[2].response, "google.protobuf.Empty");
});

test("proto: garbage input does not throw or loop", () => {
  assert.doesNotThrow(() => parseProto("g.proto", "message { { { rpc ( ) enum = = ;;; }"));
});

test("sql: columns, constraints, indexes, alter, drop, comments", () => {
  const s = parseSql(`
-- schema
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email VARCHAR(255) NOT NULL UNIQUE,
  balance NUMERIC(10,2) DEFAULT 0,
  /* inline */ team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE
);
CREATE TABLE teams (id BIGINT, name TEXT, PRIMARY KEY (id));
CREATE TABLE memberships (user_id INT, team_id INT, PRIMARY KEY (user_id, team_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL, CONSTRAINT u UNIQUE (team_id, user_id));
CREATE UNIQUE INDEX idx_email ON users (email);
ALTER TABLE users ADD COLUMN age INT NOT NULL;
ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE users DROP COLUMN age;
ALTER TABLE teams ALTER COLUMN name TYPE VARCHAR(10);
DROP TABLE teams;
`, "m.sql");
  const u = s.tables["users"];
  assert.deepEqual(u.pk, ["id"]);
  assert.equal(u.columns.find(c => c.name === "email")!.notNull, true);
  assert.equal(u.columns.find(c => c.name === "balance")!.type, "NUMERIC(10,2)");
  assert.equal(u.columns.find(c => c.name === "team_id")!.references?.onDelete, "cascade");
  assert.equal(u.fks[0].refTable, "teams");
  assert.deepEqual(s.tables["memberships"].pk, ["user_id", "team_id"]);
  assert.equal(s.tables["memberships"].fks[0].onDelete, "set null");
  assert.deepEqual(s.tables["memberships"].uniques[0], ["team_id", "user_id"]);
  assert.equal(s.indexes[0].unique, true);
  assert.deepEqual(s.ops.map(o => o.kind), ["add_column", "add_column", "drop_column", "alter_type", "drop_table"]);
  assert.equal(s.ops[0].notNull && !s.ops[0].hasDefault, true);
  assert.equal(s.ops[1].hasDefault, true);
  assert.equal(s.tables["teams"], undefined);                 // dropped
  assert.equal(u.columns.some(c => c.name === "age"), false);  // column dropped
});

test("sql: embedded in a TypeScript template string, with line numbers", () => {
  const ts = "const a = 1;\ndb.exec(`\nCREATE TABLE t (\n  id INTEGER PRIMARY KEY,\n  v TEXT\n);\n`);\ndb.exec('ALTER TABLE t ADD COLUMN w INT');\n";
  const snippets = extractEmbeddedSql(ts);
  assert.equal(snippets.length, 2);
  const schema = emptySchema();
  for (const sn of snippets) parseSql(sn.sql, "x.ts", sn.line, schema);
  assert.equal(schema.tables["t"].line, 3);
  assert.equal(schema.tables["t"].columns.find(c => c.name === "v")!.line, 5);
  assert.ok(schema.tables["t"].columns.some(c => c.name === "w"));
});

test("routes: express, router.route chain, nest, fastapi, flask, raw node", () => {
  const ex = extractRoutes("a.ts", `app.get('/a', h);\nrouter.post("/b/:id", h);\nmap.get('/not-a-route');\naxios.get('/x');\nrouter.route('/c').get(h).delete(h);`, false);
  assert.deepEqual(ex.map(r => `${r.method} ${r.path}`).sort(), ["DELETE /c", "GET /a", "GET /c", "POST /b/:id"]);
  const nest = extractRoutes("c.ts", `@Controller('cats')\nclass C {\n @Get(':id') f(){}\n @Post() g(){}\n}`, false);
  assert.deepEqual(nest.map(r => `${r.method} ${r.path}`), ["GET /cats/:id", "POST /cats"]);
  const fa = extractRoutes("m.py", `router = APIRouter(prefix="/items")\n@router.get("/{id}")\ndef g(): pass\n@app.route("/f", methods=["GET","POST"])\ndef f(): pass`, true);
  assert.deepEqual(fa.map(r => `${r.method} ${r.path}`).sort(), ["GET /f", "GET /items/{id}", "POST /f"]);
  const raw = extractRoutes("s.ts", `if (req.method === 'POST' && url.pathname === '/api/goal') {}\nif (url.pathname.match(/^\\/api\\/task\\/(\\d+)\\/board$/)) {}`, false);
  assert.equal(raw[0].method, "POST");
  assert.equal(raw[0].path, "/api/goal");
  assert.equal(raw[1].path, "/api/task/{}/board");
});

test("imports: relative resolution incl. NodeNext .js→.ts, index files, python", () => {
  const files = new Set(["src/a.ts", "src/b.ts", "src/util/index.ts", "pkg/m.py", "pkg/sub/n.py"]);
  assert.equal(resolveImport("src/a.ts", "./b.js", files), "src/b.ts");
  assert.equal(resolveImport("src/a.ts", "./util", files), "src/util/index.ts");
  assert.equal(resolveImport("src/a.ts", "react", files), null);
  const e = extractImports("src/a.ts", `import x from './b.js';\nexport * from "./util";\nconst y = require('./b');\nimport('./util');\nimport z from 'lodash';`, false, files);
  assert.deepEqual(e.map(x => x.to).sort(), ["src/b.ts", "src/util/index.ts"]);
  const py = extractImports("pkg/m.py", `from .sub import n\nfrom pkg.sub.n import q`, true, files);
  assert.ok(py.some(x => x.to === "pkg/sub/n.py"));
});

test("outbound calls: timeout detection and loop context", () => {
  const code = `async function f(ids){\n  await fetch("https://a.io/x");\n  await fetch("https://b.io/y", { signal: AbortSignal.timeout(1) });\n  for (const id of ids) {\n    await fetch(\`https://c.io/\${id}\`);\n  }\n  let attempts = 0;\n  while (attempts < 3) { attempts++; await fetch("https://d.io"); }\n  const r = client.fetch("https://e.io");\n}`;
  const calls = extractOutbound("a.ts", code, false);
  const by = (h: string) => calls.find(c => c.host === h)!;
  assert.equal(by("a.io").hasTimeout, false);
  assert.equal(by("b.io").hasTimeout, true);
  assert.equal(by("c.io").inLoop, true);
  assert.equal(by("d.io").inLoop, false);   // retry loop is not an N+1
  assert.equal(calls.some(c => c.host === "e.io"), false); // method call on another object
  const py = extractOutbound("a.py", `requests.get("https://a.io")\nrequests.post("https://b.io", timeout=3)`, true);
  assert.deepEqual(py.map(c => c.hasTimeout), [false, true]);
});

test("smells: empty catch, db in loop, retry without backoff", () => {
  const s = extractSmells("a.ts", `try { x() } catch {}\ntry { y() } catch (e) { /* intentional */ }\nfor (const i of xs) {\n  await db.query("select 1");\n}\nlet retries = 3;\nwhile (retries--) { call(); }`, false);
  assert.equal(s.filter(x => x.kind === "empty_catch").length, 1);
  assert.equal(s.filter(x => x.kind === "db_in_loop").length, 1);
  assert.equal(s.filter(x => x.kind === "retry_no_backoff").length, 1);
  const withBackoff = extractSmells("b.ts", `let retries = 3;\nwhile (retries--) { await sleep(2 ** retries * 100); }`, false);
  assert.equal(withBackoff.filter(x => x.kind === "retry_no_backoff").length, 0);
});

test("table access classifies reads and writes and ignores DDL", () => {
  const a = extractTableAccess("r.ts", "db.query('SELECT * FROM orders JOIN users');\ndb.run('INSERT INTO orders VALUES (1)');\ndb.exec('CREATE TABLE orders (id INT)');", ["orders", "users"]);
  assert.deepEqual(a.map(x => `${x.table}:${x.mode}`).sort(), ["orders:read", "orders:write", "users:read"]);
});

test("route ↔ spec matching normalises parameter syntax and tolerates a mount prefix", () => {
  assert.equal(normPath("/u/:id/x"), "/u/{}/x");
  assert.equal(normPath("/u/{userId}/"), "/u/{}");
  assert.equal(normPath("/u/<int:id>"), "/u/{}");
  const route = (method: string, path: string) => ({ method, path, file: "f", line: 1, framework: "x", confidence: "high" as const });
  assert.equal(matchRoute({ method: "GET", path: "/u/{id}" }, route("GET", "/u/:uid")), "exact");
  assert.equal(matchRoute({ method: "GET", path: "/u/{id}" }, route("GET", "/api/u/:id")), "prefixed");
  assert.equal(matchRoute({ method: "GET", path: "/u" }, route("POST", "/u")), null);
  assert.equal(matchRoute({ method: "DELETE", path: "/u" }, route("ANY", "/u")), "exact");
  assert.equal(matchRoute({ method: "GET", path: "/orders" }, route("GET", "/preorders")), null);
});

test("sql: column and statement line numbers are exact after blank lines and comments", () => {
  const sql = "-- header\n\n\nCREATE TABLE a (\n  id INT PRIMARY KEY,\n\n  price FLOAT\n);\n\n/* c */\n\nCREATE TABLE b (\n  x INT\n);\n";
  const s = parseSql(sql, "f.sql");
  assert.equal(s.tables["a"].line, 4);
  assert.equal(s.tables["a"].columns.find(c => c.name === "id")!.line, 5);
  assert.equal(s.tables["a"].columns.find(c => c.name === "price")!.line, 7);
  assert.equal(s.tables["b"].line, 12);
  assert.equal(s.tables["b"].columns[0].line, 13);
});

test("imports: type-only imports are erased at compile time and are not dependency edges", () => {
  const files = new Set(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]);
  const code = [
    `import type { A } from './b';`,                    // erased
    `import { type A2, type A3 } from './c';`,          // every specifier is type-only: erased
    `import { type A4, real } from './d';`,             // mixed: kept
    `import { x } from './e';`,                         // kept
    `export type { T } from './f';`,                    // erased
    `import typedThing from './b';`,                    // a default import whose name merely starts with "type": kept
  ].join("\n");
  const e = extractImports("a.ts", code, false, files).map(x => x.to).sort();
  assert.deepEqual(e, ["b.ts", "d.ts", "e.ts"]);
  const onlyType = extractImports("a.ts", `import type { A } from './b';\nexport type { B } from './c';`, false, files);
  assert.deepEqual(onlyType, []);
});

test("comments are masked: code inside comments is not code, line numbers do not move, strings keep their // and #", () => {
  const js = "// app.get('/commented', h);\nconst url = 'https://x.io/a//b'; /* DROP TABLE users; */ app.get('/real', h);\n/*\n multi\n*/\ndb.exec(`ALTER TABLE t ADD COLUMN c INT`);\n";
  const m = maskComments(js, false);
  assert.equal(m.length, js.length);
  assert.equal(m.split("\n").length, js.split("\n").length);
  assert.ok(m.includes("https://x.io/a//b"), "// inside a string literal is not a comment");
  assert.ok(m.includes("ALTER TABLE t ADD COLUMN c INT"), "SQL inside a template string survives");
  assert.ok(!m.includes("DROP TABLE") && !m.includes("/commented"));
  assert.deepEqual(extractRoutes("a.ts", m, false).map(r => r.path), ["/real"]);
  const py = maskComments("x = '#not a comment'  # a comment\ny = \"\"\"# inside docstring\"\"\"\n# requests.get('http://x')\n", true);
  assert.ok(py.includes("#not a comment") && py.includes("# inside docstring"));
  assert.ok(!py.includes("a comment\n") && !py.includes("requests.get"));
});

test("false-positive regressions found by running SeamLens on its own source", () => {
  // a regex literal that merely contains the names of HTTP clients is not a call
  const regexSrc = "const HTTP = /(fetch|axios(?:\\.(?:get|post))?|got(?:\\.get)?)\\s*\\(/g;\nawait fetch('https://a.io');\n";
  const calls = extractOutbound("x.ts", regexSrc, false);
  assert.deepEqual(calls.map(c => c.host), ["a.io"], JSON.stringify(calls));
  // a documented empty catch is intentional; an undocumented one and a commented-out one are judged correctly
  const raw = "try { a() } catch { /* not json */ }\ntry { b() } catch {}\n// try { c() } catch {}\n";
  const masked = maskComments(raw, false);
  const smells = extractSmells("x.ts", masked, false, raw).filter(x => x.kind === "empty_catch");
  assert.deepEqual(smells.map(x => x.line), [2]);
  // the word "retry" in prose is not retry logic; a real retry counter without backoff is
  assert.equal(extractSmells("p.ts", `const why = "Networks retry. Without a key a retried order repeats."; for (const x of xs) { use(x); }`, false).filter(x => x.kind === "retry_no_backoff").length, 0);
  assert.equal(extractSmells("p.ts", `let attempts = 0; while (attempts < 3) { attempts++; call(); }`, false).filter(x => x.kind === "retry_no_backoff").length, 1);
});
