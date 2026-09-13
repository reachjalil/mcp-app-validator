import { z } from "zod";

export const VERSION = "0.1.0";
export const PROTOCOLS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
export const jsonSchema = z.json();
export type Json = z.infer<typeof jsonSchema>;
export const objectSchema = z.record(z.string(), jsonSchema);
export type JsonObject = z.infer<typeof objectSchema>;
// MCP extension metadata and arbitrary declared JSON Schemas are JSON data, not
// executable configuration. Internal report and operation contracts stay strict.
export const toolSchema = z
  .object({
    name: z.string().min(1).max(256),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.union([objectSchema, z.boolean()]),
    outputSchema: z.union([objectSchema, z.boolean()]).optional(),
    annotations: objectSchema.optional(),
    _meta: objectSchema.optional(),
  })
  .catchall(jsonSchema);
export const resourceSchema = z
  .object({
    uri: z.string(),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    _meta: objectSchema.optional(),
  })
  .catchall(jsonSchema);
export const promptSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    arguments: z.array(objectSchema).optional(),
  })
  .catchall(jsonSchema);
export type Tool = z.infer<typeof toolSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Prompt = z.infer<typeof promptSchema>;

export const eventSchema = z.strictObject({
  sequence: z.number().int(),
  at: z.string(),
  method: z.string(),
  durationMs: z.number().nonnegative(),
  request: jsonSchema,
  response: jsonSchema,
  status: z.number().int(),
  bytes: z.number().int().nonnegative(),
  direction: z.enum(["client-server", "app-host"]),
  outcome: z.enum(["complete", "error", "blocked", "notification"]),
});
export type TraceEvent = z.infer<typeof eventSchema>;
export const findingSchema = z.strictObject({
  id: z.string(),
  subject: z.string(),
  title: z.string(),
  outcome: z.enum([
    "pass",
    "fail",
    "warning",
    "not-tested",
    "not-applicable",
    "blocked",
  ]),
  basis: z.enum([
    "specification",
    "compatibility",
    "security",
    "quality",
    "coverage",
  ]),
  severity: z.enum(["error", "warning", "info"]),
  evidence: z.string(),
  recommendation: z.string(),
  source: z.string(),
  attribution: z.enum(["server", "app", "host", "runner", "undetermined"]),
});
export type Finding = z.infer<typeof findingSchema>;
export const reportSchema = z.strictObject({
  format: z.literal("mcp-app-validator/report/v1"),
  coreVersion: z.string(),
  createdAt: z.string(),
  target: z.string(),
  protocolVersion: z.string(),
  serverInfo: objectSchema,
  capabilities: objectSchema,
  tools: z.array(toolSchema).max(1000),
  resources: z.array(resourceSchema).max(1000),
  prompts: z.array(promptSchema).max(1000),
  resourceTemplates: z.array(objectSchema).max(1000),
  findings: z.array(findingSchema).max(20000),
  trace: z.array(eventSchema).max(500),
  complete: z.boolean(),
  elapsedMs: z.number().nonnegative(),
  mode: z.enum(["live", "fixture", "replay"]),
});
export type Report = z.infer<typeof reportSchema>;
export interface RpcState {
  protocolVersion: string;
  sessionId?: string;
  nextId: number;
}
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export const LIMITS = {
  requestMs: 15000,
  runMs: 60000,
  pages: 20,
  inventory: 1000,
  responseBytes: 4 * 1024 * 1024,
  requestBytes: 1024 * 1024,
  events: 500,
} as const;

export function asObject(value: Json | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}
export function toJson(value: unknown): Json {
  return jsonSchema.parse(value);
}
export function uiMetadata(value: { _meta?: JsonObject }): JsonObject {
  return asObject(value._meta?.ui) ?? {};
}
export function appUri(tool: Tool): string | undefined {
  const uri =
    uiMetadata(tool).resourceUri ??
    tool._meta?.["ui/resourceUri"] ??
    tool._meta?.["openai/outputTemplate"];
  return typeof uri === "string" ? uri : undefined;
}
export function displayTarget(input: string): string {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname
      .split("/")
      .map((p) => (p.length > 32 ? "[redacted]" : p))
      .join("/")}${url.search ? "?[redacted]" : ""}`;
  } catch {
    return "local stdio";
  }
}
const SECRET_KEY =
  /authorization|cookie|token|secret|password|code_verifier|api[-_]?key|credential/i;
export function redact(value: Json, depth = 0): Json {
  if (depth > 30) return "[depth limited]";
  if (typeof value === "string")
    return value
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .slice(0, 100000);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1),
      ])
    );
  return value;
}
export function summary(report: Report) {
  return {
    tools: report.tools.length,
    resources: report.resources.length,
    prompts: report.prompts.length,
    apps: new Set(report.tools.map(appUri).filter(Boolean)).size,
    passed: report.findings.filter((f) => f.outcome === "pass").length,
    failed: report.findings.filter((f) => f.outcome === "fail").length,
    warnings: report.findings.filter((f) => f.outcome === "warning").length,
    untested: report.findings.filter(
      (f) => f.outcome === "not-tested" || f.outcome === "blocked"
    ).length,
  };
}
