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

- REST: `http://localhost:3002` (ports offset so imposterirl's stack can run too)
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

## 3. Curl cookbook (replace `$R` with the REST base, default `http://localhost:3002`)

```bash
R=http://localhost:3002

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
  then `localStorage.fgBackendUrl`, then `http://localhost:3002`.

## 5. VPS placement (`40.160.241.74` — full inventory: `~/MEGA/FerrumEng/VPS.md`)

Fit, checked against the server's port map — **do not change these ports**:
- REST `:3002` (127.0.0.1): `:3000` is imposter PostgREST, `:3001` is the
  imposter frontend. `:3002` is free.
- PG `:55433` (127.0.0.1): imposter PG owns `:5432`, umami PG `:5433`.
  Separate container (not the imposter database) — same isolation pattern
  as umami's own postgres.
- Disk is at 71% — this stack adds ~500 MB (PG image + volume).

### 5.0 Access — how to get into the VPS

```bash
# Primary: SSH key (your ~/.ssh/id_ed25519). User is ALWAYS `ubuntu`, never `root`.
ssh ubuntu@40.160.241.74

# Fallback inside the tailnet (same machine, Tailscale IP):
ssh ubuntu@100.73.157.121

# If the key isn't loaded yet:
ssh-add ~/.ssh/id_ed25519
ssh ubuntu@40.160.241.74
```

- Fallback password exists (`raspi9000`, see DagLock `docs/vps.md`) — key first.
- `/opt/` is root-owned. First time only, make our dir writable by `ubuntu`
  so plain `rsync`/`./backend-up.sh` work without sudo every time:

```bash
ssh ubuntu@40.160.241.74 "sudo mkdir -p /opt/farming-backend && sudo chown -R ubuntu:ubuntu /opt/farming-backend"
```

### 5.1 Deploy (mirrors the imposter `/opt/` layout)

From the repo root on your laptop:

```bash
# 1. Ship the code next to imposter-backend/ and imposter-frontend/
rsync -avz backend/ ubuntu@40.160.241.74:/opt/farming-backend/

# 2. On the VPS: real password + start. NEVER commit `.env`.
ssh ubuntu@40.160.241.74
cd /opt/farming-backend
cp .env.example .env
openssl rand -hex 32   # paste the output as the value below
nano .env              # FG_DB_PASSWORD=<the 64-hex string>
./backend-up.sh        # compose up, apply schema+permissions, health-check
curl -s http://localhost:3002/leaderboard?limit=1 | head -c 200  # expect 200 + JSON
```

Repeat deploys are the same two lines: `rsync` from the laptop, then
`./backend-up.sh` on the VPS (idempotent — safe to re-run).

### 5.2 TLS — Caddy site (Docker `ferrum-caddy`, auto-TLS)

TLS comes from the shared `ferrum-caddy` container, **not** host nginx and
**not** certbot. Site snippets live in the sololedger deploy repo and are
mounted read-only into the container (`./sites:/etc/caddy/sites:ro`), so:

1. Create the snippet **on the VPS** at `/opt/sololedger/deploy/sites/farming.conf`
   (appears as `/etc/caddy/sites/farming.conf` inside the container):

```caddy
# /opt/sololedger/deploy/sites/farming.conf
farm.ferrumeng.com {
    handle {
        reverse_proxy 127.0.0.1:3002
    }
}
```

2. DNS first: Cloudflare → `farm.ferrumeng.com` → `A 40.160.241.74`
   (DNS-only / grey cloud, same as the other game subdomains).
3. Apply (Caddy watches the file on restart, then issues TLS automatically):

```bash
ssh ubuntu@40.160.241.74
sudo tee /opt/sololedger/deploy/sites/farming.conf < farming.conf
docker compose -f /opt/sololedger/deploy/docker-compose.yml restart caddy
sleep 5; curl -s -o /dev/null -w "%{http_code}\n" https://farm.ferrumeng.com/leaderboard?limit=1
```

> Old note this replaces: do NOT write to host `/etc/caddy/sites/` and do NOT
> `systemctl reload caddy` — there is no host Caddy service, only the
> `ferrum-caddy` container.

### 5.3 Point the game at it

`index.html` bakes `window.FG_BACKEND_URL = 'https://farm.ferrumeng.com'`.
A per-device `localStorage.fgBackendUrl` wins over the baked default
(use it for local dev: `localStorage.fgBackendUrl = 'http://localhost:3002'`);
with neither set the game uses `http://localhost:3002`.

## 6. Troubleshooting

- `connection refused :3002` → `./backend-up.sh` (also starts the daemon's containers).
- Empty boards, game works otherwise → some client pointed at the wrong `$R`
  (check `localStorage.fgBackendUrl` / `window.FG_BACKEND_URL`).
- `column "X" does not exist` on write → adapter `COLUMN_MAP` vs `schema.sql`
  drifted; they must stay in sync (both live in this repo — one commit).
- Firebase-era errors (`permission-denied`, missing rooms) → that's the OLD
  backend; this system replaces it. `farming-game-backend/` (Fly Express app)
  is superseded by this directory and can be deleted once cut over.
