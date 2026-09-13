# MCP App Validator

**Inspect an MCP server. Exercise its Apps. Understand what to fix.**

[Try the full hosted workspace at **hellomcp.ai/validator**](https://hellomcp.ai/validator) · [Rules and coverage](docs/rules.md) · [Security](SECURITY.md)

MCP App Validator is HelloMCP's open validation engine and minimal local inspector. Give it an MCP URL to inspect tools, resources, prompts, exact schemas, App mappings, protocol responses, and measured request stages. Open an App in a controlled host to inspect tool calls, model-context updates, conversation messages, and requested versus allocated frame sizes.

A passing check records specific evidence. It is **not an official certification** or a claim that a native ChatGPT, Claude, or other host accepted the App.

## Run locally

Requires Node.js 22.12 or later and npm. This repository is runnable from source; it does not depend on an unpublished npm release.

```sh
git clone https://github.com/reachjalil/mcp-app-validator.git
cd mcp-app-validator
npm ci
npm run build
node dist/cli.js inspect https://hellomcp.ai/acid --output report.json
node dist/cli.js serve
```

Open the exact loopback URL printed by `serve`. It contains a one-time browser bootstrap fragment for the local API. The server binds only to `127.0.0.1`. Keep the terminal running while using the inspector.

```sh
# Explicitly allow loopback HTTP for your own development server.
node dist/cli.js serve --allow-local --port 6278
node dist/cli.js inspect http://127.0.0.1:3000/mcp --allow-local

# Private credentials are read from the environment, never from CLI flags.
# Set MCP_VALIDATOR_TOKEN in your environment before starting the inspector.

# Re-evaluate discovery evidence without contacting the target.
node dist/cli.js replay report.json --format html --output report.html
npm test
```

CLI exit codes: `0` for complete discovery without observed failing checks, `1` when checks fail, and `2` when discovery is incomplete or the command cannot finish. Code `0` does not mean untested App behavior passed. Inspect each finding's outcome and coverage.

The local UI reads selected resources, validates and reviews exact tool arguments, executes only user-requested calls, shows raw results, and hosts self-contained MCP App HTML. It does not automatically invoke tools during discovery. A response lost after execution has an unknown outcome: investigate before creating a new call.

## Open core and hosted product

| In this MIT-licensed repository | In the HelloMCP hosted workspace |
| --- | --- |
| Version-aware HTTP collector and findings | Branded Astro/React investigation workspace |
| JSON Schema checks and readable rule IDs | Managed OAuth and encrypted credential vault |
| Report schema, raw protocol traces, JSON/HTML reports | Private saved investigations and comparisons |
| Minimal local inspector and controlled App bridge | Reviewed, revocable public report sharing |
| Local SSRF-resistant URL collector and regression tests | Isolated egress service and dependency bundling |
| Published test limits and coverage | Service operation, abuse controls, account integration |

The same core produces hosted protocol findings. Account, OAuth, hosted orchestration, and website source are not part of this repository. Contributions to the core improve the checks available to everyone. [Try the full experience online](https://hellomcp.ai/validator).

## Supported transport and evidence

The collector starts with MCP `2026-07-28` discovery. On an explicit unsupported-version or method response, it negotiates the legacy initialization flow for `2025-11-25`, `2025-06-18`, or `2025-03-26`. JSON and bounded SSE responses are supported. Authentication failures never trigger an anonymous retry.

The App bridge uses the official `@modelcontextprotocol/ext-apps` library. Its controlled scenarios advertise standard capabilities, omit conversation messaging, or reject the first message. Native-host evidence remains separate. The hosted Acid Test companion is available at [hellomcp.ai/acid/about](https://hellomcp.ai/acid/about).

This initial release does not claim exhaustive protocol conformance. Stdio process launching, legacy HTTP+SSE transport, elicitation/sampling continuations, automatic OAuth in the local UI, arbitrary remote schema bundles, browser automation, statistical load benchmarks, and native-host certification are outside the current runner. Resource templates are inventoried; arbitrary template expansion is not automated. External asset bundling is hosted-only. See [the exact checks and budgets](docs/rules.md).

## Contributing

Keep rules version-aware and attach evidence, a source, and an actionable recommendation. Distinguish specification failures from compatibility observations, recommendations, blocked tests, and untested behavior. Include a regression fixture for changed behavior; never count a tool declaration as a completed App journey.

Run `npm test` and `npm run build`. Do not add target credentials, personal investigation reports, or copied private service code. [HelloMCP](https://hellomcp.ai) maintains this project.
