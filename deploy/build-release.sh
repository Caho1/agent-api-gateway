#!/bin/bash
# Runs only inside the publisher's isolated, unprivileged systemd build unit.
set -euo pipefail
umask 022
cd -- "$1"
export HOME="$PWD/.build-home"
export npm_config_cache="$PWD/.npm-cache"
mkdir -p "$HOME" "$npm_config_cache"
npm ci --ignore-scripts --no-audit --no-fund
npm run check
test -f dist/server.js
test -f dist/initialize.js
test -f node_modules/pm2/bin/pm2-runtime
# Tests use temporary fixtures. No production environment/state is supplied.
rm -rf -- .build-home .npm-cache
