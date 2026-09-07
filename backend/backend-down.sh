#!/usr/bin/env bash
# Stop the Farming Game backend (data volume is kept).
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
