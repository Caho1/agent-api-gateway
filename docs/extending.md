# Add any HTTPS API

No provider adapter is required. Read the upstream's API documentation and configure:

- A fixed HTTPS origin (for example `https://api.example.com`)
- Header or query credential name and optional public prefix, or `none`
- Explicit allowed method/path routes; begin with exact read-only paths
- Safe caller header names and timeout/request/response limits

Supply the upstream key only to the administrator's credential field. Create a separate grant with a narrower route policy and short expiry. The agent sends upstream parameters directly, for example `query: {page: "1"}` or `body: {items: [...]}`. There is no `secUid`, post-ID allowlist, named operation mapping, automatic pagination or statistics normalization in the gateway.

Path policies constrain destinations, not the semantics of query/body data. If an upstream endpoint accepts another URL, code, SQL or account/resource ID, the administrator must assess that endpoint and its credential scope. A generic relay cannot establish provider-specific ownership.

For multipart, form-encoded or other binary bodies, encode the complete body as `bodyBase64` and allow the appropriate `content-type` header. Streaming, WebSockets, compressed upstream responses, redirects and cookie sessions are unsupported. API signing schemes requiring dynamic secret-derived signatures are not implemented; do not work around this by exposing the key to the agent.

For multiple upstream keys or origins, create distinct service IDs. Editing an existing service revokes all grants referencing it. Use a new ID when staging configuration without interrupting an existing service.
