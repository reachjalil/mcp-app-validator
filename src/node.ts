import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import ipaddr from "ipaddr.js";
import { type Fetcher, LIMITS } from "./contracts.js";

export function publicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (
      ip.kind() === "ipv6" &&
      ip instanceof ipaddr.IPv6 &&
      ip.isIPv4MappedAddress()
    )
      ip = ip.toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export async function resolveTarget(input: string, local = false) {
  const url = new URL(input);
  if (url.username || url.password || url.hash || input.length > 4096)
    throw new Error(
      "Use a bounded URL without embedded credentials or fragments."
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (
    !(url.protocol === "https:" && (!url.port || url.port === "443")) &&
    !(local && loopback && url.protocol === "http:")
  )
    throw new Error(
      "Hosted targets require HTTPS on port 443. Loopback HTTP is available only with explicit local mode."
    );
  if (
    !loopback &&
    ((!hostname.includes(".") && !ipaddr.isValid(hostname)) ||
      /\.(?:localhost|local|internal|test|invalid|example)\.?$/i.test(hostname))
  )
    throw new Error("This hostname is not a public target.");
  let timeout: ReturnType<typeof setTimeout>;
  const addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("DNS resolution timed out.")),
        5000
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !(
          publicAddress(a.address) ||
          (local && loopback && ["127.0.0.1", "::1"].includes(a.address))
        )
    )
  )
    throw new Error(
      "The target resolves to a private, reserved, or unavailable address."
    );
  return { url, address: addresses[0].address, family: addresses[0].family };
}
export function createPinnedFetch(options: { local?: boolean } = {}): Fetcher {
  return async function pinnedFetch(input, init) {
    const { url, address, family } = await resolveTarget(input, options.local);
    if (init.method && !["GET", "POST", "DELETE"].includes(init.method))
      throw new Error("Unsupported outbound method.");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      if (
        [
          "authorization",
          "content-type",
          "accept",
          "mcp-protocol-version",
          "mcp-session-id",
          "mcp-method",
          "mcp-name",
        ].includes(k)
      )
        headers[k] = v;
    });
    headers.host = url.host;
    headers["accept-encoding"] = "identity";
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body && Buffer.byteLength(body) > LIMITS.requestBytes)
      throw new Error("Outbound request exceeds the runner limit.");
    if (body) headers["content-length"] = String(Buffer.byteLength(body));
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(LIMITS.requestMs)])
      : AbortSignal.timeout(LIMITS.requestMs);
    return await new Promise<Response>((resolve, reject) => {
      // The socket dials the validated literal address. TLS still validates the
      // original hostname with SNI. There is no second DNS lookup or redirect.
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          hostname: address,
          family,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          servername: url.hostname,
          path: url.pathname + url.search,
          method: init.method ?? "GET",
          headers,
          agent: false,
          signal,
          rejectUnauthorized: true,
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(incoming.headers))
            if (
              v &&
              !["set-cookie", "transfer-encoding", "connection"].includes(k)
            )
              responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
          let bytes = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              incoming.on("data", (chunk: Buffer) => {
                bytes += chunk.byteLength;
                if (bytes > LIMITS.responseBytes) {
                  incoming.destroy(
                    new Error("Response exceeds the runner byte limit.")
                  );
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
              });
              incoming.on("end", () => controller.close());
              incoming.on("error", (error) => controller.error(error));
            },
            cancel() {
              incoming.destroy();
              request.destroy();
            },
          });
          const status = incoming.statusCode ?? 502;
          if ([204, 205, 304].includes(status)) {
            incoming.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
          } else
            resolve(new Response(stream, { status, headers: responseHeaders }));
        }
      );
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  };
}

/** Bound trusted startup separately from evaluating untrusted input. */
export async function validateIsolated(
  schema: import("./contracts.js").Json,
  value: import("./contracts.js").Json
) {
  const { Worker } = await import("node:worker_threads");
  const { z } = await import("zod");
  const resultSchema = z.strictObject({
    valid: z.boolean(),
    blocked: z.boolean(),
    detail: z.string(),
  });
  return new Promise<import("./rules.js").SchemaCheck>((resolve) => {
    const worker = new Worker(new URL("./schema-worker.js", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 48, stackSizeMb: 2 },
    });
    let ready = false;
    let settled = false;
    let deadline = setTimeout(() => {
      finish({
        valid: false,
        blocked: true,
        detail:
          "The isolated schema worker could not start within five seconds.",
      });
    }, 5000);
    function finish(result: import("./rules.js").SchemaCheck) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void worker.terminate();
      resolve(result);
    }
    worker.on("message", (message) => {
      if (settled) return;
      if (!ready) {
        if (
          !z.strictObject({ type: z.literal("ready") }).safeParse(message)
            .success
        ) {
          finish({
            valid: false,
            blocked: true,
            detail: "Invalid isolated validator readiness response.",
          });
          return;
        }
        ready = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          finish({
            valid: false,
            blocked: true,
            detail: "Isolated schema evaluation exceeded two seconds.",
          });
        }, 2000);
        // Untrusted input is delivered only after trusted imports and setup.
        worker.postMessage({ schema, value });
        return;
      }
      const result = resultSchema.safeParse(message);
      finish(
        result.success
          ? result.data
          : {
              valid: false,
              blocked: true,
              detail: "Invalid isolated validator response.",
            }
      );
    });
    worker.once("error", () => {
      finish({
        valid: false,
        blocked: true,
        detail: "The isolated schema worker could not complete.",
      });
    });
    worker.once("exit", () => {
      finish({
        valid: false,
        blocked: true,
        detail: "The isolated schema worker stopped before completion.",
      });
    });
  });
}
