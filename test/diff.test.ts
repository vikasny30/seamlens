import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadOpenApi } from "../src/scan/extract-openapi.js";
import { parseProto } from "../src/scan/extract-proto.js";
import { diffOpenApi } from "../src/diff/openapi-diff.js";
import { diffProto } from "../src/diff/proto-diff.js";
import { diffRepo } from "../src/diff/index.js";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const BASE: any = {
  openapi: "3.0.0", info: { title: "Pets", version: "1" },
  paths: {
    "/pets": {
      post: {
        operationId: "createPet",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 50 }, kind: { type: "string", enum: ["dog", "cat"] }, note: { type: "string" } } } } } },
        responses: { "201": { description: "ok" } },
      },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, age: { type: "integer" }, status: { type: "string", enum: ["a", "b"] } } } } } } },
      },
    },
  },
};
const doc = (spec: any) => loadOpenApi("api.yaml", JSON.stringify(spec))!;
const diff = (mutate: (s: any) => void) => { const h = clone(BASE); mutate(h); return diffOpenApi(doc(BASE), doc(h)); };
const reqSchema = (s: any) => s.paths["/pets"].post.requestBody.content["application/json"].schema;
const respSchema = (s: any) => s.paths["/pets/{id}"].get.responses["200"].content["application/json"].schema;
const find = (cs: ReturnType<typeof diff>, kind: string) => cs.find(c => c.kind === kind);

test("openapi diff: identical or cosmetic changes produce nothing", () => {
  assert.deepEqual(diff(() => {}), []);
  assert.deepEqual(diff(s => { s.info.title = "Pets"; s.paths["/pets"].post.summary = "new words"; s.paths["/pets/{id}"].get.description = "doc only"; }), []);
});

test("openapi diff: breaking changes", () => {
  assert.equal(find(diff(s => { delete s.paths["/pets/{id}"]; }), "operation-removed")?.level, "breaking");
  assert.equal(find(diff(s => { reqSchema(s).required.push("kind"); }), "request-property-required")?.level, "breaking");
  assert.equal(find(diff(s => { reqSchema(s).properties.size = { type: "string" }; reqSchema(s).required.push("size"); }), "request-property-required")?.level, "breaking");
  assert.equal(find(diff(s => { reqSchema(s).properties.kind.enum = ["dog"]; }), "request-enum-removed")?.level, "breaking");
  assert.equal(find(diff(s => { reqSchema(s).properties.name.maxLength = 10; }), "request-constraint-narrowed")?.level, "breaking");
  assert.equal(find(diff(s => { respSchema(s).properties.age.type = "string"; }), "response-type-changed")?.level, "breaking");
  assert.equal(find(diff(s => { delete respSchema(s).properties.age; }), "response-property-removed")?.level, "breaking");
  assert.equal(find(diff(s => { respSchema(s).required = []; }), "response-property-optional")?.level, "breaking");
  assert.equal(find(diff(s => { s.paths["/pets/{id}"].get.parameters.push({ name: "tenant", in: "query", required: true, schema: { type: "string" } }); }), "parameter-added-required")?.level, "breaking");
  assert.equal(find(diff(s => { s.paths["/pets/{id}"].get.responses = {}; }), "response-removed")?.level, "breaking");
  assert.equal(find(diff(s => { s.paths["/pets/{id}"].get.security = [{ key: [] }]; }), "security-added")?.level, "breaking");
  assert.equal(find(diff(s => { s.paths["/pets"].post.requestBody.required = true; s.paths["/pets/{id}"].get.requestBody = { required: true, content: { "application/json": { schema: { type: "object" } } } }; }), "request-body-required")?.level, "breaking");
});

test("openapi diff: potentially breaking changes", () => {
  assert.equal(find(diff(s => { respSchema(s).properties.status.enum.push("c"); }), "response-enum-added")?.level, "potentially-breaking");
  assert.equal(find(diff(s => { delete reqSchema(s).properties.note; }), "request-property-removed")?.level, "potentially-breaking");
  assert.equal(find(diff(s => { respSchema(s).properties.age.nullable = true; }), "response-nullable-added")?.level, "potentially-breaking");
});

test("openapi diff: safe changes are reported as safe, never as breaking", () => {
  const cs = diff(s => {
    reqSchema(s).properties.color = { type: "string" };                       // optional request field
    respSchema(s).properties.created = { type: "string" };                     // new response field
    s.paths["/pets/{id}"].get.parameters.push({ name: "expand", in: "query", schema: { type: "string" } });
    s.paths["/pets/{id}"].delete = { operationId: "deletePet", responses: { "204": { description: "x" } } };
    s.paths["/pets"].post.responses["400"] = { description: "bad" };
    reqSchema(s).properties.kind.enum.push("bird");                            // request enum widened
  });
  assert.ok(cs.length >= 5);
  assert.ok(cs.every(c => c.level === "safe"), JSON.stringify(cs.filter(c => c.level !== "safe")));
});

