#!/bin/bash
# Manual frontend deploy fallback (CI does this automatically on main push).
# Cache-buster tokens ride the commit SHA so clients always fetch the new
# code; the rewrite is working-copy only and never committed.
# Usage: bin/deploy-frontend.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain -- index.html scripts.js)" ]; then
  echo "index.html/scripts.js have uncommitted changes — commit first so the token matches." >&2
  exit 1
fi
TOKEN=$(git rev-parse --short HEAD)
sed -i -E "s/(\.(js|css)\?v=)[0-9a-z]+/\1$TOKEN/g" index.html scripts.js
trap 'git checkout -- index.html scripts.js' EXIT
rsync -avz index.html scripts.js styles.css backend.js game-time.js pricing.js \
  manifest.json icon-192.svg icon-512.svg vendor ubuntu@40.160.241.74:/opt/farming-game/
sleep 3
live_token=$(curl -s --max-time 20 https://farm.ferrumeng.com/ | grep -o 'scripts\.js?v=[0-9a-z]*' | head -n 1)
echo "deploy: scripts.js?v=$TOKEN live: $live_token"
test -n "$live_token" && test "scripts.js?v=$TOKEN" = "$live_token" && echo DEPLOYED
