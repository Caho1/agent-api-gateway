# Deployment choices

This gateway is a small self-hosted control plane for agents needing existing HTTPS APIs. Prefer the upstream's own scoped keys/OAuth and spending limits when they satisfy the task. A managed API gateway may be more suitable for multi-tenant identity, distributed rate limits, high availability or streaming.

The generic relay deliberately avoids provider business adapters. It adds server-held credential injection, explicit method/path policy, request quotas, pinned public-only egress and a small management UI. It does not replace a provider's billing controls, object-level access policy, terms or data permissions.

PM2 manages the application process under the existing hardened systemd identity; Caddy remains native systemd. Containerizing either component is not required for this implementation.