test("openapi diff: response problems are tagged with their status; $ref and recursion are followed", () => {
  const base = clone(BASE), head = clone(BASE);
  base.components = { schemas: { Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" }, v: { type: "string" } } } } };
  head.components = clone(base.components);
  base.paths["/pets/{id}"].get.responses["200"].content["application/json"].schema = { $ref: "#/components/schemas/Node" };
  head.paths["/pets/{id}"].get.responses["200"].content["application/json"].schema = { $ref: "#/components/schemas/Node" };
  head.components.schemas.Node.properties.v.type = "integer";
  const cs = diffOpenApi(doc(base), doc(head));
  assert.ok(cs.some(c => c.kind === "response-type-changed" && c.message.startsWith("[200]")));
});

const P = (body: string) => parseProto("a.proto", `syntax = "proto3"; package acme.v1; ${body}`);

test("proto diff: breaking vs safe", () => {
  const base = [P(`message M { string a = 1; int32 b = 2; repeated string c = 3; }
    enum E { E_UNSPECIFIED = 0; X = 1; }
    service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); }`)];
  const kinds = (body: string) => new Map(diffProto(base, [P(body)]).map(c => [c.kind, c.level]));

  let k = kinds(`message M { string a = 1; repeated string c = 3; } enum E { E_UNSPECIFIED = 0; X = 1; } service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); }`);
  assert.equal(k.get("field-removed-not-reserved"), "breaking");
  k = kinds(`message M { reserved 2; string a = 1; repeated string c = 3; } enum E { E_UNSPECIFIED = 0; X = 1; } service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); }`);
  assert.equal(k.get("field-removed-reserved"), "safe");
  assert.equal(k.has("field-removed-not-reserved"), false);
  k = kinds(`message M { string a = 1; string b = 2; repeated string c = 3; } enum E { E_UNSPECIFIED = 0; X = 1; } service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); }`);
  assert.equal(k.get("field-type-changed"), "breaking");      // int32 → string is wire-incompatible
  k = kinds(`message M { string a = 1; int64 b = 2; repeated string c = 3; } enum E { E_UNSPECIFIED = 0; X = 1; } service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); }`);
  assert.equal(k.get("field-type-compatible"), "potentially-breaking");   // int32 → int64 shares the wire type
  k = kinds(`message M { string a = 1; int32 b = 2; string c = 3; } enum E { E_UNSPECIFIED = 0; X = 1; } service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); }`);
  assert.equal(k.get("field-cardinality-changed"), "breaking");
  k = kinds(`message M { string a = 1; int32 renamed = 2; repeated string c = 3; } enum E { E_UNSPECIFIED = 0; X = 1; } service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); }`);
  assert.equal(k.get("field-renamed"), "potentially-breaking");
  k = kinds(`message M { string a = 1; int32 b = 2; repeated string c = 3; string d = 4; } enum E { E_UNSPECIFIED = 0; X = 1; Y = 2; } service S { rpc Get(M) returns (M); rpc Gone(M) returns (M); rpc New(M) returns (M); }`);
  assert.deepEqual([...new Set(k.values())], ["safe"]);
  k = kinds(`message M { string a = 1; int32 b = 2; repeated string c = 3; } enum E { E_UNSPECIFIED = 0; } service S { rpc Get(M) returns (M); }`);
  assert.equal(k.get("enum-value-removed"), "breaking");
  assert.equal(k.get("rpc-removed"), "breaking");
  k = kinds(`message M { string a = 1; int32 b = 2; repeated string c = 3; } message N {} enum E { E_UNSPECIFIED = 0; X = 1; } service S { rpc Get(M) returns (N); rpc Gone(M) returns (M); }`);
  assert.equal(k.get("rpc-response-changed"), "breaking");
});

test("proto diff: reusing a number that was reserved is breaking", () => {
  const base = [P(`message M { reserved 2; string a = 1; }`)];
  const head = [P(`message M { string a = 1; string z = 2; }`)];
  assert.equal(diffProto(base, head).find(c => c.kind === "reserved-number-reused")?.level, "breaking");
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-diff-"));
  const run = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  run("init", "-q"); run("config", "user.email", "t@t.t"); run("config", "user.name", "t"); run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "api.yaml"), JSON.stringify(BASE));
  fs.writeFileSync(path.join(dir, "a.proto"), `syntax = "proto3"; package acme.v1; message M { string a = 1; int32 b = 2; }`);
  run("add", "."); run("commit", "-q", "-m", "base");
  return dir;
}

test("diffRepo: compares the working tree against a git ref, using git show (no checkout)", () => {
  const dir = repo();
  try {
    const head = clone(BASE); delete head.paths["/pets/{id}"]; reqSchema(head).required.push("kind");
    fs.writeFileSync(path.join(dir, "api.yaml"), JSON.stringify(head));
    fs.writeFileSync(path.join(dir, "a.proto"), `syntax = "proto3"; package acme.v1; message M { string a = 1; }`);
    const r = diffRepo(dir, "HEAD");
    assert.ok(r.breaking >= 3, JSON.stringify(r.changes));
    const kinds = r.changes.map(c => c.kind);
    for (const k of ["operation-removed", "request-property-required", "field-removed-not-reserved"]) assert.ok(kinds.includes(k), k);
    assert.equal(fs.readFileSync(path.join(dir, "api.yaml"), "utf8"), JSON.stringify(head), "working tree was not touched");
    assert.equal(diffRepo(dir, "HEAD").errors.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("diffRepo: rejects option-injection refs, unknown refs and non-repos", () => {
  const dir = repo();
  try {
    for (const bad of ["--upload-pack=touch /tmp/pwn", "-x", "HEAD; rm -rf /", "$(id)", "a b"]) assert.throws(() => diffRepo(dir, bad), /not a valid git ref/, bad);
    assert.throws(() => diffRepo(dir, "no-such-branch"), /Cannot resolve/);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-plain-"));
    assert.throws(() => diffRepo(plain, "HEAD"), /Not a git repository/);
    fs.rmSync(plain, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
