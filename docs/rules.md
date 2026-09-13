# Checks, evidence, and limits — core 0.1.0

Each finding has a stable rule ID, subject, outcome, basis, severity, evidence, recommendation, source, and attribution. Outcomes are `pass`, `fail`, `warning`, `not-tested`, `not-applicable`, or `blocked`. A blocked runner is not proof that the server violates MCP. No aggregate score hides missing coverage.

The Apps reference is pinned to [ext-apps specification commit 6d9bdc7](https://github.com/modelcontextprotocol/ext-apps/blob/6d9bdc7babf275b759225aa722cbf5510c4c6021/specification/draft/apps.mdx). Core protocol references follow the actual selected version at [the official MCP specification](https://modelcontextprotocol.io/specification/).

| Rule group | What is checked | Evidence limit |
| --- | --- | --- |
| MCP-DISCOVERY-001/002/003 | Selected version, unique inventory IDs, advertised list completion | Only supported transports and bounded pages |
| MCP-CONTRACT-001/002 | JSON Schema 2020-12 structure using official meta-schemas | External refs, complex regexes, and budgets may block evaluation |
| MCP-CONTRACT-003/004 | Returned structured content and exact proposed arguments against schema | Only explicitly executed/proposed calls; formats are annotations |
| MCP-WIRE-001/002 | Modern result discriminators, cache scope and TTL | Selected 2026-07-28 operations only |
| MCP-QUALITY-001/002 | Descriptions and total discovery payload budget | HelloMCP recommendations, not specification requirements |
| HOST-SCHEMA-001 | Root schema composition that can affect host import | Advisory; valid composition is not marked invalid MCP |
| APP-RESOURCE-001/002 | Standard App linkage, matching HTML content and MIME | Declaration/read is separate from rendering |
| APP-RESOURCE-003/004 | Effective CSP metadata and tool visibility | Controlled host has a stricter network policy; native enforcement untested |
| APP-LIFECYCLE-001/002 | App initialization and result notification delivery | Emitted by an observed interactive host journey |
| APP-DELIVERY-001/002 | Context updates and conversation message acceptance | Handler acknowledgment does not prove a model read the data |
| APP-LAYOUT-001 | Requested and allocated dimensions | Observation; requires layout/interaction review |
| MCP-AUTH-001 | Authorization blocked the current inspection | Local automatic OAuth is outside this core |
| HOST-NATIVE-001 | Explicit native-host coverage gap | Never inferred from a controlled AppBridge pass |

The actual implementation is in [src/rules.ts](../src/rules.ts). Unsupported or ambiguous conditions retain partial evidence. Rule coverage will expand through reviewed fixtures; this is not the official MCP conformance suite and is not exhaustive.

Runner budgets: 15 seconds per request, 60 seconds for discovery, 20 pages per list, 1,000 total inventory entries, 4 MiB per response, 1 MiB per request, 500 trace events, and an 8 MiB aggregate response budget checked before a new request. DNS resolution has a five-second deadline. Schema evaluation bounds depth and node count, rejects external refs, and blocks complex regular expressions. These limits are configurable source policy, not MCP limits. Long trace strings are truncated and credential-shaped fields are redacted.

The local renderer accepts self-contained HTML. The hosted collector can bundle up to 256 declared HTTPS JavaScript/CSS assets with a 16 MiB dependency budget. Direct networking, CSS imports, external images/fonts, bare module imports, and nested frames can remain blocked by the stricter preview profile. Preserve original HTML separately and report these as runner limitations. Never convert an altered preview into native-host conformance evidence.
