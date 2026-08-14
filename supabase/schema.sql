-- ============================================================
-- Do It All — database changes for reminders + push
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor).
-- Every statement is idempotent, so re-running it is harmless.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Reminder date on an activity
--
-- Separate from target_date: the target is when you want to do the
-- thing, the reminder is when you need to act on it (bookings opening,
-- tickets going on sale).
-- ------------------------------------------------------------
alter table "Activities" add column if not exists remind_at date;

-- Set when a push has gone out, so the daily sweep never sends the same
-- reminder twice. Cleared automatically whenever remind_at changes.
alter table "Activities" add column if not exists reminder_sent_at timestamptz;

-- What the reminder should actually say. Without it a notification can
-- only repeat the activity's name, which is rarely the useful part —
-- "Book the permit, they sell out in an hour" is.
alter table "Activities" add column if not exists reminder_note text;


-- ------------------------------------------------------------
-- 2. Retire "Someday" and "No date"
--
-- Both were removed from the picker. This moves everything still
-- holding them to "In 5+ Years" so nothing is stranded in a band the
-- app no longer shows.
--
-- PREVIEW FIRST — run this select and check the count looks right:
--
--   select target_date, count(*)
--     from "Activities"
--    where target_date is null
--       or target_date = ''
--       or target_date = 'Before I Die'
--    group by target_date;
-- ------------------------------------------------------------
update "Activities"
   set target_date = 'In 5+ Years'
 where target_date is null
    or target_date = ''
    or target_date = 'Before I Die';


-- ------------------------------------------------------------
-- 3. Push subscriptions
--
-- One row per browser/device a user has granted notifications on. The
-- endpoint is unique, so re-subscribing the same device updates in
-- place rather than piling up duplicates.
-- ------------------------------------------------------------
create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

-- A user may only ever see or touch their own subscriptions. The Edge
-- Function reads them with the service role, which bypasses RLS.
drop policy if exists "own subscriptions" on push_subscriptions;
create policy "own subscriptions" on push_subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 4. Who has been told about which reminder
--
-- Reminders on a shared list go to everybody who can see the list —
-- the owner and every collection_members row — not just the owner.
-- See supabase/functions/send-reminders.
--
-- That makes Activities.reminder_sent_at unusable as the "already
-- sent" marker: it is one column for what is now several recipients,
-- so the first successful send would silently consume the notification
-- for the whole list. This tracks it per person instead.
--
-- remind_at is part of the key on purpose. Moving a reminder re-arms
-- it for everyone automatically, because the new date has no delivery
-- rows against it — no trigger has to clear anything.
--
-- No RLS policy: nothing in the browser reads or writes this. The Edge
-- Function uses the service role, which bypasses RLS. Enabling it with
-- no policy is what makes that true rather than merely assumed.
-- ------------------------------------------------------------
create table if not exists reminder_deliveries (
  activity_id uuid not null references "Activities"(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  remind_at   date not null,
  sent_at     timestamptz not null default now(),
  primary key (activity_id, user_id, remind_at)
);

create index if not exists reminder_deliveries_activity_idx
  on reminder_deliveries(activity_id);

alter table reminder_deliveries enable row level security;


-- ------------------------------------------------------------
-- 5. Re-arm a reminder when it is moved
--
-- Now belt-and-braces: reminder_deliveries above is keyed on the date,
-- so a moved reminder is re-armed for every recipient without this.
-- Kept because Activities.reminder_sent_at is still written, and
-- leaving it stale would mislead anyone reading the column directly.
--
-- Without this, changing remind_at on an activity that has already been
-- notified would never fire again, because reminder_sent_at is still
-- set from the old date.
-- ------------------------------------------------------------
create or replace function reset_reminder_sent()
returns trigger
language plpgsql
as $$
begin
  if new.remind_at is distinct from old.remind_at then
    new.reminder_sent_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists activities_reset_reminder_sent on "Activities";
create trigger activities_reset_reminder_sent
  before update on "Activities"
  for each row execute function reset_reminder_sent();
