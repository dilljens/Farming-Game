-- Prototype-open permissions (mirrors imposterirl's 20_anon_permissions.sql).
-- No auth: any client with the REST URL can read/write everything.
-- Harden later with RLS policies + PGRST_JWT_SECRET when the game needs it.

GRANT USAGE ON SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['rooms', 'leaderboard', 'trades'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Allow all on %I" ON %I', t, t);
        EXECUTE format('CREATE POLICY "Allow all on %I" ON %I FOR ALL USING (true)', t, t);
    END LOOP;
END
$$;
