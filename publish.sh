#!/bin/bash
# Publish only the current origin/main, never the caller's working tree or branch.
set -euo pipefail
umask 077

ROOT=${GATEWAY_DEPLOY_ROOT:-/opt/agent-api-gateway}
BUILD_ROOT=${GATEWAY_BUILD_ROOT:-/var/lib}
UNIT_DIR=${GATEWAY_UNIT_DIR:-/etc/systemd/system}
REPOSITORY=${GATEWAY_REPOSITORY_URL:-https://github.com/Caho1/agent-api-gateway.git}
NODE_BIN=${GATEWAY_NODE_BIN:-/opt/gateway-runtime/node-v24.21.0-linux-x64/bin}
HEALTH_URL=http://127.0.0.1:8787/healthz
ADMIN_STATUS_URL=http://127.0.0.1:8787/admin/api/status
SERVICE=agent-api-gateway.service
export PATH="$NODE_BIN:$PATH"

fail() { printf 'Publish aborted: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail 'No branch, revision or other arguments are accepted; only origin/main is publishable.'
[[ "$ROOT" = /* && "$BUILD_ROOT" = /* && "$UNIT_DIR" = /* ]] || fail 'Deployment paths must be absolute.'
for command in git tar flock systemd-run systemctl node npm curl install readlink; do
  command -v "$command" >/dev/null || fail "Required command missing: $command"
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || fail 'Node 24 or newer is required.'
mkdir -p "$ROOT" "$ROOT/releases"
chmod 0755 "$ROOT" "$ROOT/releases"
exec 9>"$ROOT/.publish.lock"
flock -n 9 || fail 'Another publish is in progress.'
[[ -L "$ROOT/current" ]] || fail 'An existing current release symlink is required; use the reviewed initial deployment procedure first.'
PREVIOUS=$(readlink -f -- "$ROOT/current")
[[ -d "$PREVIOUS" ]] || fail 'Current release is missing.'
[[ -f "$UNIT_DIR/$SERVICE" && ! -L "$UNIT_DIR/$SERVICE" ]] || fail 'The existing service unit must be a regular file.'
systemctl is-active --quiet "$SERVICE" || fail 'Current service must be healthy before publishing.'
curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null || fail 'Current health check failed.'
ADMIN_CONFIGURED=$(curl --fail --silent --show-error --max-time 5 "$ADMIN_STATUS_URL" | node -e '
let body=""; process.stdin.on("data", d => body += d); process.stdin.on("end", () => {
  try { const value=JSON.parse(body).configured; if (typeof value !== "boolean") process.exit(1); console.log(value); }
  catch { process.exit(1); }
});') || fail 'Current admin status could not be checked.'

MIRROR="$ROOT/repository.git"
if [[ ! -d "$MIRROR" ]]; then
  git init --bare "$MIRROR" >/dev/null
  git --git-dir="$MIRROR" remote add origin "$REPOSITORY"
fi
[[ "$(git --git-dir="$MIRROR" remote get-url origin)" = "$REPOSITORY" ]] || fail 'Repository origin differs from the configured repository.'
git -c core.hooksPath=/dev/null --git-dir="$MIRROR" fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main
REVISION=$(git --git-dir="$MIRROR" rev-parse --verify refs/remotes/origin/main^{commit})
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid origin/main revision.'
if [[ -f "$PREVIOUS/.release.json" ]] && node -e '
const f=require("node:fs"); try { process.exit(JSON.parse(f.readFileSync(process.argv[1])).revision===process.argv[2]?0:1); } catch { process.exit(1); }
' "$PREVIOUS/.release.json" "$REVISION"; then
  [[ -f "$PREVIOUS/.activation-ready" && ! -L "$PREVIOUS/.activation-ready" ]] || fail 'This revision has an incomplete activation. Inspect the previous publish and saved unit before recovery; no deployment was claimed.'
  curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" | node -e '
let b=""; process.stdin.on("data",d=>b+=d); process.stdin.on("end",()=>{
  try { const h=JSON.parse(b); process.exit(h.status==="ok"&&h.schemaVersion===2&&h.release===process.argv[1]?0:1); }
  catch { process.exit(1); }
});' "$REVISION" || fail 'The existing release failed its revision health check.'
  printf 'Already running origin/main at %s\n' "$REVISION"
  exit 0
fi

ID="$REVISION-$(date -u +%Y%m%dT%H%M%S)-$$"
BUILD_STATE="agent-api-gateway-build-$ID"
STAGE="$BUILD_ROOT/$BUILD_STATE"
RELEASE="$ROOT/releases/$ID"
CONTROL="$ROOT/.publish-control-$ID"
UNIT_BACKUP="$ROOT/.unit-backup-$ID"
SWITCHED=0
COMPLETE=0
check_health() {
  local attempt
  for attempt in $(seq 1 20); do
    if systemctl is-active --quiet "$SERVICE" && \
      curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" | node -e '
let b=""; process.stdin.on("data",d=>b+=d); process.stdin.on("end",()=>{
  try { const h=JSON.parse(b); process.exit(h.status==="ok"&&h.schemaVersion===2&&h.release===process.argv[1]?0:1); }
  catch { process.exit(1); }
});' "$REVISION"; then
      if curl --fail --silent --show-error --max-time 3 "$ADMIN_STATUS_URL" | node -e '
let b=""; process.stdin.on("data",d=>b+=d); process.stdin.on("end",()=>{
  try { process.exit(String(JSON.parse(b).configured)===process.argv[1]?0:1); } catch { process.exit(1); }
});' "$ADMIN_CONFIGURED"; then return 0; fi
    fi
    sleep 1
  done
  return 1
}
switch_current() {
  rm -f -- "$ROOT/.current-$ID"
  ln -s -- "$1" "$ROOT/.current-$ID"
  mv -Tf -- "$ROOT/.current-$ID" "$ROOT/current"
}
finish() {
  local result=$?
  trap - EXIT INT TERM HUP
  if [[ "$COMPLETE" -eq 0 && "$SWITCHED" -eq 1 && ! -f "$RELEASE/.activation-ready" ]]; then
    printf 'Release did not become healthy; restoring the previous release and service unit.\n' >&2
    local recovered=1
    switch_current "$PREVIOUS" || recovered=0
    install -m 0644 "$UNIT_BACKUP" "$UNIT_DIR/$SERVICE" || recovered=0
    systemctl daemon-reload || recovered=0
    systemctl restart "$SERVICE" || recovered=0
    local attempt restored=0
    for attempt in $(seq 1 20); do
      if systemctl is-active --quiet "$SERVICE" && curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null && \
        curl --fail --silent --show-error --max-time 3 "$ADMIN_STATUS_URL" | node -e '
let b=""; process.stdin.on("data",d=>b+=d); process.stdin.on("end",()=>{
  try { process.exit(String(JSON.parse(b).configured)===process.argv[1]?0:1); } catch { process.exit(1); }
});' "$ADMIN_CONFIGURED"; then restored=1; break; fi
      sleep 1
    done
    if [[ "$recovered" -eq 1 && "$restored" -eq 1 ]]; then
      printf 'Rollback verified: previous service is responding.\n' >&2
    else
      printf 'URGENT: rollback could not be verified. Inspect the service locally; the saved unit is %s\n' "$UNIT_BACKUP" >&2
    fi
  elif [[ "$COMPLETE" -eq 0 && "$SWITCHED" -eq 1 ]]; then
    printf 'Activation has already allowed writes; keeping the activated release. Verify service health before any manual rollback.\n' >&2
  fi
  # Only this run's source staging and link are disposable. Releases, backup
  # units and all production config/database/key files are kept untouched.
  rm -f -- "$ROOT/.current-$ID"
  local storage
  storage=$(readlink -f -- "$STAGE" || true)
  case "$storage" in
    "$STAGE"|"/var/lib/private/$BUILD_STATE") rm -rf -- "$storage" ;;
    "") ;;
    *) printf 'Build directory has an unexpected target; leaving it for inspection.\n' >&2 ;;
  esac
  [[ ! -L "$STAGE" ]] || rm -f -- "$STAGE"
  rm -rf -- "$CONTROL"
  [[ "$COMPLETE" -eq 1 ]] || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mkdir -p "$STAGE"
mkdir -m 0700 "$CONTROL"
[[ "$(git --git-dir="$MIRROR" ls-tree "$REVISION" deploy/agent-api-gateway.service | cut -d ' ' -f 1)" = 100644 ]] || fail 'The service unit must be a regular source-controlled file.'
git --git-dir="$MIRROR" show "$REVISION:deploy/agent-api-gateway.service" >"$CONTROL/$SERVICE"
[[ "$(git --git-dir="$MIRROR" ls-tree "$REVISION" ecosystem.config.cjs | cut -d ' ' -f 1)" = 100644 ]] || fail 'The ecosystem config must be a regular source-controlled file.'
git --git-dir="$MIRROR" show "$REVISION:ecosystem.config.cjs" >"$CONTROL/ecosystem.config.cjs"
git --git-dir="$MIRROR" archive "$REVISION" | tar -x -C "$STAGE"
node -e '
const fs=require("node:fs"),p=require("node:path"),root=process.argv[1];
try {
 const c=JSON.parse(fs.readFileSync(p.join(root,"deploy/release-contract.json")));
 if(c.deploymentVersion!==1||c.schemaVersion!==2||c.runtime!=="pm2") throw Error();
 for(const f of ["deploy/build-release.sh","deploy/agent-api-gateway.service","ecosystem.config.cjs","package-lock.json"]) {
  if(!fs.lstatSync(p.join(root,f)).isFile()) throw Error();
 }
} catch { console.error("origin/main lacks the reviewed relay/PM2 release contract; nothing was switched."); process.exit(1); }
' "$STAGE"
# A fresh innermost StateDirectory on every run ensures ownership is applied to
# the root-created source tree, even when systemd reuses a dynamic UID.
# The builder cannot read production 0700 state or the root-owned env file.
systemd-run --unit=agent-api-gateway-build --wait --pipe --collect --service-type=exec \
  --property=DynamicUser=yes --property=User=agent-api-gateway-build \
  --property="StateDirectory=$BUILD_STATE" --property=StateDirectoryMode=0700 \
  --property=NoNewPrivileges=yes --property=PrivateTmp=yes --property=ProtectSystem=strict \
  --property=ProtectHome=yes --property=RestrictSUIDSGID=yes --property=CapabilityBoundingSet= \
  --property=KillMode=control-group --property=MemoryMax=1G --property=TasksMax=128 \
  --setenv="PATH=$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin" \
  -- /bin/bash "$STAGE/deploy/build-release.sh" "$STAGE"
# Transient unit has exited; its entire cgroup is stopped before copying.
test -f "$STAGE/dist/server.js"
test -f "$STAGE/dist/initialize.js"
test -f "$STAGE/node_modules/pm2/bin/pm2-runtime"
[[ ! -e "$STAGE/.release.json" && ! -L "$STAGE/.release.json" ]] || fail 'Source must not supply deployment metadata.'
[[ ! -e "$STAGE/.activation-ready" && ! -L "$STAGE/.activation-ready" ]] || fail 'Source must not supply an activation marker.'
[[ ! -e "$STAGE/.activation-ready.next" && ! -L "$STAGE/.activation-ready.next" ]] || fail 'Source must not supply a pending activation marker.'
mkdir -m 0755 "$RELEASE"
cp -a --no-preserve=ownership "$STAGE/." "$RELEASE/"
rm -f -- "$RELEASE/ecosystem.config.cjs"
install -m 0644 "$CONTROL/ecosystem.config.cjs" "$RELEASE/ecosystem.config.cjs"
printf '{"revision":"%s","source":"origin/main","schemaVersion":2}\n' "$REVISION" >"$RELEASE/.release.json"
chmod -R a+rX,go-w "$RELEASE"
# Fail rather than deploy a stale snapshot if main changed during validation.
git -c core.hooksPath=/dev/null --git-dir="$MIRROR" fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main
[[ "$(git --git-dir="$MIRROR" rev-parse refs/remotes/origin/main)" = "$REVISION" ]] || fail 'origin/main changed during validation; rerun to validate its latest revision.'
cp -p -- "$UNIT_DIR/$SERVICE" "$UNIT_BACKUP"
SWITCHED=1
switch_current "$RELEASE"
# Never install a privileged control file from a dependency-writable build tree.
install -m 0644 "$CONTROL/$SERVICE" "$UNIT_DIR/$SERVICE"
systemctl daemon-reload
systemctl restart "$SERVICE"
check_health || fail 'New release failed the revision/admin health gate.'
# Until this marker exists, the application rejects relay/admin mutations. This
# prevents incompatible new config writes racing an immediate legacy rollback.
install -m 0644 /dev/null "$RELEASE/.activation-ready.next"
mv -T -- "$RELEASE/.activation-ready.next" "$RELEASE/.activation-ready"
COMPLETE=1
printf 'Published and verified origin/main at %s\n' "$REVISION"
printf 'Previous release retained: %s\n' "$PREVIOUS"
