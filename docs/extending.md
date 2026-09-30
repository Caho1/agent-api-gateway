# Add any HTTPS API

No provider adapter is required. Read the upstream's API documentation and configure:

- A fixed HTTPS origin (for example `https://api.example.com`)
- Header or query credential name and optional public prefix, or `none`
- Safe caller header names and timeout/request/response limits

Supply the upstream key only to the administrator's credential field. Create a separate service-level grant with a short expiry and appropriate request quotas. No route/method registration is required. The agent sends upstream parameters directly, for example `query: {page: "1"}` or `body: {items: [...]}`. There is no `secUid`, post-ID allowlist, named operation mapping, automatic pagination or statistics normalization in the gateway.

Whole-service authorization includes upstream writes and deletion, subject to the upstream key’s own permissions. Transport checks constrain destinations, not the semantics of query/body data. If an upstream endpoint accepts another URL, code, SQL or account/resource ID, the administrator must assess that endpoint and its credential scope. A generic relay cannot establish provider-specific ownership.

For multipart, form-encoded or other binary bodies, encode the complete body as `bodyBase64` and allow the appropriate `content-type` header. Streaming, WebSockets, compressed upstream responses, redirects and cookie sessions are unsupported. API signing schemes requiring dynamic secret-derived signatures are not implemented; do not work around this by exposing the key to the agent.

Existing legacy restrictions stay in force until explicitly converted through the dedicated management action; creating a new service-level grant alone does not bypass them.

For multiple upstream keys or origins, create distinct service IDs. Editing an existing service revokes all grants referencing it. Use a new ID when staging configuration without interrupting an existing service.
