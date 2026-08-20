-- ============================================================
-- Daily reminder sweep
--
-- Run AFTER deploying the send-reminders function. Replace the three
-- placeholders before running: the project ref, the anon key, and the
-- CRON_SECRET you set with `supabase secrets set`.
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
                 -- The function is deployed with JWT verification ON, so
                 -- Supabase's gateway rejects a request with no bearer
                 -- token BEFORE it ever reaches the function — a 401
                 -- that never appears in the function's own logs, which
                 -- makes it look as though the cron never fired.
                 --
                 -- The anon key is a valid JWT and is public by design
                 -- (it is already in js/config.js), so it is the right
                 -- thing to present here. It gets the request past the
                 -- gateway and nothing more: the header below is what
                 -- actually authorises the send.
                 --
                 -- The alternative is deploying with --no-verify-jwt and
                 -- leaning on the secret alone. That is defensible for
                 -- THIS function, and must never be done for unfurl or
                 -- geo, which have no second gate. Keeping the gateway
                 -- check costs nothing, so keep it.
                 'Authorization', 'Bearer YOUR_SUPABASE_ANON_KEY',
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
