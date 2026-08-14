-- =============================================================
-- ONE ACTIVITY, ANY NUMBER OF LISTS
--
-- Run this once in the Supabase SQL editor. Until you do, the app
-- behaves exactly as it did before: js/api.js probes for the column
-- at sign-in and the Lists row in the activity sheet stays
-- single-select — the same pattern as remind_at, the media bucket
-- and collection_members.
--
-- Every statement is idempotent, so re-running it is harmless.
--
-- =============================================================
-- WHY A COLUMN AND NOT A JUNCTION TABLE
--
-- The relationally correct answer is activity_collections(activity_id,
-- collection_id). It was not chosen, and the reason is the shape of
-- this particular client rather than a general preference.
--
-- The app is backed by exactly two queries — every collection, and
-- every activity in them — both cached in memory for the session and
-- mirrored into IndexedDB so the thing works on a plane. A junction
-- table is a third query, a third snapshot store, a third entry in
-- the offline write queue's replay logic, and a new SECURITY DEFINER
-- helper to keep its RLS from recursing. An array column is none of
-- those: it is one more column on a row the client already writes, so
-- the cache, the snapshot and the offline queue carry it with no code
-- at all.
--
-- Both allow an unbounded number of lists per activity. Postgres
-- arrays have no fixed length, and the GIN index below makes the
-- containment lookup an index scan rather than a table scan, so the
-- thing a junction table would buy — querying membership efficiently
-- — is bought here too.
--
-- If this app ever needs per-membership data (who added it to this
-- list, when, in what position) the array stops being enough and the
-- junction table is the migration. Nothing here blocks that.
--
-- =============================================================
-- THE HOME LIST STAYS
--
-- collection_id is unchanged and still NOT NULL: it is the activity's
-- home list, and it is the one every existing policy, query and index
-- already keys on. extra_collection_ids holds the *others*.
--
-- So the full set is `collection_id || extra_collection_ids`, and the
-- client (mapActivity, in js/api.js) is the one place that assembles
-- it — exposed as a.listIds, with a.listId still meaning the home
-- list. An activity with no extras is byte-for-byte the row it was
-- before this migration, which is what makes the whole thing
-- backwards compatible: nothing has to be backfilled.
-- =============================================================


-- -------------------------------------------------------------
-- 1. THE COLUMN
-- -------------------------------------------------------------

alter table public."Activities"
  add column if not exists extra_collection_ids uuid[] not null default '{}'::uuid[];

-- Containment (`&&`, `@>`) against this needs GIN or it is a
-- sequential scan of the table on every list fetch.
create index if not exists activities_extra_collections_idx
  on public."Activities" using gin (extra_collection_ids);


-- -------------------------------------------------------------
-- 2. RLS
--
-- Only relevant if sharing.sql has been run — that is what turns RLS
-- on for Activities and creates can_use_collection(). Without it this
-- whole block is skipped, because there are no policies to widen and
-- the helper it needs does not exist.
--
-- WHAT CHANGES: an activity is visible and editable if you can use
-- ANY of its lists, not only its home list. That is the entire point
-- of the feature — an activity homed in someone's private list and
-- added to a list they share with you has to be readable by you, and
-- its home list is one you cannot see.
--
-- WHAT THAT MEANS IN PRACTICE: adding an activity to a shared list
-- grants everyone on that list read and write on the activity, which
-- is the same thing that has always been true of an activity created
-- in a shared list. It does NOT grant them anything in the other
-- lists it belongs to.
-- -------------------------------------------------------------

-- Owner-or-member of at least one of the ids. STABLE and SECURITY
-- DEFINER for the same reason its single-id sibling is: see the
-- header of sharing.sql on policy recursion.
create or replace function public.can_use_any_collection(cids uuid[])
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from unnest(coalesce(cids, '{}'::uuid[])) as cid
    where public.can_use_collection(cid)
  );
$$;

grant execute on function public.can_use_any_collection(uuid[]) to authenticated;

do $$
begin
  if to_regprocedure('public.can_use_collection(uuid)') is null then
    raise notice 'sharing.sql has not been run — skipping the Activities policies. '
                 'Nothing else in this file depends on them.';
    return;
  end if;

  drop policy if exists bl_activities_select on public."Activities";
  create policy bl_activities_select on public."Activities"
    for select using (
      public.can_use_collection(collection_id)
      or public.can_use_any_collection(extra_collection_ids)
    );

  drop policy if exists bl_activities_update on public."Activities";
  create policy bl_activities_update on public."Activities"
    for update using (
      public.can_use_collection(collection_id)
      or public.can_use_any_collection(extra_collection_ids)
    );

  -- Deleting is deliberately NOT widened to the extra lists. Removing
  -- an activity from a list you share is a matter of taking that list
  -- out of extra_collection_ids — an update, covered above. Destroying
  -- the row, along with its photos and the record of it being done,
  -- belongs to whoever can use the list it actually lives in.
  drop policy if exists bl_activities_delete on public."Activities";
  create policy bl_activities_delete on public."Activities"
    for delete using (public.can_use_collection(collection_id));

  -- Insert is unchanged and stays keyed on the home list: you can only
  -- create an activity somewhere you can already write. The extras are
  -- then checked by the update policy on the way in, since a row whose
  -- extras you cannot use is a row you could not have written.
end
$$;


-- =============================================================
-- UNDOING IT
--
--   -- put the policies back the way sharing.sql left them
--   drop policy if exists bl_activities_select on public."Activities";
--   create policy bl_activities_select on public."Activities"
--     for select using (public.can_use_collection(collection_id));
--   drop policy if exists bl_activities_update on public."Activities";
--   create policy bl_activities_update on public."Activities"
--     for update using (public.can_use_collection(collection_id));
--
--   drop function if exists public.can_use_any_collection(uuid[]);
--   drop index if exists public.activities_extra_collections_idx;
--   alter table public."Activities" drop column if exists extra_collection_ids;
--
-- Dropping the column loses every extra membership; each activity
-- falls back to its home list alone. Nothing else is affected, and
-- the app returns to single-list behaviour as soon as the probe in
-- js/api.js comes back false.
-- =============================================================
