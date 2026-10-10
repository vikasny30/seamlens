import fs from "node:fs";
import path from "node:path";
import type { Config, Scan, OaDoc, ProtoFile, DetectedRoute, ImportEdge, OutboundCall, CodeSmell, TableAccess } from "../model.js";
import { walk } from "./walk.js";
import { looksLikeOpenApi, loadOpenApi } from "./extract-openapi.js";
import { parseProto } from "./extract-proto.js";
import { parseSql, emptySchema, extractEmbeddedSql } from "./extract-sql.js";
import { CODE_EXT, JS_EXT, isTestFile, maskComments, extractRoutes, extractImports, extractOutbound, extractSmells, extractTableAccess } from "./extract-code.js";

export function loadConfig(root: string): Config {
  try { return JSON.parse(fs.readFileSync(path.join(root, ".seamlens.json"), "utf8")); } catch { return {}; }
}

export function scanRepo(rootIn: string, override: Config = {}): Scan {
  const root = fs.realpathSync(rootIn);
  const config: Config = { ...loadConfig(root), ...override };
  const files = walk(root, config.ignore ?? []);
  const cache = new Map<string, string>();
  const read = (rel: string) => {
    if (!cache.has(rel)) { try { cache.set(rel, fs.readFileSync(path.join(root, rel), "utf8")); } catch { cache.set(rel, ""); } }
    return cache.get(rel)!;
  };
  const warnings: string[] = [];
  const openapi: OaDoc[] = [], protos: ProtoFile[] = [];
  const sql = emptySchema();

  // contracts first (exact), SQL files in path order so migrations apply in sequence
  for (const f of files) {
    try {
      if ([".yaml", ".yml", ".json"].includes(f.ext) && f.size < 800_000) {
        const t = read(f.path);
        if (looksLikeOpenApi(t)) { const d = loadOpenApi(f.path, t); if (d) openapi.push(d); }
      } else if (f.ext === ".proto") protos.push(parseProto(f.path, read(f.path)));
      else if (f.ext === ".sql") parseSql(read(f.path), f.path, 1, sql);
    } catch (e) { warnings.push(`${f.path}: ${(e as Error).message}`); }
  }
  const codeFiles = files.filter(f => CODE_EXT.has(f.ext));
  const masked = new Map<string, string>();
  const code = (rel: string) => { if (!masked.has(rel)) masked.set(rel, maskComments(read(rel), rel.endsWith(".py"))); return masked.get(rel)!; };
  const MIGRATION_PATH = /(^|\/)(migrations?|migrate|schema|db|database|sql)(\/|\.|$)/i;
  for (const f of codeFiles) {
    if (isTestFile(f.path)) continue;
    const t = code(f.path);
    if (!/create\s+(unique\s+)?(temp\w*\s+)?(table|index)|alter\s+table|drop\s+table/i.test(t)) continue;
    const hasCreate = /create\s+(temp\w*\s+)?table/i.test(t);
    for (const snip of extractEmbeddedSql(t)) {
      // CREATE statements are a strong signal anywhere. ALTER/DROP in code are only trusted in schema-like files, so an example
      // string such as "DROP TABLE users" in an error message or a filter's test data is not mistaken for a migration.
      if (/^(alter|drop)/i.test(snip.sql) && !hasCreate && !MIGRATION_PATH.test(f.path)) continue;
      try { parseSql(snip.sql, f.path, snip.line, sql); } catch (e) { warnings.push(`${f.path}:${snip.line}: ${(e as Error).message}`); }
    }
  }

  const sourceFiles = codeFiles.filter(f => !isTestFile(f.path)).map(f => f.path);
  const fileSet = new Set(sourceFiles);
  const tables = Object.keys(sql.tables);
  const routes: DetectedRoute[] = [], imports: ImportEdge[] = [], outbound: OutboundCall[] = [], smells: CodeSmell[] = [], tableAccess: TableAccess[] = [];
  for (const rel of sourceFiles) {
    const t = code(rel);
    const py = rel.endsWith(".py");
    if (!py && !JS_EXT.has(path.extname(rel))) continue;   // other languages: contracts only for now
    try {
      routes.push(...extractRoutes(rel, t, py));
      imports.push(...extractImports(rel, t, py, fileSet));
      outbound.push(...extractOutbound(rel, t, py));
      smells.push(...extractSmells(rel, t, py, read(rel)));
      if (tables.length) tableAccess.push(...extractTableAccess(rel, t, tables));
    } catch (e) { warnings.push(`${rel}: ${(e as Error).message}`); }
  }
  return { root, config, files, sourceFiles, openapi, protos, sql, routes, imports, outbound, smells, tableAccess, warnings, read };
}
