-- Applied to the Supabase project on 2026-07-04 (copy for version control).
-- Learning loop automation: every Friday 21:30 UTC (after US close) invoke
-- the alpha-feedback edge function, which computes pick forward returns vs
-- IVV, factor ICs, and theme accuracy, and writes this week's model_feedback
-- row. The weekly screen reads the last 8 rows before generating picks.
--
-- The bearer token below is the project's PUBLIC anon key (already shipped in
-- every client bundle) — it passes the function's verify_jwt gate. The
-- function is cheap, idempotent, and makes no LLM calls, so anon-level
-- invocation is acceptable.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'alpha-feedback-weekly',
  '30 21 * * 5',
  $$
  SELECT net.http_post(
    url := 'https://wgnhdguklxewazkfhzwe.supabase.co/functions/v1/alpha-feedback',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnbmhkZ3VrbHhld2F6a2ZoendlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1Mzk3NTEsImV4cCI6MjA5NTExNTc1MX0.0r30Zn3kUkAzLzZ8MjMf2yAw23ft3_ec3fzBe6CzX-0'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
