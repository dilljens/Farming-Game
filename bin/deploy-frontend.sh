#!/bin/bash
# Manual frontend deploy fallback (CI does this automatically on main push).
# Usage: bin/deploy-frontend.sh
set -euo pipefail
cd "$(dirname "$0")/.."
rsync -avz index.html scripts.js styles.css backend.js game-time.js pricing.js \
  manifest.json icon-192.svg icon-512.svg vendor ubuntu@40.160.241.74:/opt/farming-game/
sleep 3
repo_token=$(grep -o 'scripts\.js?v=[0-9a-z]*' index.html | head -n 1)
live_token=$(curl -s --max-time 20 https://farm.ferrumeng.com/ | grep -o 'scripts\.js?v=[0-9a-z]*' | head -n 1)
echo "repo: $repo_token live: $live_token"
test -n "$live_token" && test "$repo_token" = "$live_token" && echo DEPLOYED
