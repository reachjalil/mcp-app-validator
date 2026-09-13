#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpConnection } from "./client.js";
import { createPinnedFetch } from "./node.js";
import {
  appUri,
  objectSchema,
  reportSchema,
  summary,
  type Report,
  type JsonObject,
} from "./contracts.js";
import {
  evaluate,
  inspectResource,
  inspectToolResult,
  validateJsonSchema,
} from "./rules.js";

const args = process.argv.slice(2),
  command = args[0] ?? "help";
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
function escape(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  );
}
function htmlReport(r: Report) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MCP App Validator report</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:20px}article{border-top:1px solid #ddd;padding:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>MCP App Validator</h1><p>${escape(r.target)} · ${escape(r.protocolVersion)} · ${escape(r.createdAt)}</p><p>${escape(JSON.stringify(summary(r)))}</p>${r.findings.map((f) => `<article><b>${escape(f.outcome)} · ${escape(f.title)}</b><p>${escape(f.subject)} — ${escape(f.evidence)}</p><p>${escape(f.recommendation)}</p></article>`).join("")}<p><a href="https://hellomcp.ai/validator">Try the hosted inspector at HelloMCP</a></p>`;
}
async function output(r: Report) {
  const text =
    flag("--format") === "html" ? htmlReport(r) : JSON.stringify(r, null, 2);
  if (flag("--output")) await writeFile(flag("--output")!, text);
  else process.stdout.write(`${text}\n`);
  process.exitCode = r.findings.some((f) => f.outcome === "fail")
    ? 1
    : r.complete
      ? 0
      : 2;
}
async function serve() {
  const access = randomBytes(32).toString("hex");
  const local = args.includes("--allow-local");
  let connection: McpConnection | undefined;
  let report: Report | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const address = server.address();
    const port =
      address && typeof address === "object" ? address.port : undefined;
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (req.method === "GET" && url.pathname === "/") {
      const ui = await readFile(
        new URL("../ui/index.html", import.meta.url),
        "utf8"
      );
      res.setHeader("content-type", "text/html");
      res.end(ui);
      return;
    }
    if (req.method === "GET" && url.pathname === "/host.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile(new URL("./host-browser.js", import.meta.url)));
      return;
    }
    const token = req.headers["x-validator-token"];
    if (
      typeof token !== "string" ||
      token.length !== access.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(access)) ||
      req.headers.origin !== `http://127.0.0.1:${port}`
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = "";
      for await (const c of req) {
        body += c;
        if (body.length > 1048576) throw new Error("Request too large");
      }
      const data = objectSchema.parse(JSON.parse(body || "{}"));
      let result: Report | JsonObject;
      if (url.pathname === "/inspect" && typeof data.url === "string") {
        connection = new McpConnection(
          data.url,
          createPinnedFetch({ local }),
          undefined,
          process.env.MCP_VALIDATOR_TOKEN
        );
        report = await connection.discover();
        result = report;
      } else if (
        url.pathname === "/call" &&
        connection &&
        report &&
        typeof data.name === "string" &&
        data.approved === true
      ) {
        const tool = report.tools.find((t) => t.name === data.name);
        if (!tool) throw new Error("Unknown tool");
        const input = objectSchema.parse(data.arguments);
        const valid = validateJsonSchema(tool.inputSchema, input);
        if (!valid.valid) throw new Error(valid.detail);
        result = await connection.rpc("tools/call", {
          name: tool.name,
          arguments: input,
        });
        report.findings.push(...inspectToolResult(tool, result));
      } else if (
        url.pathname === "/read" &&
        connection &&
        report &&
        typeof data.uri === "string" &&
        (report.resources.some((r) => r.uri === data.uri) ||
          report.tools.some((t) => appUri(t) === data.uri))
      ) {
        result = await connection.rpc("resources/read", { uri: data.uri });
        report.findings.push(...inspectResource(data.uri, result));
      } else throw new Error("Unknown operation or missing approval");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Operation failed",
        })
      );
    }
  });
  server.listen(Number(flag("--port") ?? 6278), "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object")
      process.stdout.write(
        `MCP App Validator: http://127.0.0.1:${address.port}/#${access}\nLocal only. Credentials come from MCP_VALIDATOR_TOKEN.\nHosted: https://hellomcp.ai/validator\n`
      );
  });
}
try {
  if (command === "inspect" && args[1])
    await output(
      await new McpConnection(
        args[1],
        createPinnedFetch({ local: args.includes("--allow-local") }),
        undefined,
        process.env.MCP_VALIDATOR_TOKEN
      ).discover()
    );
  else if ((command === "replay" || command === "report") && args[1]) {
    const report = reportSchema.parse(
      JSON.parse(await readFile(args[1], "utf8"))
    );
    report.mode = "replay";
    report.findings = evaluate(report);
    await output(report);
  } else if (command === "serve") await serve();
  else
    process.stdout.write(
      "MCP App Validator by HelloMCP\n\ninspect <https-url> [--format json|html] [--output file]\nserve [--port 6278] [--allow-local]\nreplay <report.json> [--format json|html]\n\nCredentials: MCP_VALIDATOR_TOKEN environment variable.\nhttps://hellomcp.ai/validator\n"
    );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Validator failed"}\n`
  );
  process.exitCode = 2;
}
