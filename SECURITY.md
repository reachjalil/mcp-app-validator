# Security and report handling

The inspector connects to untrusted MCP servers and can render their code. Use servers you intend to inspect. Discovery performs metadata requests; tool execution requires a separate action. Tool annotations are untrusted declarations, not proof of safety or authorization. A user-requested call may change external systems.

The Node collector resolves every hostname and rejects the request if any resolved address is private, reserved, or otherwise non-public. It dials the validated literal IP while preserving original TLS hostname verification and SNI. It accepts public HTTPS on port 443, rejects embedded credentials, and never follows redirects. Explicit local mode admits exact loopback HTTP only. DNS and requests have deadlines and responses have byte limits.

The local UI binds to loopback with an exact Host check, an unpredictable API token, and an exact Origin requirement. It does not launch processes from a target URL or implement remote stdio execution. An App runs in an opaque sandbox with scripts but without same-origin authority, top navigation, popups, forms, or downloads. Its initial document blocks direct subresource network requests through CSP. As with browser iframe sandboxes generally, this is not a complete malware-analysis environment; do not render hostile code with sensitive tool results. Report payloads can contain personal or proprietary data.

Traces mask credential-named fields and Bearer strings. This is a best-effort redaction filter, not a guarantee that arbitrary private content is absent. Inspect exports before publishing them. The local JSON report is never automatically uploaded. The hosted product has separate account and sharing controls.

Do not file target credentials or private report payloads in a public issue. Report exploitable issues through GitHub's private vulnerability reporting when enabled. Include a fictional minimal reproduction and affected version.
