# Security boundary

## Trusted parties

The administrator, gateway runtime/host, configured HTTPS upstream, TLS trust store and filesystem are trusted. Agent code and request input are untrusted. Run agents under a separate OS identity or host; same-user filesystem/process access bypasses this gateway. The public admin interface is sensitive and requires HTTPS (or an authenticated local SSH tunnel).

The gateway isolates provider keys, authenticates access to configured services, and constrains network destinations, request counts and sizes. New service-level grants do not impose per-route or per-method business policies. It does **not** validate business semantics, resource ownership, upstream billing costs or arbitrary URLs/SQL/scripts inside an upstream API request. Service access includes every API operation available to the configured upstream key, including writes and deletion. Use provider-scoped keys/OAuth for business permissions. Do not give an untrusted agent service access to an upstream credential that can proxy arbitrary URLs, echo credentials, execute code or perform unacceptable administrative actions.

## Transport

Services specify an HTTPS origin, without userinfo, path, query or fragment. Relative paths reject traversal, protocol-relative targets, backslashes, encoded separators/percent nesting, controls and ambiguous segments. Legacy route policies still match canonical paths by exact/prefix boundaries; new services require no route policy.

Every request resolves all available A/AAAA results. A single non-public answer rejects the request; IPv4 private/reserved and IPv6 local, mapped, transition and non-native-global ranges are blocked conservatively. The validated address is supplied to the actual TLS socket lookup. A fresh non-proxy HTTPS Agent prevents environment proxy and pooled-socket bypass. TLS still verifies the configured hostname. Redirects and protocol upgrades fail closed; no retries.

Only server-approved, non-sensitive caller headers are rebuilt. Host, hop-by-hop, proxy, forwarding, cookie and authorization headers cannot be caller controlled. Header case duplicates and injection-field collisions are rejected. Server credential injection happens last. Query credential collisions are rejected case-insensitively. Request/body/target/header bytes and response bytes are bounded. A single deadline covers DNS, connect and response reads. Compressed responses are rejected rather than decompressed without a bound.

The relay returns selected benign response headers, never cookies or Location. The whole buffered response and its headers are checked for the injected key and common encoded echoes; a match returns a sanitized failure. This is defense in depth for accidental echoes, **not a proof against a malicious provider inventing arbitrary encodings**. Arbitrary trusted-upstream responses may contain other sensitive information; choose upstream credentials and service access accordingly.

## Policy, quota and audit

New v3 grants authenticate selected service IDs without a route/method allowlist. Unsupported tunnel/trace protocols, unsafe path/header forms and other transport guards remain blocked. Existing v2 grants keep their original route/method restrictions; malformed or unknown policy versions fail closed. A new v3 grant still cannot bypass a legacy service's retained route restrictions.

Persisted old services without an access marker are read using the old deny-by-default behavior, including missing/empty routes. Ordinary service edits retain those restrictions. A dedicated CSRF-protected conversion action removes legacy restrictions only after explicit administrator confirmation in the UI, revokes every associated grant before saving, and does not mint replacement tokens. Failed conversion leaves restrictions intact and tokens revoked. Changing credentials/origin or deleting a service also revokes grants before file writes, including failed writes.

Tokens are 256-bit random opaque values stored only as SHA-256 hashes. Expiry, revoke, per-grant total and UTC day limits, global UTC day limits and a fixed UTC-minute window are checked and committed in one SQLite IMMEDIATE transaction before network work. Fixed windows allow a boundary burst of up to twice the minute limit; use a conservative quota. Reserved requests count even when DNS, transport, upstream or response validation fails. There is no automatic refund because upstream billing may already have happened. One unit is one attempted relay call, not money.

Audit stores request ID, grant ID, time, service, method, canonical path, outcome and upstream status. It never intentionally stores query, request/response body, upstream keys or bearer tokens. Do not place secrets in URL paths. Audit is local, not tamper-evident, and requires operator retention/backup management. Rejected requests before reservation do not create billable/audit records; use reverse-proxy access controls for ingress abuse. Quotas are not a distributed multi-host limiter.

## Admin and state

The PR2 scrypt password hash, throttled verification, 30-minute memory sessions, session rotation, HttpOnly/SameSite cookies, exact Origin, timing-safe CSRF check and restrictive CSP remain in place. Browser-origin requests cannot use the relay. Forwarded Host is ignored; the reverse proxy must force the loopback Host. Browser initialization cannot set an admin password.

Private files are written atomically with 0600 mode under private directories. Credentials are separate from config. Admin state never returns keys or token hashes; new grant tokens display once. Back up config, keys, password hash and a consistent SQLite snapshot securely. Never copy secrets into git, logs or a release directory.

Legacy account settings and grant rows are retained. Old business-operation grants remain unusable; route-scoped v2 relay grants remain restricted, while newly created v3 grants use service-level access. The migration does not generate a token, contact a provider or infer API authority. A later rollback to the old business-adapter release requires a compatibility plan after configuration/grant changes; blindly restoring a stale database can revive access and reset quotas.

## Operational limits

Requires Node 24+ and one PM2 fork instance. Caddy terminates public TLS under its existing separate systemd service. Health checks establish process/config readiness, not paid upstream availability. All repository tests use fakes or local fixtures; no production credential validation or paid API success is claimed. Monitor disk, backups, certificate renewal, proxy rate limiting and upstream account limits independently.

Credential migration note: old provider credentials remain stored for rollback, but generic services never implicitly use legacy ID-based keys. Explicitly enter the key when configuring a v2 service. New keys are bound to the service ID, origin and injection fields, so a partial config write cannot send a new target’s key to the old target. Changing that binding with a blank key leaves the new target unconfigured unless a key was previously saved for that exact binding.
