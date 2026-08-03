-- Applied 2026-07-07. Tracks a batched, auto-run weekly position review
-- (one Anthropic batch, one request per held position). The review-poll cron
-- writes each result into weekly_position_reviews / position_tracker /
-- sell_triggers when the batch ends. RLS on, service-role only.
CREATE TABLE IF NOT EXISTS weekly_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_date date NOT NULL,
  batch_id text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE weekly_review_runs ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS weekly_review_runs_week_idx ON weekly_review_runs (week_date);
