#!/usr/bin/env bash
# Start the Farming Game backend (Postgres + PostgREST) and (re)apply schema.
# Idempotent — safe to run any time. REST lands on http://localhost:3001.
set -euo pipefail
cd "$(dirname "$0")"

export FG_DB_PASSWORD="${FG_DB_PASSWORD:-farming-dev-pw}"

docker compose up -d

echo "waiting for postgres..."
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U fg >/dev/null 2>&1; then break; fi
  sleep 1
done

export PGPASSWORD="$FG_DB_PASSWORD"
psql -h localhost -p 55433 -U fg -d farming -f schema.sql
psql -h localhost -p 55433 -U fg -d farming -f permissions.sql

echo "backend up: REST http://localhost:3001  PG localhost:55433/farming"
curl -s -o /dev/null -w "rest status: %{http_code}\n" http://localhost:3001/leaderboard?limit=1
