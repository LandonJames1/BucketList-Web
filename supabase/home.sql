-- ============================================================
-- Someday We'll Die — the saved Home address
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor).
-- Every statement is idempotent, so re-running it is harmless.
--
-- ---- What this is for ----
--
-- One saved place per user. It does two jobs in the app:
--
--   1. the "Home" shortcut at the top of every location dropdown, so
--      setting an activity's location to home needs no typing;
--   2. the bias point for place search when there is no geolocation
--      fix — which is most of the time, because the app deliberately
--      never raises a permission prompt just because you focused a
--      text field. This is the quieter job and the more valuable one:
--      it is what makes a search for "coffee" return the cafés near
--      you rather than Coffee County, Georgia.
--
-- ---- This file is OPTIONAL ----
--
-- Like every other migration here, the app probes for what it needs
-- and degrades rather than breaking. Without these columns Home still
-- works, but it is stored in localStorage and therefore lives on one
-- device: sign in on a phone and the home address set on the laptop
-- is not there. js/me.js says so once in the console and carries on.
--
-- Run it and the value follows the account instead. A home address
-- already saved on a device is pushed up on the next load, so nobody
-- has to re-enter it.
--
-- ---- Why three columns and not a table ----
--
-- The same argument as supabase/multilist.sql, only more so: this is
-- exactly one optional place per user, with no ordering, no history
-- and no per-row metadata. `Users` is already read once per session by
-- loadUserProfile(). A table would be a second query, a second RLS
-- policy set and a join, to hold at most one row per person.
--
-- If saved places ever become plural — Home, Work, the cabin — that is
-- the point at which this becomes `user_places`, and this file is the
-- migration to write away from.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The columns
--
-- Nullable, no default: "no home set" is the normal state and has to
-- be representable. location_lat/lng mirror the naming on Activities,
-- prefixed so the three read as one thing.
-- ------------------------------------------------------------
alter table public."Users" add column if not exists home_location text;
alter table public."Users" add column if not exists home_lat double precision;
alter table public."Users" add column if not exists home_lng double precision;


-- ------------------------------------------------------------
-- 2. "This activity is at home"
--
-- Set when an activity's location was chosen with the Home shortcut,
-- and it is what makes changing your home address move those
-- activities with it. "Book a plumber", "clear the gutters" and
-- "finish the garage" are at home rather than at an address; after a
-- move they should not still be pinned to a house somebody else lives
-- in, and re-pointing them one at a time is the chore nobody does.
--
-- ---- Why a column and not a text match ----
--
-- The obvious implementation needs no schema at all: find activities
-- whose `location` equals the old home address and rewrite them. It is
-- wrong, and wrong in this app's worst way — silently. If home is
-- "Denver, Colorado" and the user separately searched for and picked
-- Denver for a hike, because the hike is in Denver and not because
-- they live there, then moving to Austin drags the hike to Austin too
-- and nothing on screen says so.
--
-- The flag records INTENT, which text cannot. Picking Home means "my
-- home, wherever that is". Picking a place that happens to be the same
-- town means that town, permanently.
--
-- Default false, so every existing row is unflagged and unaffected.
-- ------------------------------------------------------------
alter table public."Activities"
  add column if not exists location_is_home boolean not null default false;

-- The only query against it is "mine, flagged", and it is run on a
-- write path where the user is waiting. Partial, because false is the
-- overwhelming majority and there is no reason to index it.
create index if not exists activities_location_is_home_idx
  on public."Activities" (location_is_home)
  where location_is_home;


-- ------------------------------------------------------------
-- 3. RLS
--
-- Nothing to add, and that is the point of putting these on `Users`
-- rather than in a new table: supabase/profiles.sql already restricts
-- every row of this table to its owner, for select and for update.
-- These columns inherit that.
--
-- Confirm it rather than assuming it — this project shipped once with
-- a permissive policy OR'ing over the correct ones, and an anonymous
-- probe cannot tell you (see the Security note in CLAUDE.md). The
-- policies on Users should be owner-scoped and nothing else:
--
--   select policyname, cmd, qual, with_check
--     from pg_policies
--    where schemaname = 'public' and tablename = 'Users';
--
-- A home address is more personal than anything else in this table.
-- If that query returns a policy with `using (true)`, stop and fix it
-- before running the rest of this file.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 4. Check it worked
--
-- Expect four rows: three on Users, one on Activities.
-- ------------------------------------------------------------
select table_name, column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and (   (table_name = 'Users'      and column_name in ('home_location','home_lat','home_lng'))
        or (table_name = 'Activities' and column_name  = 'location_is_home'))
 order by table_name, column_name;
