import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type Json,
  type JsonObject,
  type Tool,
  toJson,
  uiMetadata,
  objectSchema,
} from "./contracts.js";

export interface HostEvent {
  method: string;
  payload: Json;
  outcome: "accepted" | "rejected" | "observed";
}
export interface HostOptions {
  frame: HTMLIFrameElement;
  html: string;
  tool: Tool;
  arguments: JsonObject;
  result: JsonObject;
  tools: Tool[];
  profile: "standard" | "no-message" | "reject-message";
  theme: "light" | "dark";
  onEvent(event: HostEvent): void;
  callTool(name: string, args: JsonObject): Promise<JsonObject>;
}
export function sandboxDocument(html: string): string {
  // Enforced first, independently of target markup. Opaque origin, no storage,
  // network, navigation, popups, downloads, or executable parent-page content.
  // External dependencies must first be bundled by an isolated collector.
  const csp =
    "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-width:0}body{overflow-wrap:anywhere}</style>${html}`;
}
export async function mountApp(options: HostOptions): Promise<() => void> {
  const { frame, onEvent } = options;
  const capabilities = {
    serverTools: {},
    updateModelContext: { text: {}, structuredContent: {} },
    ...(options.profile === "no-message" ? {} : { message: { text: {} } }),
    logging: {},
  };
  const bridge = new AppBridge(
    null,
    { name: "HelloMCP Validator controlled host", version: "0.1.0" },
    capabilities,
    {
      hostContext: {
        theme: options.theme,
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: {
          width: frame.clientWidth || 680,
          height: Number(frame.height) || 420,
        },
      },
    }
  );
  let rejected = false;
  bridge.oncalltool = async (params) => {
    const tool = options.tools.find((t) => t.name === params.name);
    const visibility = tool ? uiMetadata(tool).visibility : undefined;
    if (!tool || (Array.isArray(visibility) && !visibility.includes("app")))
      throw new Error("This tool is not available to this App.");
    const args = objectSchema.parse(params.arguments ?? {});
    onEvent({
      method: "tools/call",
      payload: toJson(params),
      outcome: "observed",
    });
    return CallToolResultSchema.parse(
      await options.callTool(params.name, args)
    );
  };
  bridge.onupdatemodelcontext = async (params) => {
    onEvent({
      method: "ui/update-model-context",
      payload: toJson(params),
      outcome: "accepted",
    });
    return {};
  };
  bridge.onmessage = async (params) => {
    if (
      options.profile === "no-message" ||
      (options.profile === "reject-message" && !rejected)
    ) {
      rejected = true;
      onEvent({
        method: "ui/message",
        payload: toJson(params),
        outcome: "rejected",
      });
      return { isError: true };
    }
    onEvent({
      method: "ui/message",
      payload: toJson(params),
      outcome: "accepted",
    });
    return {};
  };
  bridge.onsizechange = (params) =>
    onEvent({
      method: "ui/notifications/size-changed",
      payload: {
        ...params,
        allocatedWidth: frame.clientWidth,
        allocatedHeight: frame.clientHeight,
      },
      outcome: "observed",
    });
  bridge.onloggingmessage = (params) =>
    onEvent({
      method: "notifications/message",
      payload: toJson(params),
      outcome: "observed",
    });
  bridge.oninitialized = () => {
    onEvent({
      method: "ui/initialize",
      payload: { profile: options.profile },
      outcome: "accepted",
    });
    void (async () => {
      await bridge.sendToolInput({ arguments: options.arguments });
      onEvent({
        method: "ui/notifications/tool-input",
        payload: options.arguments,
        outcome: "accepted",
      });
      await bridge.sendToolResult(CallToolResultSchema.parse(options.result));
      onEvent({
        method: "ui/notifications/tool-result",
        payload: options.result,
        outcome: "accepted",
      });
    })().catch(() =>
      onEvent({
        method: "ui/notifications/tool-result",
        payload: { error: "The App bridge rejected result delivery." },
        outcome: "rejected",
      })
    );
  };
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  if (!frame.contentWindow) throw new Error("App frame is unavailable.");
  const transport = new PostMessageTransport(
    frame.contentWindow,
    frame.contentWindow
  );
  await bridge.connect(transport);
  frame.srcdoc = sandboxDocument(options.html);
  const observer = new ResizeObserver(() => {
    if (frame.clientWidth <= 0 || frame.clientHeight <= 0) return;
    const context = {
      theme: options.theme,
      displayMode: "inline" as const,
      availableDisplayModes: ["inline" as const],
      containerDimensions: {
        width: frame.clientWidth,
        height: frame.clientHeight,
      },
    };
    bridge.setHostContext(context);
    onEvent({
      method: "ui/notifications/host-context-changed",
      payload: context,
      outcome: "observed",
    });
  });
  observer.observe(frame);

  return () => {
    observer.disconnect();
    void transport.close();
    frame.srcdoc = "";
  };
}
