import safeRegex from "safe-regex2";
import { Validator, type Schema } from "@cfworker/json-schema";
import { metaSchemas } from "./meta-schemas.js";
import {
  type Finding,
  type Json,
  type JsonObject,
  type Report,
  type Tool,
  appUri,
  asObject,
  uiMetadata,
} from "./contracts.js";

const CORE = "https://modelcontextprotocol.io/specification/";
const APPS =
  "https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/specification/draft/apps.mdx";
const QUALITY =
  "https://github.com/reachjalil/mcp-app-validator/blob/main/docs/rules.md";
export const RULES = [
  ["MCP-DISCOVERY-001", "Negotiated supported protocol", "specification"],
  ["MCP-DISCOVERY-002", "Unique inventory identifiers", "specification"],
  ["MCP-DISCOVERY-003", "Inventory coverage", "coverage"],
  ["MCP-CONTRACT-001", "Input JSON Schema", "specification"],
  ["MCP-CONTRACT-002", "Output JSON Schema", "specification"],
  ["MCP-CONTRACT-003", "Tool result matches output schema", "specification"],
  ["MCP-CONTRACT-004", "Input conforms before execution", "specification"],
  ["MCP-WIRE-001", "Versioned result envelope", "specification"],
  ["MCP-WIRE-002", "Versioned cache metadata", "specification"],
  ["MCP-PERF-001", "Observed slow request", "quality"],
  ["MCP-QUALITY-001", "Tool description", "quality"],
  ["MCP-QUALITY-002", "Discovery payload budget", "quality"],
  ["HOST-SCHEMA-001", "Composition import compatibility", "compatibility"],
  ["APP-RESOURCE-001", "Standard App reference", "specification"],
  ["APP-RESOURCE-002", "Readable HTML App resource", "specification"],
  ["APP-RESOURCE-003", "Effective resource CSP", "security"],
  ["APP-RESOURCE-004", "Tool visibility", "specification"],
  ["APP-LIFECYCLE-001", "App bridge initialization", "specification"],
  ["APP-LIFECYCLE-002", "Tool result delivery", "specification"],
  ["APP-DELIVERY-001", "Observed model context", "compatibility"],
  ["APP-DELIVERY-002", "Observed conversation messages", "compatibility"],
  ["APP-LAYOUT-001", "Requested versus allocated height", "quality"],
  ["HOST-NATIVE-001", "Native-host acceptance", "coverage"],
  ["MCP-AUTH-001", "Authentication requirement", "coverage"],
] as const;
export function finding(
  id: string,
  subject: string,
  outcome: Finding["outcome"],
  evidence: string,
  recommendation = "",
  basis?: Finding["basis"],
  source?: string
): Finding {
  const rule = RULES.find((r) => r[0] === id);
  return {
    id,
    subject,
    title: rule?.[1] ?? id,
    outcome,
    evidence,
    recommendation,
    basis: basis ?? rule?.[2] ?? "coverage",
    severity:
      outcome === "fail" ? "error" : outcome === "warning" ? "warning" : "info",
    source: source ?? (id.startsWith("APP-") ? APPS : QUALITY),
    attribution: id.startsWith("HOST-")
      ? "host"
      : id.startsWith("APP-")
        ? "app"
        : "server",
  };
}
function boundedSchema(
  schema: Json,
  depth = 0,
  count = { n: 0 },
  checkPatterns = false
): void {
  if (++count.n > 15000 || depth > 40)
    throw new Error("Schema exceeds the runner's evaluation budget.");
  if (Array.isArray(schema)) {
    for (const v of schema) boundedSchema(v, depth + 1, count, checkPatterns);
  } else if (schema && typeof schema === "object") {
    if (typeof schema.$ref === "string" && !schema.$ref.startsWith("#"))
      throw new Error(
        "External schema references require a locally supplied schema bundle."
      );
    if (
      checkPatterns &&
      typeof schema.pattern === "string" &&
      (schema.pattern.length > 1000 || !safeRegex(schema.pattern))
    )
      throw new Error(
        "Regular expression exceeds the runner's evaluation budget."
      );
    for (const v of Object.values(schema))
      boundedSchema(v, depth + 1, count, checkPatterns);
  }
}
const schemaValidator = new Validator(metaSchemas[0], "2020-12");
for (const meta of metaSchemas.slice(1)) schemaValidator.addSchema(meta);
function withoutFormatAssertions(schema: Json): Json {
  const source = asObject(schema);
  if (!source) return schema;
  const copy: JsonObject = { ...source };
  delete copy.format;
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ] as const) {
    const map = asObject(copy[key]);
    if (map)
      copy[key] = Object.fromEntries(
        Object.entries(map).map(([k, v]) => [k, withoutFormatAssertions(v)])
      );
  }
  for (const key of [
    "items",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ] as const) {
    const item = copy[key];
    if (item !== undefined && !Array.isArray(item))
      copy[key] = withoutFormatAssertions(item);
  }
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"] as const)
    if (Array.isArray(copy[key]))
      copy[key] = (copy[key] as Json[]).map(withoutFormatAssertions);
  return copy;
}
export interface SchemaCheck {
  valid: boolean;
  blocked: boolean;
  detail: string;
}
export function validateJsonSchema(
  schema: Json,
  value?: Json,
  isolated = false
): { valid: boolean; blocked: boolean; detail: string } {
  try {
    boundedSchema(schema, 0, { n: 0 }, value !== undefined && !isolated);
    const shape = schemaValidator.validate(schema);
    if (!shape.valid)
      return {
        valid: false,
        blocked: false,
        detail: JSON.stringify(shape.errors).slice(0, 1000),
      };
    // The official 2020-12 meta-schema establishes the structural type before
    // the interpreter receives it. Neither compilation nor validation uses eval.
    const checked = withoutFormatAssertions(schema) as Schema | boolean;
    if (value === undefined)
      return {
        valid: true,
        blocked: false,
        detail:
          "Valid JSON Schema 2020-12. Runtime constraints are tested separately.",
      };
    const result = new Validator(checked, "2020-12").validate(value);
    return {
      valid: result.valid,
      blocked: false,
      detail: result.valid
        ? "Value conforms to the declared schema."
        : JSON.stringify(result.errors).slice(0, 1000),
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Schema could not be evaluated.";
    return { valid: false, blocked: true, detail: detail.slice(0, 1000) };
  }
}
export function evaluate(report: Report): Finding[] {
  const out: Finding[] = [];
  const source = `${CORE}${report.protocolVersion}/server/tools`;
  out.push(
    finding(
      "MCP-DISCOVERY-001",
      "server",
      report.protocolVersion === "unknown" ? "blocked" : "pass",
      `Selected protocol: ${report.protocolVersion}.`,
      "",
      "specification",
      `${CORE}${report.protocolVersion}`
    )
  );
  for (const [kind, values] of [
    ["tools", report.tools.map((t) => t.name)],
    ["resources", report.resources.map((r) => r.uri)],
    ["prompts", report.prompts.map((p) => p.name)],
  ] as const) {
    out.push(
      finding(
        "MCP-DISCOVERY-002",
        kind,
        new Set(values).size === values.length ? "pass" : "fail",
        `${values.length} identifiers; ${new Set(values).size} unique.`,
        "Use unique identifiers within each inventory.",
        "specification",
        source
      )
    );
  }
  out.push(
    finding(
      "MCP-DISCOVERY-003",
      "server",
      report.complete ? "pass" : "blocked",
      report.complete
        ? "Advertised lists were read to their end."
        : "Discovery is incomplete. Retain partial evidence and inspect the trace.",
      "Runner limits and failed requests are not proof that a server is invalid."
    )
  );
  for (const tool of report.tools) {
    for (const [id, schema] of [
      ["MCP-CONTRACT-001", tool.inputSchema],
      ["MCP-CONTRACT-002", tool.outputSchema],
    ] as const) {
      if (schema === undefined) continue;
      const result = validateJsonSchema(schema);
      out.push(
        finding(
          id,
          tool.name,
          result.blocked ? "blocked" : result.valid ? "pass" : "fail",
          result.detail,
          "Keep the declared schema exact. Unresolved external refs need a reviewed local schema bundle.",
          "specification",
          source
        )
      );
    }
    out.push(
      finding(
        "MCP-QUALITY-001",
        tool.name,
        tool.description?.trim() ? "pass" : "warning",
        tool.description?.trim()
          ? "The tool describes its purpose."
          : "No tool description was supplied.",
        "Describe the intent, important inputs, result, and possible effects."
      )
    );
    const schema = asObject(tool.inputSchema);
    if (schema && ["allOf", "anyOf", "oneOf"].some((k) => k in schema))
      out.push(
        finding(
          "HOST-SCHEMA-001",
          tool.name,
          "warning",
          "The root schema uses composition. This may be valid MCP; host import behavior is untested.",
          "Compare the host's imported argument fields with this schema before changing it."
        )
      );
    const uri = appUri(tool);
    if (uri) {
      out.push(
        finding(
          "APP-RESOURCE-001",
          tool.name,
          uri.startsWith("ui://") &&
            typeof uiMetadata(tool).resourceUri === "string"
            ? "pass"
            : "warning",
          uri,
          "Use _meta.ui.resourceUri with a ui:// resource. Legacy aliases are recorded separately.",
          "compatibility"
        )
      );
      const visibility = uiMetadata(tool).visibility;
      out.push(
        finding(
          "APP-RESOURCE-004",
          tool.name,
          visibility === undefined ||
            (Array.isArray(visibility) &&
              visibility.every((v) => v === "app" || v === "model"))
            ? "pass"
            : "fail",
          JSON.stringify(visibility ?? ["model", "app"]),
          "Declare only model/app visibility; enforce it in the host."
        )
      );
      out.push(
        finding(
          "APP-RESOURCE-002",
          uri,
          "not-tested",
          "Select and read this resource to check its content.",
          "Resource discovery alone does not prove rendering."
        )
      );
    }
  }
  for (const event of report.trace) {
    const envelope = asObject(event.response);
    const result = asObject(envelope?.result);
    if (
      report.protocolVersion === "2026-07-28" &&
      result &&
      event.method !== "server/discover"
    ) {
      out.push(
        finding(
          "MCP-WIRE-001",
          `${event.method} #${event.sequence}`,
          result.resultType === "complete" ||
            result.resultType === "input_required"
            ? "pass"
            : "fail",
          `Observed resultType: ${String(result.resultType)}.`,
          "Return the selected protocol's result envelope.",
          "specification",
          `${CORE}2026-07-28/changelog`
        )
      );
      if (
        [
          "tools/list",
          "resources/list",
          "prompts/list",
          "resources/templates/list",
          "resources/read",
        ].includes(event.method)
      )
        out.push(
          finding(
            "MCP-WIRE-002",
            `${event.method} #${event.sequence}`,
            typeof result.ttlMs === "number" &&
              result.ttlMs >= 0 &&
              (result.cacheScope === "public" ||
                result.cacheScope === "private")
              ? "pass"
              : "fail",
            `ttlMs=${String(result.ttlMs)}; cacheScope=${String(result.cacheScope)}.`,
            "Supply versioned freshness and cache-scope metadata.",
            "specification",
            `${CORE}2026-07-28/changelog`
          )
        );
    }
  }
  for (const event of report.trace.filter((e) => e.durationMs > 3000))
    out.push(
      finding(
        "MCP-PERF-001",
        event.method,
        "warning",
        `This request took ${event.durationMs} ms in one observation.`,
        "Compare cold and warm requests; profile upstream waits and serialization. Consider paging large inventories. One observation does not establish latency percentiles."
      )
    );
  const discoveryBytes = report.trace
    .filter((e) => e.method.endsWith("/list"))
    .reduce((n, e) => n + e.bytes, 0);
  out.push(
    finding(
      "MCP-QUALITY-002",
      "server",
      discoveryBytes > 2000000 ? "warning" : "pass",
      `${discoveryBytes} bytes received across list operations.`,
      "This 2 MB recommendation is a HelloMCP budget, not an MCP limit."
    )
  );
  const apps = report.tools.some(appUri);
  for (const id of [
    "APP-LIFECYCLE-001",
    "APP-LIFECYCLE-002",
    "APP-DELIVERY-001",
    "APP-DELIVERY-002",
    "APP-LAYOUT-001",
  ])
    out.push(
      finding(
        id,
        "App runtime",
        apps ? "not-tested" : "not-applicable",
        apps
          ? "Needs an interactive or recorded App journey."
          : "No App linkage was observed."
      )
    );
  out.push(
    finding(
      "HOST-NATIVE-001",
      "native hosts",
      "not-tested",
      "This run does not prove native ChatGPT, Claude, or other host acceptance.",
      "Use the host diagnostic companion and retain dated native observations."
    )
  );
  return out;
}
export function inspectResource(
  uri: string,
  result: JsonObject,
  listed?: JsonObject
): Finding[] {
  const contents = Array.isArray(result.contents) ? result.contents : [];
  const item = contents.map(asObject).find((c) => c?.uri === uri);
  const ok =
    item &&
    item.mimeType === "text/html;profile=mcp-app" &&
    (typeof item.text === "string" || typeof item.blob === "string");
  const meta = {
    ...(listed ?? {}),
    ...(asObject(asObject(item?._meta)?.ui) ?? {}),
  };
  const csp = asObject(meta.csp);
  const domains = csp
    ? [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
      ].flatMap((k) =>
        Array.isArray(csp[k]) ? csp[k] : csp[k] === undefined ? [] : [null]
      )
    : [];
  const validCsp =
    meta.csp === undefined ||
    Boolean(
      csp &&
        domains.every(
          (d) =>
            typeof d === "string" && /^https:\/\//.test(d) && !/[;\s]/.test(d)
        )
    );
  return [
    finding(
      "APP-RESOURCE-002",
      uri,
      ok ? "pass" : "fail",
      ok
        ? "Matching HTML App resource returned. Execution remains separately tested."
        : "Expected a matching ui:// content item with MCP App MIME and text or base64 HTML.",
      "Return the exact linked resource and declare its content type."
    ),
    finding(
      "APP-RESOURCE-003",
      uri,
      validCsp ? "pass" : "warning",
      JSON.stringify(meta.csp ?? { policy: "restrictive defaults" }),
      "CSP metadata was inspected. The controlled host blocks all direct network requests; runtime enforcement in native hosts is untested."
    ),
  ];
}
export function inspectToolResult(tool: Tool, result: JsonObject): Finding[] {
  if (tool.outputSchema === undefined || result.isError === true) return [];
  if (result.structuredContent === undefined)
    return [
      finding(
        "MCP-CONTRACT-003",
        tool.name,
        "fail",
        "The tool declared outputSchema but returned no structuredContent.",
        "Return data that conforms to the declared output schema."
      ),
    ];
  const check = validateJsonSchema(tool.outputSchema, result.structuredContent);
  return [
    finding(
      "MCP-CONTRACT-003",
      tool.name,
      check.blocked ? "blocked" : check.valid ? "pass" : "fail",
      check.detail
    ),
  ];
}
