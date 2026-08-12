-- ============================================================
-- Daily reminder sweep
--
-- Run AFTER deploying the send-reminders function. Replace the two
-- placeholders before running.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Fires once a day. 14:00 UTC is mid-morning in the US — pick whatever
-- suits; cron runs in UTC, so this does not follow daylight saving.
select cron.schedule(
  'send-reminders',
  '0 14 * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-cron-secret', 'YOUR_CRON_SECRET'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- Useful afterwards:
--   select * from cron.job;                      -- confirm it registered
--   select * from cron.job_run_details           -- did it actually run
--     order by start_time desc limit 10;
--   select cron.unschedule('send-reminders');    -- remove it
