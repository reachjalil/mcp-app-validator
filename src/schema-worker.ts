import { parentPort } from "node:worker_threads";
import { validateJsonSchema } from "./rules.js";
import { jsonSchema } from "./contracts.js";
import { z } from "zod";

// Load trusted schema machinery before asking the parent for untrusted input.
parentPort?.once("message", (message) => {
  const { schema, value } = z
    .strictObject({ schema: jsonSchema, value: jsonSchema })
    .parse(message);
  parentPort?.postMessage(validateJsonSchema(schema, value, true));
});
parentPort?.postMessage({ type: "ready" });
