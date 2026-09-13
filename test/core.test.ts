import { test } from "node:test";
import assert from "node:assert/strict";
import {
  McpConnection,
  boundedBody,
  inspectResource,
  inspectToolResult,
  validateJsonSchema,
  redact,
  reportSchema,
  type Fetcher,
  type JsonObject,
} from "../src/index.js";
import { publicAddress, resolveTarget } from "../src/node.js";

const tool = {
  name: "render",
  description: "Render a fictional diagnostic",
  inputSchema: {
    type: "object",
    properties: { n: { type: "integer" } },
    required: ["n"],
    additionalProperties: false,
  },
  _meta: { ui: { resourceUri: "ui://test/app" } },
};
function fixture(
  handler: (method: string, params: JsonObject) => JsonObject | Response
): Fetcher {
  return async (_url, init) => {
    const request = JSON.parse(String(init.body));
    const result = handler(request.method, request.params);
    return result instanceof Response
      ? result
      : Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
}
function modern(method: string): JsonObject {
  if (method === "server/discover")
    return {
      supportedVersions: ["2026-07-28"],
      serverInfo: { name: "Fixture", version: "1" },
      capabilities: { tools: {}, resources: {} },
    };
  if (method === "tools/list")
    return {
      resultType: "complete",
      ttlMs: 100,
      cacheScope: "public",
      tools: [tool],
    };
  if (method === "resources/list")
    return {
      resultType: "complete",
      ttlMs: 100,
      cacheScope: "public",
      resources: [
        {
          name: "App",
          uri: "ui://test/app",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    };
  return {
    resultType: "complete",
    ttlMs: 100,
    cacheScope: "public",
    resourceTemplates: [],
  };
}
test("discovery negotiates modern protocol without executing a tool", async () => {
  const methods: string[] = [];
  const report = await new McpConnection(
    "https://mcp.example.org",
    fixture((m, p) => {
      methods.push(m);
      assert.equal(p._meta && typeof p._meta, "object");
      return modern(m);
    })
  ).discover();
  assert.equal(report.complete, true);
  assert.equal(report.tools.length, 1);
  assert.ok(!methods.includes("tools/call"));
  assert.ok(!report.findings.some((f) => f.outcome === "fail"));
  assert.equal(
    report.findings.find((f) => f.id === "APP-LIFECYCLE-001")?.outcome,
    "not-tested"
  );
  assert.doesNotThrow(() => reportSchema.parse(report));
});
test("legacy fallback is explicit and initializes the selected session", async () => {
  const calls: string[] = [];
  const report = await new McpConnection(
    "https://mcp.example.org",
    async (_url, init) => {
      const q = JSON.parse(String(init.body));
      calls.push(q.method);
      if (q.method === "server/discover")
        return Response.json({
          jsonrpc: "2.0",
          id: q.id,
          error: { code: -32601, message: "Method not found" },
        });
      if (q.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: q.id,
            result: {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "Legacy", version: "1" },
              capabilities: {},
            },
          },
          { headers: { "mcp-session-id": "session-1" } }
        );
      assert.equal(
        new Headers(init.headers).get("mcp-session-id"),
        "session-1"
      );
      return new Response(null, { status: 202 });
    }
  ).discover();
  assert.equal(report.protocolVersion, "2025-11-25");
  assert.equal(report.complete, true);
  assert.deepEqual(calls, [
    "server/discover",
    "initialize",
    "notifications/initialized",
  ]);
});
test("authorization failure never triggers downgrade or anonymous retry", async () => {
  let calls = 0;
  const r = await new McpConnection("https://mcp.example.org", async () => {
    calls++;
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  }).discover();
  assert.equal(calls, 1);
  assert.equal(r.complete, false);
  assert.ok(
    r.findings.some((f) => f.id === "MCP-AUTH-001" && f.outcome === "blocked")
  );
});
test("repeating pagination preserves partial inventory and blocks coverage", async () => {
  const r = await new McpConnection(
    "https://mcp.example.org",
    fixture((m) =>
      m === "tools/list" ? { ...modern(m), nextCursor: "repeat" } : modern(m)
    )
  ).discover();
  assert.equal(r.complete, false);
  assert.equal(r.tools.length, 2);
  assert.ok(
    r.findings.some((f) => f.id === "MCP-DISCOVERY-002" && f.outcome === "fail")
  );
});
test("ambiguous RPC result/error is rejected", async () => {
  const c = new McpConnection("https://mcp.example.org", async () =>
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: 1, message: "bad" },
    })
  );
  await assert.rejects(c.rpc("tools/list"), /exactly one/);
});
test("SSE matches fragmented JSON-RPC response and cancels the open stream", async () => {
  let cancelled = false;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('event: message\r\ndata: {"jsonrpc":"2.0","id":7,'));
      c.enqueue(enc.encode('"result":{"ok":true}}\r\n\r\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const r = await boundedBody(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    7
  );
  assert.equal((r.value as JsonObject).id, 7);
  assert.equal(cancelled, true);
});
test("server-initiated requests cannot cause automatic client effects", async () => {
  await assert.rejects(
    boundedBody(
      new Response(
        'data: {"jsonrpc":"2.0","id":"s1","method":"sampling/createMessage"}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      ),
      1
    ),
    /no input was authorized/
  );
});
test("JSON Schema meta-validation and exact instance validation", () => {
  assert.equal(validateJsonSchema({ type: "potato" }).valid, false);
  assert.equal(validateJsonSchema(tool.inputSchema, { n: 1 }).valid, true);
  assert.equal(validateJsonSchema(tool.inputSchema, { n: "1" }).valid, false);
  assert.equal(
    validateJsonSchema(tool.inputSchema, { n: 1, extra: true }).valid,
    false
  );
  assert.equal(
    validateJsonSchema({ $ref: "https://external.example/schema" }).blocked,
    true
  );
  assert.equal(
    validateJsonSchema({ type: "string", pattern: "(a+)+$" }, "aaaa").blocked,
    true
  );
  assert.equal(validateJsonSchema(false, {}).valid, false);
});
test("resource and output failures retain distinct evidence", () => {
  assert.equal(
    inspectResource("ui://test/app", { contents: [] })[0].outcome,
    "fail"
  );
  assert.equal(
    inspectResource("ui://test/app", {
      contents: [
        {
          uri: "ui://test/app",
          mimeType: "text/html;profile=mcp-app",
          text: "<h1>Test</h1>",
        },
      ],
    })[0].outcome,
    "pass"
  );
  assert.equal(
    inspectToolResult(
      { ...tool, outputSchema: { type: "object", required: ["ok"] } },
      { structuredContent: {} }
    )[0].outcome,
    "fail"
  );
});
test("redaction masks auth secrets and bearer strings", () => {
  assert.deepEqual(
    redact({
      authorization: "secret",
      nested: { access_token: "hidden" },
      text: "Bearer hidden",
    }),
    {
      authorization: "[redacted]",
      nested: { access_token: "[redacted]" },
      text: "Bearer [redacted]",
    }
  );
});
test("egress rejects private, reserved, mapped, rebinding-prone and credential URLs", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.1.2",
    "192.168.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("1.1.1.1"), true);
  for (const url of [
    "http://example.org/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://a:secret@example.org/mcp",
    "https://example.org:8443/mcp",
    "https://metadata.internal/mcp",
  ])
    await assert.rejects(resolveTarget(url));
  assert.equal(
    (await resolveTarget("http://127.0.0.1:9000/mcp", true)).address,
    "127.0.0.1"
  );
});

