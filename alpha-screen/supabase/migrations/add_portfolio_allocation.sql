-- Applied to the Supabase project on 2026-07-31.
-- Weekly conviction-weighted portfolio allocation.
-- Rules encoded here and in the alpha-portfolio edge function:
--   * hard cap 20 positions, target 15
--   * max 20% weight in any single name
--   * no new cash: buys are funded by sells/trims
--   * a new pick only enters by clearly beating a current holding (swap)

-- The 2026-07-30 screen stored each pick twice (double finalize).
-- Remove duplicates and add the uniqueness guard that prevents recurrence.
DELETE FROM picks a
USING picks b
WHERE a.week_date = b.week_date
  AND a.ticker = b.ticker
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS picks_week_ticker_uniq
  ON picks (week_date, ticker);

CREATE TABLE IF NOT EXISTS allocation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  week_date date NOT NULL,
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('done','error')),
  recommendation jsonb,
  error text
);

CREATE TABLE IF NOT EXISTS allocation_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES allocation_runs(id) ON DELETE CASCADE,
  trade_key text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, trade_key)
);

ALTER TABLE allocation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated full access" ON allocation_runs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated full access" ON allocation_decisions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Auto-run Sundays 12:00 UTC, after the screen (06/08/10) and review
-- (07/09/11) ticks, so the allocator sees this week's picks and fresh
-- reviews. Idempotent: the edge function returns the existing run if one
-- already exists for the current cycle. (Anon key in headers in the live
-- version.)
SELECT cron.schedule(
  'weekly-auto-allocation',
  '0 12 * * 0',
  $$ SELECT net.http_post(url := '.../functions/v1/alpha-portfolio', ...) $$
);
