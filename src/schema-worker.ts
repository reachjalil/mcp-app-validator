import { parentPort, workerData } from "node:worker_threads";
import { validateJsonSchema } from "./rules.js";
import { jsonSchema } from "./contracts.js";
const schema = jsonSchema.parse(workerData.schema);
const value = jsonSchema.parse(workerData.value);
parentPort?.postMessage(validateJsonSchema(schema, value, true));
