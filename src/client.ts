import {
  type Fetcher,
  type Json,
  type JsonObject,
  type Report,
  type RpcState,
  type TraceEvent,
  LIMITS,
  PROTOCOLS,
  VERSION,
  asObject,
  displayTarget,
  objectSchema,
  promptSchema,
  redact,
  resourceSchema,
  toJson,
  toolSchema,
} from "./contracts.js";
import { evaluate, finding } from "./rules.js";

export class RpcError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code?: number,
    public challenge?: string
  ) {
    super(message);
  }
}
export async function boundedBody(
  response: Response,
  id?: number
): Promise<{ value: Json; bytes: number }> {
  if (!response.body) return { value: null, bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const sse = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMITS.responseBytes)
        throw new RpcError("Response exceeds the 4 MiB runner limit.");
      text += decoder.decode(chunk.value, { stream: true });
      if (sse) {
        text = text.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = text.indexOf("\n\n")) >= 0) {
          const event = text.slice(0, boundary);
          text = text.slice(boundary + 2);
          const data = event
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const value = toJson(JSON.parse(data));
          const obj = asObject(value);
          if (obj && obj.id === id && ("result" in obj || "error" in obj))
            return { value, bytes };
          if (obj?.method && obj.id !== undefined)
            throw new RpcError(
              "Server requested client input; no input was authorized for this discovery run."
            );
        }
      }
    }
    if (sse)
      throw new RpcError(
        "The event stream ended without a matching RPC response."
      );
    return { value: text.trim() ? toJson(JSON.parse(text)) : null, bytes };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class McpConnection {
  state: RpcState;
  readonly trace: TraceEvent[] = [];
  private started = Date.now();
  constructor(
    readonly target: string,
    readonly fetcher: Fetcher,
    state?: RpcState,
    private credential?: string
  ) {
    this.state = state ?? { protocolVersion: "2026-07-28", nextId: 1 };
  }
  async rpc(
    method: string,
    args: JsonObject = {},
    notification = false
  ): Promise<JsonObject> {
    if (
      this.trace.reduce((sum, event) => sum + event.bytes, 0) >
      8 * 1024 * 1024
    )
      throw new RpcError("Run response budget reached.");
    if (this.trace.length >= LIMITS.events)
      throw new RpcError("Run event budget reached.");
    const id = notification ? undefined : this.state.nextId++;
    const modern = this.state.protocolVersion === "2026-07-28";
    const params: JsonObject = modern
      ? {
          ...args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion":
              this.state.protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: {
                "io.modelcontextprotocol/ui": {
                  mimeTypes: ["text/html;profile=mcp-app"],
                },
              },
            },
            "io.modelcontextprotocol/clientInfo": {
              name: "MCP App Validator",
              version: VERSION,
            },
          },
        }
      : args;
    const request: JsonObject = {
      jsonrpc: "2.0",
      method,
      params,
      ...(id === undefined ? {} : { id }),
    };
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": this.state.protocolVersion,
    };
    if (modern) {
      headers["mcp-method"] = method;
      if (typeof args.name === "string") headers["mcp-name"] = args.name;
      else if (typeof args.uri === "string") headers["mcp-name"] = args.uri;
    }
    if (this.state.sessionId) headers["mcp-session-id"] = this.state.sessionId;
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    const start = Date.now();
    let status = 0;
    let bytes = 0;
    let observed: Json = null;
    let outcome: TraceEvent["outcome"] = "error";
    try {
      const body = JSON.stringify(request);
      if (new TextEncoder().encode(body).length > LIMITS.requestBytes)
        throw new RpcError("Request exceeds the 1 MiB runner limit.");
      const response = await this.fetcher(this.target, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(LIMITS.requestMs),
      });
      status = response.status;
      if (status === 401 || status === 403) {
        await response.body?.cancel();
        throw new RpcError(
          "This server requires authorization or additional scope.",
          status,
          undefined,
          response.headers.get("www-authenticate") ?? undefined
        );
      }
      if (!response.ok) {
        if (
          status === 400 &&
          method === "server/discover" &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          const payload = await boundedBody(response);
          observed = payload.value;
          bytes = payload.bytes;
          const failure = asObject(asObject(payload.value)?.error);
          if (
            failure &&
            (failure.code === -32601 ||
              failure.code === -32022 ||
              (typeof failure.message === "string" &&
                /unsupported protocol version/i.test(failure.message)))
          )
            throw new RpcError(
              "Modern protocol not supported; trying the legacy initialization contract.",
              status,
              -32022
            );
        } else await response.body?.cancel();
        throw new RpcError(`Target returned HTTP ${status}.`, status);
      }
      const session = response.headers.get("mcp-session-id");
      if (!modern && session && /^[\x21-\x7e]{1,256}$/.test(session))
        this.state.sessionId = session;
      if (notification && (status === 202 || status === 204)) {
        outcome = "notification";
        await response.body?.cancel();
        return {};
      }
      if (
        !/application\/json|text\/event-stream/.test(
          response.headers.get("content-type") ?? ""
        )
      )
        throw new RpcError(
          "Target returned an unsupported protocol content type.",
          status
        );
      const payload = await boundedBody(response, id);
      bytes = payload.bytes;
      observed = payload.value;
      const envelope = asObject(payload.value);
      if (
        !envelope ||
        envelope.jsonrpc !== "2.0" ||
        envelope.id !== id ||
        "result" in envelope === "error" in envelope
      )
        throw new RpcError(
          "Response must have a matching JSON-RPC ID and exactly one result or error.",
          status
        );
      const error = asObject(envelope.error);
      if (error)
        throw new RpcError(
          typeof error.message === "string"
            ? error.message.slice(0, 500)
            : "JSON-RPC error",
          status,
          typeof error.code === "number" ? error.code : undefined
        );
      const result = objectSchema.parse(envelope.result);
      if (result.resultType === "input_required")
        throw new RpcError(
          "The server needs interactive input. No continuation has been authorized.",
          status
        );
      outcome = "complete";
      return result;
    } catch (error) {
      if (observed === null)
        observed = {
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Request failed",
        };
      throw error;
    } finally {
      this.trace.push({
        sequence: this.trace.length + 1,
        at: new Date(start).toISOString(),
        method,
        request: redact(request),
        response: redact(observed),
        status,
        bytes,
        durationMs: Date.now() - start,
        direction: "client-server",
        outcome,
      });
    }
  }
  async discover(): Promise<Report> {
    const report: Report = {
      format: "mcp-app-validator/report/v1",
      coreVersion: VERSION,
      createdAt: new Date().toISOString(),
      target: displayTarget(this.target),
      protocolVersion: "unknown",
      serverInfo: {},
      capabilities: {},
      tools: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      findings: [],
      trace: this.trace,
      complete: true,
      elapsedMs: 0,
      mode: "live",
    };
    const failures: ReturnType<typeof finding>[] = [];
    try {
      let server: JsonObject;
      try {
        server = await this.rpc("server/discover");
        if (
          !Array.isArray(server.supportedVersions) ||
          !server.supportedVersions.includes("2026-07-28")
        )
          throw new RpcError(
            "The server did not advertise a supported modern protocol.",
            0,
            -32601
          );
        report.serverInfo =
          asObject(
            asObject(server._meta)?.["io.modelcontextprotocol/serverInfo"]
          ) ??
          asObject(server.serverInfo) ??
          {};
      } catch (error) {
        if (
          !(error instanceof RpcError) ||
          ![-32601, -32022].includes(error.code ?? 0)
        )
          throw error;
        this.state.protocolVersion = "2025-11-25";
        server = await this.rpc("initialize", {
          protocolVersion: this.state.protocolVersion,
          capabilities: {
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html;profile=mcp-app"],
              },
            },
          },
          clientInfo: { name: "MCP App Validator", version: VERSION },
        });
        if (
          typeof server.protocolVersion !== "string" ||
          !PROTOCOLS.some((v) => v === server.protocolVersion)
        )
          throw new RpcError(
            "Server selected an unsupported protocol version."
          );
        this.state.protocolVersion = server.protocolVersion;
        report.serverInfo = asObject(server.serverInfo) ?? {};
        await this.rpc("notifications/initialized", {}, true);
      }
      report.protocolVersion = this.state.protocolVersion;
      report.capabilities = asObject(server.capabilities) ?? {};
      for (const [capability, method, key] of [
        ["tools", "tools/list", "tools"],
        ["resources", "resources/list", "resources"],
        ["resources", "resources/templates/list", "resourceTemplates"],
        ["prompts", "prompts/list", "prompts"],
      ] as const) {
        if (!(capability in report.capabilities)) continue;
        try {
          const seen = new Set<string>();
          let cursor: string | undefined;
          for (let page = 0; page < LIMITS.pages; page++) {
            if (Date.now() - this.started > LIMITS.runMs)
              throw new RpcError("Discovery time budget reached.");
            const result = await this.rpc(method, cursor ? { cursor } : {});
            const entries = result[key];
            if (!Array.isArray(entries))
              throw new RpcError(`Expected ${key} array.`);
            if (
              report.tools.length +
                report.resources.length +
                report.prompts.length +
                report.resourceTemplates.length +
                entries.length >
              LIMITS.inventory
            )
              throw new RpcError("Inventory budget reached.");
            if (key === "tools")
              report.tools.push(...entries.map((v) => toolSchema.parse(v)));
            else if (key === "resources")
              report.resources.push(
                ...entries.map((v) => resourceSchema.parse(v))
              );
            else if (key === "prompts")
              report.prompts.push(...entries.map((v) => promptSchema.parse(v)));
            else
              report.resourceTemplates.push(
                ...entries.map((v) => objectSchema.parse(v))
              );
            if (result.nextCursor === undefined) break;
            if (
              typeof result.nextCursor !== "string" ||
              seen.has(result.nextCursor) ||
              page === LIMITS.pages - 1
            )
              throw new RpcError(
                "Pagination is invalid, repeated, or exceeds the page budget."
              );
            cursor = result.nextCursor;
            seen.add(cursor);
          }
        } catch (error) {
          if (
            method === "resources/templates/list" &&
            error instanceof RpcError &&
            error.code === -32601
          )
            continue;
          report.complete = false;
          failures.push(
            finding(
              "MCP-DISCOVERY-003",
              method,
              "blocked",
              error instanceof Error
                ? error.message.slice(0, 500)
                : "List failed."
            )
          );
        }
      }
    } catch (error) {
      report.complete = false;
      failures.push(
        finding(
          error instanceof RpcError && [401, 403].includes(error.status)
            ? "MCP-AUTH-001"
            : "MCP-DISCOVERY-003",
          "connection",
          "blocked",
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Connection failed."
        )
      );
    }
    report.elapsedMs = Date.now() - this.started;
    report.findings = [...evaluate(report), ...failures];
    return report;
  }
}
