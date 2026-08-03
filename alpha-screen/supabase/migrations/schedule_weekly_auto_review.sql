-- Applied 2026-07-07. Auto-run the weekly position review Sundays 07:00 UTC
-- (~3am ET) so reviews are ready before Monday, and poll the review batch
-- every 2 minutes. scheduled-review no-ops if this week's reviews already
-- exist; both are anon-callable (edge allowlist) since they expose no secrets.
SELECT cron.schedule('weekly-auto-review','0 7,9,11 * * 0',$$
  SELECT net.http_post(
    url := 'https://wgnhdguklxewazkfhzwe.supabase.co/functions/v1/alpha-screen',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <anon key>'),
    body := jsonb_build_object('action','scheduled-review'),
    timeout_milliseconds := 120000);
$$);
SELECT cron.schedule('review-poll','*/2 * * * *',$$
  SELECT net.http_post(
    url := 'https://wgnhdguklxewazkfhzwe.supabase.co/functions/v1/alpha-screen',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <anon key>'),
    body := jsonb_build_object('action','review-poll'),
    timeout_milliseconds := 120000);
$$);
