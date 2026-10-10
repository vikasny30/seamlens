import YAML from "yaml";
import type { OaDoc, OaOperation, OaParam, OaResponse } from "../model.js";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function looksLikeOpenApi(text: string): boolean {
  return /^\s*["']?(openapi|swagger)["']?\s*:/m.test(text) || /"(openapi|swagger)"\s*:/.test(text);
}

/** Resolve a local $ref ("#/components/schemas/X"). Returns the node itself when it is not a ref. */
export function deref(root: any, node: any, depth = 0): any {
  if (!node || typeof node !== "object" || depth > 20) return node;
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let cur: any = root;
  for (const part of ref.slice(2).split("/")) {
    cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (cur === undefined) return node;
  }
  return deref(root, cur, depth + 1);
}

/** Visit a schema and everything beneath it, following $ref with cycle protection. */
export function walkSchema(root: any, schema: any, cb: (s: any, path: string) => void, path = "", seen = new Set<any>(), depth = 0) {
  const s = deref(root, schema);
  if (!s || typeof s !== "object" || seen.has(s) || depth > 12) return;
  seen.add(s);
  cb(s, path);
  for (const [k, v] of Object.entries<any>(s.properties ?? {})) walkSchema(root, v, cb, path ? `${path}.${k}` : k, seen, depth + 1);
  if (s.items) walkSchema(root, s.items, cb, `${path}[]`, seen, depth + 1);
  for (const k of ["allOf", "oneOf", "anyOf"]) for (const v of s[k] ?? []) walkSchema(root, v, cb, path, seen, depth + 1);
  if (s.additionalProperties && typeof s.additionalProperties === "object") walkSchema(root, s.additionalProperties, cb, `${path}{}`, seen, depth + 1);
}

function findLine(text: string, re: RegExp, from = 0): number | undefined {
  const m = re.exec(text.slice(from));
  if (!m) return undefined;
  return text.slice(0, from + m.index).split("\n").length;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function loadOpenApi(file: string, text: string): OaDoc | null {
  let raw: any;
  try { raw = YAML.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || !raw.paths || !(raw.openapi || raw.swagger)) return null;

  const isV2 = !!raw.swagger;
  const servers: string[] = isV2
    ? [`${raw.schemes?.[0] ?? "https"}://${raw.host ?? ""}${raw.basePath ?? ""}`]
    : (raw.servers ?? []).map((s: any) => String(s?.url ?? ""));
  const securitySchemes = Object.keys(raw.components?.securitySchemes ?? raw.securityDefinitions ?? {});

  const ops: OaOperation[] = [];
  for (const [p, item] of Object.entries<any>(raw.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    const pathLevel: OaParam[] = (item.parameters ?? []).map((x: any) => toParam(raw, x)).filter(Boolean) as OaParam[];
    const pathLine = findLine(text, new RegExp(`^\\s*["']?${esc(p)}["']?\\s*:`, "m"));
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== "object") continue;
      const own: OaParam[] = (op.parameters ?? []).map((x: any) => toParam(raw, x)).filter(Boolean) as OaParam[];
      const merged = [...pathLevel.filter(pl => !own.some(o => o.name === pl.name && o.in === pl.in)), ...own];

      let requestBody: OaOperation["requestBody"];
      if (isV2) {
        const body = (op.parameters ?? []).map((x: any) => deref(raw, x)).find((x: any) => x?.in === "body");
        if (body) requestBody = { required: !!body.required, schema: body.schema };
      } else if (op.requestBody) {
        const rb = deref(raw, op.requestBody);
        const content = rb?.content ?? {};
        const first = content["application/json"] ?? content[Object.keys(content)[0]];
        requestBody = { required: !!rb?.required, schema: first?.schema };
      }

      const responses: OaResponse[] = Object.entries<any>(op.responses ?? {}).map(([status, r]) => {
        const rr = deref(raw, r);
        const content = rr?.content ?? {};
        const first = content["application/json"] ?? content[Object.keys(content)[0]];
        return { status: String(status), schema: isV2 ? rr?.schema : first?.schema, description: rr?.description, headers: Object.keys(rr?.headers ?? {}) };
      });

      let line: number | undefined;
      if (pathLine) line = findLine(text, new RegExp(`^\\s*["']?${m}["']?\\s*:`, "m"), text.split("\n").slice(0, pathLine - 1).join("\n").length) ?? pathLine;
      ops.push({
        key: `${m.toUpperCase()} ${p}`, method: m.toUpperCase(), path: p, operationId: op.operationId, summary: op.summary,
        tags: op.tags ?? [], parameters: merged, requestBody, responses, security: op.security, deprecated: !!op.deprecated, file, line,
      });
    }
  }
  return {
    file, title: String(raw.info?.title ?? file), version: String(raw.info?.version ?? ""), servers, securitySchemes,
    globalSecurity: raw.security, ops, raw, text,
  };
}

function toParam(root: any, x: any): OaParam | null {
  const p = deref(root, x);
  if (!p || typeof p !== "object" || !p.name) return null;
  return { name: String(p.name), in: String(p.in ?? "query"), required: !!p.required || p.in === "path", schema: p.schema ?? (p.type ? { type: p.type, format: p.format, enum: p.enum } : undefined) };
}
