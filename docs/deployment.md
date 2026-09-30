# Production publishing and PM2

The gateway stays on `127.0.0.1:8787`. Caddy is the only public listener. The
application runs as one PM2 **fork-mode** process under the existing hardened
`agent-api-gateway.service` DynamicUser identity. A single process is intentional:
SQLite quotas, grant validation, and admin sessions are not a cluster setup.

## Persistent layout

| Path                                             | Purpose                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `/opt/agent-api-gateway/current`                 | Atomic symlink to the active immutable release                   |
| `/opt/agent-api-gateway/releases/`               | Root-owned code, dependencies, and build outputs                 |
| `/opt/agent-api-gateway/repository.git`          | Bare fetch cache; only `origin/main` is deployed                 |
| `/etc/agent-api-gateway/gateway.env`             | Existing root-owned environment file; never rewritten by publish |
| `/var/lib/agent-api-gateway/`                    | Existing DynamicUser state directory, mode `0700`                |
| `/var/lib/agent-api-gateway/pm2/`                | PM2 runtime state within that same protected directory           |
| `/var/lib/agent-api-gateway-build-<release-id>/` | Separate, unprivileged temporary build state                     |

Keep `GATEWAY_CONFIG`, `GATEWAY_DB`, `GATEWAY_SECRETS`,
`ADMIN_PASSWORD_HASH_FILE`, and `ADMIN_ORIGIN` unchanged during migration. The
password hash, provider keys, SQLite database, and config stay outside every
release. Do not copy them into the repository, print them, reset them, or run the
password setup command as a deployment step. Do not run `pm2 save` or `pm2 startup`
as root: systemd already supervises `pm2-runtime` and supplies the protected env.

## Before the first PM2 migration

This repository's deployment files describe an upgrade of an existing working
installation, not a bootstrap script. Verify the actual service, installed Node
path, current symlink, state permissions, and backups from an authorized trusted
terminal. This version expects Node 24 at
`/opt/gateway-runtime/node-v24.21.0-linux-x64/bin`; review the unit if the host uses
a different path. Node, npm, Git, Bash, GNU coreutils, curl, flock, and a working
systemd system manager must already be installed.

The reviewed relay/PM2 changes must first be merged into `main` by an authorized
maintainer. `publish.sh` does not merge a PR, deploy a feature branch, or silently
fall back to whatever branch it was launched from. It refuses the earlier
scaffold-only `main` because that tree has no version-2 release contract.

Take an access-controlled, consistent backup of application state before the
first migration, using SQLite's backup facility or a stopped-service copy. Do not
copy a live SQLite file without its required consistency procedure. Grant tables
are retained; legacy business-operation grants become non-executable migration
records. Create fresh service/path-scoped grants through the admin panel as
needed. Database changes are additive, but version-2 config and newly created
grants are not understood by the old business-specific release. Immediate
pre-activation rollback is supported; later rollback requires a compatible
release or a separately reviewed migration. Never restore stale usage counters
or revoked grants blindly from an old backup. Future destructive migrations
require a separately reviewed backup/restore plan.

## Publish latest main

From a reviewed checkout, run `sudo ./publish.sh`. No branch or revision arguments
are accepted. Normal production operation uses the built-in paths and public
repository URL. Environment path overrides exist for isolated integration tests;
the production unit and persistent state locations must remain aligned.

The publisher:

1. Takes an exclusive deployment lock and checks the existing release and admin
   status without reading credentials
2. Fetches exactly `refs/heads/main` from the configured origin and records its
   immutable commit SHA
3. Extracts that SHA into an isolated build directory and checks the release
   contract, refusing old scaffold-only trees
4. Runs `npm ci --ignore-scripts` and the full `npm run check` in a transient,
   unprivileged DynamicUser systemd unit, separate from production secrets; each
   build uses a fresh StateDirectory so source ownership is correctly applied
5. Copies validated artifacts into a new root-owned release and records its SHA;
   the runtime user cannot modify this code
6. Refetches main and aborts if it changed during validation
7. Saves the prior service unit, atomically changes `current`, installs the PM2
   unit from a protected pristine copy of the exact Git revision, reloads systemd,
   and restarts the application; build output cannot replace this privileged unit
8. Requires a healthy local response with schema version 2 and the exact deployed
   SHA, and verifies that the admin configured status is unchanged
9. Atomically creates the activation marker that permits relay/admin mutations;
   those mutations return `503 deployment_in_progress` until the gate passes
10. On failure or interruption before activation, restores the previous symlink
    and service unit, restarts, and verifies old health and admin configured status

Once activated, the publisher does not automatically roll back into an older
schema: users may already have changed config or grants. The old release and
saved unit remain available. A failed rollback is reported
explicitly and needs immediate operator attention. Restarting creates a short
availability gap and invalidates in-memory admin sessions; log in again afterward.
The script never deletes releases automatically or changes Caddy, provider keys,
config, grants, quotas, or the admin password. Build failures and a changed main
leave the running service untouched.

## Public relay activation

`deploy/Caddyfile` retains native Caddy ACME IP-certificate issuance/renewal and
adds only `/v1/relay` and `/v1/invoke` to the existing admin proxy. Both relay
paths enforce bearer-grant authorization in the application. Requests never
supply the upstream origin or upstream provider credential. The health endpoint
and arbitrary paths remain unavailable through the public proxy. Caddy rewrites
the upstream Host to the loopback name expected by the application's rebinding
check, while `ADMIN_ORIGIN` still validates the browser's public HTTPS origin.

Apply the reviewed Caddy configuration only after the new application is healthy.
Back up the existing Caddyfile, validate the candidate with the installed Caddy
binary, then use the host's established restart procedure. The existing Caddy
unit has its admin API disabled, so a generic `caddy reload` is not appropriate.
Preserve the Caddy state directory, certificate store, service identity, and
native short-lived-certificate renewal. Keep the previous Caddyfile for rollback.
Do not open port 8787 publicly or disable certificate verification.

Verify public HTTPS `/admin`, unchanged configured/login behavior, and an
unauthenticated JSON `POST /v1/relay` returning `401`. Check that an arbitrary
public path still returns `404`. These checks require no provider token and make
no paid upstream API call. A real authenticated provider call requires the user's
grant/provider setup and any applicable authorization; do not claim it was tested
from the unauthenticated smoke checks alone.

## Operational checks

- `systemctl status agent-api-gateway` checks the systemd/PM2 supervisor
- `journalctl -u agent-api-gateway` contains process logs; avoid logging request
  bodies, authorization headers, provider credentials, or secret config
- PM2 file sinks use `/dev/null`; `pm2-runtime` streams stdout/stderr log events
  through its inherited descriptors into journald. Do not set `disable_logs: true`
  or replace the file sinks with `/dev/stdout` or `/dev/stderr`: reopening a
  journal socket as a regular log file can fail with `ENXIO` before the app starts
- Local `GET /healthz` identifies the release SHA and schema version
- An intentional republish of the already-running main SHA exits without restart
  only after checking activation and exact revision health; an interrupted
  activation fails clearly and requires inspection before recovery
- For emergency rollback after activation, first establish config/grant schema
  compatibility and a current state backup; then restore a compatible retained
  release and matching unit, daemon-reload, restart, and verify health

Publishing cannot proceed if main is unavailable, its checks fail, the release
contract is absent, the existing installation is unhealthy, or the exact revision
health check fails. Repository access, package installation, host access, and
actual production smoke checks must be reported separately from local fixture
tests.
