-- Applied to the Supabase project on 2026-07-06 (copy for version control).
-- Every 2 minutes, poll any running Claude background job so a screen run
-- finishes (and its result is stored in claude_jobs) even if the user's
-- browser tab is closed. Re-opening the app and clicking Run Weekly Screen
-- within 2 hours returns the stored result instead of billing a second run.
-- The anon-key bearer passes verify_jwt; the edge function allows claude-poll
-- for any valid project JWT (job ids are unguessable UUIDs, no secrets).
SELECT cron.schedule(
  'claude-jobs-poll',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wgnhdguklxewazkfhzwe.supabase.co/functions/v1/alpha-screen',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnbmhkZ3VrbHhld2F6a2ZoendlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1Mzk3NTEsImV4cCI6MjA5NTExNTc1MX0.0r30Zn3kUkAzLzZ8MjMf2yAw23ft3_ec3fzBe6CzX-0'
    ),
    body := jsonb_build_object('action', 'claude-poll', 'job_id', j.id),
    timeout_milliseconds := 60000
  )
  FROM claude_jobs j
  WHERE j.status = 'running' AND j.created_at > now() - interval '36 hours';
  $$
);
