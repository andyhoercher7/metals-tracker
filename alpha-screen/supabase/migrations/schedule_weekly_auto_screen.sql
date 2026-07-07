-- Applied to the Supabase project on 2026-07-06, rescheduled 2026-07-07.
-- Pre-run the weekly screen automatically so picks are ready when the user
-- opens the app (no more sitting through the batch queue). Sundays 06:00 UTC
-- (~2am US Eastern) so there is a 30+ hour buffer before the user's Monday
-- 9am ET deadline, even on a slow-queue day (batch SLA is 24h). The edge
-- function's scheduled-screen action no-ops if a screen already ran in the
-- last 5 days, so a manual mid-week run won't be double-run by the cron. The
-- claude-jobs-poll cron (every 2 min) drives the batch to completion and
-- stores the result. When the user opens the app and clicks Run Weekly Screen,
-- claude-start returns the already-finished result within seconds.
SELECT cron.schedule(
  'weekly-auto-screen',
  '0 6 * * 0',
  $$
  SELECT net.http_post(
    url := 'https://wgnhdguklxewazkfhzwe.supabase.co/functions/v1/alpha-screen',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnbmhkZ3VrbHhld2F6a2ZoendlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1Mzk3NTEsImV4cCI6MjA5NTExNTc1MX0.0r30Zn3kUkAzLzZ8MjMf2yAw23ft3_ec3fzBe6CzX-0'
    ),
    body := jsonb_build_object('action', 'scheduled-screen'),
    timeout_milliseconds := 120000
  );
  $$
);
