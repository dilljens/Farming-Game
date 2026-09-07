#!/usr/bin/env bash
# psql shell on the Farming Game database (for AI and humans).
# Runs through the db container, so no host postgres client is needed.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export FG_DB_PASSWORD="${FG_DB_PASSWORD:-farming-dev-pw}"
if [ $# -eq 0 ]; then
  exec docker compose exec -e PGPASSWORD="$FG_DB_PASSWORD" db psql -U fg -d farming
else
  exec docker compose exec -T -e PGPASSWORD="$FG_DB_PASSWORD" db psql -U fg -d farming "$@"
fi
