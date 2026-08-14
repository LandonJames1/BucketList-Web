-- =============================================================
-- RLS LOCKDOWN — remove the "any signed-in user can do anything"
-- policies.
--
-- RUN THIS. Until you do, every account can read, edit and delete
-- every other account's data.
--
-- =============================================================
-- WHAT WAS WRONG
--
-- Three policies, one per table, all shaped like this:
--
--   policyname  ALL
--   roles       {authenticated}
--   cmd         ALL
--   qual        true
--
-- "Any logged-in user, any operation, any row." They are the kind of
-- policy the dashboard offers as a starter template to get a project
-- working, and they were never taken back out.
--
-- Postgres OR's permissive policies together, so these did not sit
-- alongside the correct bl_* policies — they SUPERSEDED them. Every
-- careful `user_id = auth.uid()` check next to them was dead code.
--
-- They were also invisible to the obvious test. Scoped to
-- `authenticated`, they grant nothing to a logged-out request, so
-- probing the API without a token returns an empty array and the
-- project looks locked down. It is not. Only pg_policies shows this.
--
-- =============================================================
-- IS ANYTHING RELYING ON THEM?
--
-- No. The bl_* policies already cover every operation the app
-- performs on all three tables:
--
--   Collections   select / insert / update / delete   (sharing.sql)
--   Activities    select / insert / update / delete   (sharing.sql,
--                                                      multilist.sql)
--   Users         select / insert / update            (profiles.sql)
--
-- Users has no delete policy and does not need one: the only thing
-- that deletes a Users row is supabase/functions/delete-account,
-- which runs as service_role and bypasses RLS entirely.
--
-- Reading OTHER people's Users rows is likewise not needed. The
-- member roster on a shared list shows collection_members.display_name,
-- which is denormalised at join time precisely so that this table can
-- stay private — see the note in sharing.sql. peek_invite() and
-- join_collection() read Users as SECURITY DEFINER and are unaffected.
-- =============================================================


-- -------------------------------------------------------------
-- 1. DROP THEM
--
-- Quoted because "ALL" is the actual policy name, and it is also a
-- keyword — without the quotes this is a syntax error.
-- -------------------------------------------------------------

drop policy if exists "ALL" on public."Collections";
drop policy if exists "ALL" on public."Activities";
drop policy if exists "ALL" on public."Users";


-- -------------------------------------------------------------
-- 2. MAKE SURE RLS IS ACTUALLY ON
--
-- Dropping every policy from a table with RLS disabled changes
-- nothing at all — the table is simply open. Belt and braces.
-- -------------------------------------------------------------

alter table public."Collections" enable row level security;
alter table public."Activities"  enable row level security;
alter table public."Users"       enable row level security;


-- -------------------------------------------------------------
-- 3. CHECK THE RESULT
--
-- Run this after the above. Read BOTH columns:
--
--   qual        the row filter for SELECT / UPDATE / DELETE
--   with_check  the row filter for INSERT (qual is always null for
--               INSERT, which is why a policy can look empty here and
--               still be correct — or still be wrong)
--
-- Every row must mention auth.uid(), directly or through one of the
-- helpers (owns_collection, is_collection_member, can_use_collection,
-- can_use_any_collection — all of which resolve to auth.uid()).
--
-- Anything reading plain `true` is a hole. Anything with BOTH columns
-- null is a hole.
-- -------------------------------------------------------------

select tablename, policyname, roles, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('Collections', 'Activities', 'Users',
                     'collection_members', 'collection_invites',
                     'push_subscriptions', 'reminder_deliveries')
 order by tablename, cmd, policyname;


-- -------------------------------------------------------------
-- 4. AND THAT RLS IS ON EVERYWHERE IT MATTERS
--
-- rowsecurity must be true for every row this returns.
-- -------------------------------------------------------------

select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('Collections', 'Activities', 'Users',
                     'collection_members', 'collection_invites',
                     'push_subscriptions', 'reminder_deliveries')
 order by tablename;


-- =============================================================
-- AFTERWARDS
--
-- The app needs no change and no redeploy: it has always issued the
-- correct queries, and js/api.js already filters client-side on top.
-- What changes is that the server now enforces it.
--
-- If something legitimate breaks after this, the answer is a narrow
-- policy for that specific case — never restoring a `true`.
-- =============================================================
