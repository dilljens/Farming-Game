#!/usr/bin/env bash
# Open a psql shell on the Farming Game database (for AI and humans).
set -euo pipefail
cd "$(dirname "$0")"
export PGPASSWORD="${FG_DB_PASSWORD:-farming-dev-pw}"
exec psql -h localhost -p 55433 -U fg -d farming "$@"
