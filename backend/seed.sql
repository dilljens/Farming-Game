-- Optional demo seed. Run manually, never on boot:
--   psql $FG_DB_URL -f seed.sql
-- Gives AI (and humans) a room to poke without touching the game.

INSERT INTO rooms (room_code, status, host_name)
VALUES ('TEST', 'Lobby', 'seed')
ON CONFLICT (room_code) DO NOTHING;