test("modern resource reads put the exact URI in Mcp-Name", async () => {
  const c = new McpConnection("https://mcp.example.org", async (_url, init) => {
    assert.equal(new Headers(init.headers).get("mcp-name"), "ui://test/app");
    const q = JSON.parse(String(init.body));
    return Response.json({
      jsonrpc: "2.0",
      id: q.id,
      result: { resultType: "complete", contents: [] },
    });
  });
  await c.rpc("resources/read", { uri: "ui://test/app" });
});
test("ordinary complex schemas remain inspectable and formats are annotations", () => {
  assert.equal(
    validateJsonSchema({ type: "string", pattern: "(a+)+$" }).valid,
    true
  );
  assert.equal(
    validateJsonSchema({ type: "string", format: "email" }, "not-an-email")
      .valid,
    true
  );
});
test("isolated evaluation terminates pathological patterns", async () => {
  const { validateIsolated } = await import("../dist/node.js");
  assert.equal(
    (
      await validateIsolated(
        { type: "string", pattern: "^[^@]+@[^@]+\\.[^@]+$" },
        "fiction@example.org"
      )
    ).valid,
    true
  );
  const start = Date.now();
  const result = await validateIsolated(
    { type: "string", pattern: "(a+)+$" },
    "a".repeat(40000) + "!"
  );
  assert.equal(result.blocked, true);
  assert.ok(Date.now() - start < 6000);
});

test("isolated workers load trusted machinery before receiving input", {
  timeout: 10000,
}, async () => {
  const { Worker } = await import("node:worker_threads");
  const { once } = await import("node:events");
  const worker = new Worker(
    new URL("../dist/schema-worker.js", import.meta.url)
  );
  try {
    const [ready] = await once(worker, "message");
    assert.deepEqual(ready, { type: "ready" });
    const response = once(worker, "message");
    worker.postMessage({
      schema: {
        type: "object",
        required: ["challenge"],
        properties: { challenge: { type: "string" } },
        additionalProperties: false,
      },
      value: { challenge: "startup-separated" },
    });
    const [result] = await response;
    assert.equal(result.valid, true);
    assert.equal(result.blocked, false);
  } finally {
    await worker.terminate();
  }
});
