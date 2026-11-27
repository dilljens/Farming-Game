-- Farming Game schema (Supabase-style backend, mirrors imposterirl's open model).
-- Idempotent: safe to re-apply on every start (IF NOT EXISTS throughout).
-- JSON numbers stay numbers: float8 columns (NOT numeric, which PostgREST
-- serializes as strings) so the game reads values exactly as it wrote them.

-- Anonymous role used by PostgREST when no Auth header is sent.
DO $$
BEGIN
    CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS rooms (
    room_code TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'Lobby',
    host_uid TEXT,
    host_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_host_reset_at TEXT,
    rules JSONB NOT NULL DEFAULT '{}'
);
-- Live databases created before the market-rules update need the column too
-- (this file is re-applied idempotently by backend-up.sh).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS leaderboard (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL DEFAULT '',
    networth DOUBLE PRECISION NOT NULL DEFAULT 0,
    cash DOUBLE PRECISION NOT NULL DEFAULT 0,
    debt DOUBLE PRECISION NOT NULL DEFAULT 0,
    hay INTEGER NOT NULL DEFAULT 0,
    grain INTEGER NOT NULL DEFAULT 0,
    fruit INTEGER NOT NULL DEFAULT 0,
    cows INTEGER NOT NULL DEFAULT 0,
    farm INTEGER NOT NULL DEFAULT 0,
    harvester INTEGER NOT NULL DEFAULT 0,
    tractor INTEGER NOT NULL DEFAULT 0,
    history JSONB NOT NULL DEFAULT '[]',
    game_id TEXT,
    game_created_at BIGINT,
    game_duration_ms BIGINT,
    room_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The ledger (amount + memo per line, both sides) rides along so a second
-- device or a fresh install restores the player's transactions instead of
-- starting blank. Legacy saves have no column value and fall back to local.
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS transactions JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Per-player roll log for the luck chart: {t, v} pairs like history.
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS roll_log JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Personal year counter: the board shows it in place of the room code.
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS player_year INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    buyer_uid TEXT,
    buyer_name TEXT,
    seller_uid TEXT,
    seller_name TEXT,
    asset TEXT,
    qty DOUBLE PRECISION NOT NULL DEFAULT 0,
    price DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Offers predate created_by (buyer-created only); the column tells Accept
-- whose click counts once sell-initiated offers exist.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS created_by TEXT;
-- Auctions collect bid history; open offers are claimable by anyone in the
-- room. Both are written by the game (bids/open) and must exist here or
-- PostgREST rejects the write with PGRST204.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS bids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS open BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS leaderboard_room_code_idx ON leaderboard (room_code);
CREATE INDEX IF NOT EXISTS trades_room_code_idx ON trades (room_code);
CREATE INDEX IF NOT EXISTS trades_status_idx ON trades (status);
