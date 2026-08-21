-- =============================================================
-- ONE ACTIVITY, ONE LIST
--
-- Reverses supabase/multilist.sql, which used to let an activity sit
-- in several collections at once via an `extra_collection_ids` array.
-- That is gone from the app; this takes it out of the database so the
-- schema and the client agree.
--
-- Run this once in the Supabase SQL editor. Every statement is
-- idempotent, so re-running it is harmless, and a project that never
-- ran multilist.sql can run this safely too — it will simply find
-- nothing to drop.
--
-- =============================================================
-- WHAT IS LOST, AND WHAT IS NOT
--
-- Dropping the column loses every EXTRA membership. Each activity
-- falls back to `collection_id`, its home list — the one it was
-- created in and the one every query, index and policy has always
-- keyed on. No activity is deleted and no activity is left without a
-- list: `collection_id` is NOT NULL, so every row still belongs
-- somewhere.
--
-- Section 0 below prints the rows that are about to lose a
-- membership. It writes nothing. If any of those matter, note them
-- down first — after section 3 there is no way to recover them.
-- =============================================================


-- -------------------------------------------------------------
-- 0. WHAT WILL BE LOST  (read-only; nothing here changes anything)
--
-- Run this on its own first if you want to see it. Each row is an
-- activity that is in more than one list today and will be in one
-- list afterwards.
-- -------------------------------------------------------------

do $$
declare n bigint;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='Activities'
      and column_name='extra_collection_ids'
  ) then
    execute 'select count(*) from public."Activities"
             where coalesce(array_length(extra_collection_ids, 1), 0) > 0'
      into n;
    raise notice '% activities will drop back to their home list.', n;
  else
    raise notice 'No extra_collection_ids column — nothing to undo.';
  end if;
end $$;


-- -------------------------------------------------------------
-- 1. THE POLICIES, BACK TO THE HOME LIST
--
-- multilist.sql widened select and update to "any list you can use".
-- Put them back the way sharing.sql left them, BEFORE the column goes
-- — a policy referencing a dropped column would block the drop.
--
-- Skipped entirely when sharing.sql has not been run: there are no
-- bl_* policies to narrow and can_use_collection() does not exist.
-- -------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.can_use_collection(uuid)') is null then
    raise notice 'sharing.sql has not been run — skipping the Activities policies.';
    return;
  end if;

  drop policy if exists bl_activities_select on public."Activities";
  create policy bl_activities_select on public."Activities"
    for select using (public.can_use_collection(collection_id));

  drop policy if exists bl_activities_update on public."Activities";
  create policy bl_activities_update on public."Activities"
    for update using (public.can_use_collection(collection_id));

  -- Delete and insert were never widened; they are already keyed on
  -- the home list and are left exactly as they are.
end $$;


-- -------------------------------------------------------------
-- 2. can_use_activity(), BACK TO THE HOME LIST
--
-- messages.sql installs a wider version of this helper when the
-- column exists — an activity reachable through any of its lists.
-- It has to be replaced before the column is dropped, for the same
-- reason as the policies above.
--
-- Skipped when messages.sql has not been run.
-- -------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.can_use_activity(uuid)') is null then
    raise notice 'messages.sql has not been run — skipping can_use_activity().';
    return;
  end if;

  execute $fn$
    create or replace function public.can_use_activity(aid uuid)
    returns boolean
    language sql security definer stable
    set search_path = public
    as $body$
      select exists (
        select 1 from public."Activities" a
        where a.id = aid and public.can_use_collection(a.collection_id)
      );
    $body$;
  $fn$;
end $$;


-- -------------------------------------------------------------
-- 3. THE COLUMN
--
-- Last, once nothing references it. The index goes with it either
-- way; dropping it explicitly keeps this readable.
--
-- can_use_any_collection() was created by multilist.sql and has no
-- other caller once the policies above are narrowed.
-- -------------------------------------------------------------

drop index if exists public.activities_extra_collections_idx;

alter table public."Activities"
  drop column if exists extra_collection_ids;

drop function if exists public.can_use_any_collection(uuid[]);


-- =============================================================
-- PUTTING IT BACK
--
-- There is no undo for the memberships, but the schema itself is one
-- file away: supabase/multilist.sql is in this repo's history and
-- re-running it recreates the column, the index, the helper and the
-- widened policies. Every activity would start with an empty array.
-- The app would also have to learn multi-list again — it no longer
-- reads or writes the column at all.
-- =============================================================
