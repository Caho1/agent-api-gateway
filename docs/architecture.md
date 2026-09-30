# Architecture

Agent → HTTPS reverse proxy → local Node gateway → pinned HTTPS upstream.

1. Admin saves a service origin, credential injection, safe caller header list, route policy and resource limits
2. Admin explicitly creates an expiring grant over selected service IDs and method/routes
3. Agent sends the upstream method/path/query/body to `POST /v1/relay` with its gateway bearer token
4. The gateway checks input and service policy locally, then atomically reserves grant/global quotas and rate limit
5. Relay resolves and validates every DNS answer, pins the socket, injects the provider credential and makes exactly one request
6. It bounds and screens the response, returning its unmodified JSON structure plus exact raw bytes, or a base64 body
7. The gateway updates minimal audit state; failures remain charged to the request quota

There is no adapter registry or provider-specific business transformation. Adding a service is configuration. `src/model.ts` validates config and requests; `src/path-policy.ts` handles canonical routes and destination policy; `src/relay.ts` owns transport; `src/store.ts` owns transactional grants and quotas; `src/settings.ts` owns private config/keys; `src/admin-auth.ts` and `src/admin.ts` own the management plane.

`schemaVersion: 2` prevents old account/operation grants from gaining new authority. Existing SQLite tables remain; relay rate and detail tables are additive. The old config remains unchanged on disk until an explicit admin save; old account details are retained in `legacyAccounts` in a saved v2 config.

PM2 manages the one application worker in foreground `pm2-runtime`, underneath the hardened DynamicUser systemd unit. Caddy remains a separate native systemd service. Releases are immutable and state is external; publishing gates a switch on checks and then checks the exact release's health. See [deployment](deployment.md).
