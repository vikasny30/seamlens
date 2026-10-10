// Shared types for the scan, graph and rule engine.

export type Severity = "error" | "warning" | "info";
export type Category = "http" | "grpc" | "data" | "architecture" | "resilience" | "drift";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  ruleId: string;
  severity: Severity;
  category: Category;
  message: string;
  file?: string;
  line?: number;
  nodeId?: string;
  evidence?: string;
  fix?: string;
  confidence: Confidence;
}

export interface RuleMeta {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  why: string;
  fix: string;
}

export interface Rule extends RuleMeta {
  check: (ctx: RuleContext) => Finding[];
}

// ---- extracted contract shapes ------------------------------------------------------------

export interface OaParam { name: string; in: string; required: boolean; schema?: any }
export interface OaResponse { status: string; schema?: any; description?: string; headers?: string[] }
export interface OaOperation {
  key: string;                // "GET /users/{id}"
  method: string;             // upper case
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  parameters: OaParam[];
  requestBody?: { required: boolean; schema?: any };
  responses: OaResponse[];
  security?: any[];           // undefined = inherit global; [] = explicitly public
  deprecated: boolean;
  file: string;
  line?: number;
}
export interface OaDoc {
  file: string;
  title: string;
  version: string;
  servers: string[];
  securitySchemes: string[];
  globalSecurity?: any[];
  ops: OaOperation[];
  raw: any;
  text: string;
}

export interface ProtoField { name: string; type: string; number: number; repeated: boolean; optional: boolean; map: boolean; line: number }
export interface ProtoReserved { numbers: number[]; ranges: [number, number][]; names: string[] }
export interface ProtoMessage { name: string; fullName: string; fields: ProtoField[]; reserved: ProtoReserved; line: number }
export interface ProtoEnum { name: string; fullName: string; values: { name: string; number: number; line: number }[]; line: number }
export interface ProtoRpc { name: string; request: string; response: string; clientStream: boolean; serverStream: boolean; line: number }
export interface ProtoService { name: string; rpcs: ProtoRpc[]; line: number }
export interface ProtoFile { file: string; syntax: string; package: string; messages: ProtoMessage[]; enums: ProtoEnum[]; services: ProtoService[] }

export interface SqlColumn { name: string; type: string; notNull: boolean; hasDefault: boolean; pk: boolean; line: number; references?: { table: string; column?: string; onDelete?: string } }
export interface SqlTable { name: string; columns: SqlColumn[]; pk: string[]; fks: { cols: string[]; refTable: string; refCols: string[]; onDelete?: string }[]; uniques: string[][]; file: string; line: number }
export interface SqlIndex { name: string; table: string; columns: string[]; unique: boolean; file: string; line: number }
export interface SqlMigrationOp { kind: "drop_table" | "drop_column" | "alter_type" | "add_column"; table: string; column?: string; notNull?: boolean; hasDefault?: boolean; file: string; line: number; text: string }
export interface SqlSchema { tables: Record<string, SqlTable>; indexes: SqlIndex[]; ops: SqlMigrationOp[] }

export interface DetectedRoute { method: string; path: string; file: string; line: number; framework: string; confidence: Confidence }
export interface ImportEdge { from: string; to: string }
export interface OutboundCall { kind: string; url?: string; host?: string; hasTimeout: boolean; file: string; line: number; inLoop: boolean; text: string }
export interface CodeSmell { kind: "empty_catch" | "db_in_loop" | "retry_no_backoff"; file: string; line: number; text: string }
export interface TableAccess { file: string; table: string; mode: "read" | "write"; line: number }

export interface SourceFile { path: string; ext: string; size: number }

export interface Config {
  layers?: { name: string; match: string; mayImport?: string[] }[];
  basePath?: string;
  disabledRules?: string[];
  agentPatterns?: string[];
  ignore?: string[];
  moduleDepth?: number;
}

export interface Scan {
  root: string;
  config: Config;
  files: SourceFile[];
  sourceFiles: string[];
  openapi: OaDoc[];
  protos: ProtoFile[];
  sql: SqlSchema;
  routes: DetectedRoute[];
  imports: ImportEdge[];
  outbound: OutboundCall[];
  smells: CodeSmell[];
  tableAccess: TableAccess[];
  warnings: string[];
  read: (rel: string) => string;
}

// ---- graph --------------------------------------------------------------------------------

export type NodeKind = "module" | "route" | "operation" | "rpc" | "table" | "external";
export interface GNode { id: string; kind: NodeKind; label: string; file?: string; line?: number; meta?: Record<string, any> }
export type EdgeKind = "imports" | "implements" | "handles" | "reads" | "writes" | "calls" | "references";
export interface GEdge { from: string; to: string; kind: EdgeKind; weight: number }
export interface Graph { nodes: GNode[]; edges: GEdge[] }

export interface RuleContext { scan: Scan; graph: Graph }

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };
