# Farming Game backend — AI operator runbook

System: Postgres 17 + PostgREST v12, no server code, no auth.
Mirrors imposterirl's backend model: prototype-open REST that any agent
(or the game itself) drives with plain HTTP. Live updates are client
polling (2.5s), same role as imposterirl's realtime fallback.

## 1. Quickstart (any machine with Docker)

```bash
cd backend
./backend-up.sh        # compose up, apply schema+permissions, health-check
./backend-psql.sh      # psql shell
./backend-down.sh      # stop (data kept in the pgdata volume)
```

- REST: `http://localhost:3001` (ports offset so imposterirl's stack can run too)
- Postgres: `localhost:55433`, user `fg`, db `farming`, password `$FG_DB_PASSWORD`
  (default `farming-dev-pw`, highest precedence: env var)

## 2. Schema (see schema.sql / permissions.sql — both idempotent)

- `rooms(room_code PK, status, host_uid, host_name, created_at, last_activity_at, last_host_reset_at)`
- `leaderboard(user_id PK, username, networth, cash, debt, hay, grain, fruit,
  cows, farm, harvester, tractor, history JSONB, game_id, game_created_at,
  game_duration_ms, room_code, updated_at)`
- `trades(id PK, room_code, buyer_uid, buyer_name, seller_uid, seller_name,
  asset, qty, price, status, created_at, updated_at)`
- Roles: everything `GRANT ALL TO anon`, RLS open (`USING (true)`), same as
  imposterirl's `20_anon_permissions.sql`. No keys, no login, no console.

## 3. Curl cookbook (replace `$R` with the REST base, default `http://localhost:3001`)

```bash
R=http://localhost:3001

# rooms
curl -s $R/rooms | head -c 500                                          # list
curl -s $R/rooms?room_code=eq.AB                                        # read one
curl -s -X POST "$R/rooms?on_conflict=room_code" \                       # create/upsert
  -H 'Prefer: resolution=merge-duplicates' -H 'Content-Type: application/json' \
  -d '{"room_code":"AB","status":"Lobby","host_name":"Al"}'
curl -s -X PATCH "$R/rooms?room_code=eq.AB" \                            # touch activity
  -H 'Content-Type: application/json' -d '{"last_activity_at":"2026-09-07T12:00:00Z"}'

# leaderboard (global top 10 = what roomless players see)
curl -s "$R/leaderboard?order=networth.desc&limit=10"
curl -s "$R/leaderboard?room_code=eq.AB&order=networth.desc"             # room board
curl -s -X POST "$R/leaderboard?on_conflict=user_id" \                   # upsert score
  -H 'Prefer: resolution=merge-duplicates' -H 'Content-Type: application/json' \
  -d '{"user_id":"u1","username":"Al","networth":42000,"room_code":"AB"}'

# trades (pending offers in a room; roomless players share room `lobby`)
curl -s "$R/trades?room_code=eq.AB&order=created_at.desc"
curl -s -X POST "$R/trades?on_conflict=id" \
  -H 'Prefer: resolution=merge-duplicates' -H 'Content-Type: application/json' \
  -d '{"id":"t1","room_code":"AB","buyer_uid":"u1","seller_uid":"u2","asset":"Hay","qty":5,"price":1000,"status":"pending"}'
curl -s -X PATCH "$R/trades?id=eq.t1" \
  -H 'Content-Type: application/json' -d '{"status":"accepted"}'

# ops: reset a room (what host Reset does)
curl -s -X DELETE "$R/trades?room_code=eq.AB"
curl -s -X DELETE "$R/leaderboard?room_code=eq.AB"
# ops: wipe everything (fresh season) — prefer TRUNCATE via psql:
./backend-psql.sh -c "TRUNCATE trades, leaderboard, rooms;"
# (pure-REST equivalent needs a match-all filter, e.g.)
curl -s -X DELETE "$R/trades?id=not.is.null"
# backup / restore
docker compose exec -T db pg_dump -U fg farming > backup.sql
cat backup.sql | ./backend-psql.sh
```

## 4. How the game uses it

- `backend.mjs` (repo root) exposes the same names the Firebase SDK had
  (`collection/doc/query/where/orderBy/limit/getDoc/getDocs/setDoc/deleteDoc/
  onSnapshot`, plus `getAuth/signInAnonymously/onAuthStateChanged`), backed by
  the REST above. `scripts.js` imports it — no other game code changed.
- camelCase in JS ↔ snake_case in SQL is mapped inside `backend.mjs`
  (e.g. `hostUid` ↔ `host_uid`); `Date` values serialize to ISO strings.
- Identity = local UUID (`localStorage.fgUid`), like imposterirl's player id.
  **Cutover note:** Firebase anon UIDs won't carry over — every device gets a
  fresh id, so the leaderboard restarts clean on switchover. Fine for rooms
  (ephemeral); say so before cutting over mid-season.
- Point the game elsewhere without rebuilding: `window.FG_BACKEND_URL` wins,
  then `localStorage.fgBackendUrl`, then `http://localhost:3001`.

## 5. VPS deploy sketch (same pattern as imposterirl's `.deploy/`)

1. Copy `backend/` to the VPS, set `FG_DB_PASSWORD` to something real.
2. `./backend-up.sh`, open/forward the REST port (or put nginx in front:
   `location /fg/ { proxy_pass http://127.0.0.1:3001/; }`).
3. Set the game to it: `localStorage.fgBackendUrl='https://vps/fg'` (or bake
   `window.FG_BACKEND_URL` into hosting). PostgREST answers CORS `*` by default.
4. Back up: cron `pg_dump` (see §3). Harden later: RLS policies +
   `PGRST_JWT_SECRET` when open-write is no longer wanted.

## 6. Troubleshooting

- `connection refused :3001` → `./backend-up.sh` (also starts the daemon's containers).
- Empty boards, game works otherwise → some client pointed at the wrong `$R`
  (check `localStorage.fgBackendUrl` / `window.FG_BACKEND_URL`).
- `column "X" does not exist` on write → adapter `COLUMN_MAP` vs `schema.sql`
  drifted; they must stay in sync (both live in this repo — one commit).
- Firebase-era errors (`permission-denied`, missing rooms) → that's the OLD
  backend; this system replaces it. `farming-game-backend/` (Fly Express app)
  is superseded by this directory and can be deleted once cut over.
