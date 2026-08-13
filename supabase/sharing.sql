-- =============================================================
-- SHARED LISTS
--
-- Run this once in the Supabase SQL editor. Until you do, the app
-- behaves exactly as it did before: js/sharing.js probes for the
-- collection_members table at sign-in and hides every sharing
-- affordance when it is absent — the same pattern as remind_at and
-- the media bucket.
--
-- What it adds:
--   collection_members   who can see and edit a collection
--   collection_invites   one-time-ish join codes behind a link
--   join_collection()    the only way a member row is ever created
--   peek_invite()        read an invite without accepting it
--
-- =============================================================
-- WHY INVITES AND NOT USERNAMES
--
-- Inviting by username needs a policy that lets any signed-in user
-- search the Users table, which turns a private table into a user
-- directory. A link with a random code needs nothing about the other
-- person to be known in advance, works before they have an account,
-- and travels over whatever the two people already use to talk.
--
-- =============================================================
-- WHY THE SECURITY DEFINER HELPERS
--
-- The obvious policy — "you can see a collection if you own it or
-- there is a matching row in collection_members" — recurses the
-- moment collection_members has its own policy referring back to
-- collections. Postgres detects this and errors at query time.
--
-- Wrapping the two lookups in SECURITY DEFINER functions breaks the
-- cycle: they run as the definer, so the tables they read are not
-- re-filtered by the policies being defined. They are STABLE and
-- take a single id, so they are cheap and cannot be used to read
-- anything the caller has not been handed the id of.
-- =============================================================


-- -------------------------------------------------------------
-- 1. TABLES
-- -------------------------------------------------------------

create table if not exists public.collection_members (
  collection_id uuid not null references public."Collections"(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'editor',
  -- Denormalised on purpose. Showing "Sam" beside a member row
  -- otherwise needs a policy letting you read other people's Users
  -- rows, which is a much wider door than this feature needs opened.
  -- Copied by join_collection() at the moment of joining.
  display_name  text,
  created_at    timestamptz not null default now(),
  primary key (collection_id, user_id)
);

create index if not exists collection_members_user_idx
  on public.collection_members(user_id);

create table if not exists public.collection_invites (
  -- Generated client-side from crypto.getRandomValues over a URL-safe
  -- alphabet, so the app knows the link the instant it is made rather
  -- than after a round trip.
  code          text primary key,
  collection_id uuid not null references public."Collections"(id) on delete cascade,
  created_by    uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'editor',
  revoked       boolean not null default false,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists collection_invites_collection_idx
  on public.collection_invites(collection_id);


-- -------------------------------------------------------------
-- 2. HELPERS  (see the note at the top on why these exist)
-- -------------------------------------------------------------

create or replace function public.owns_collection(cid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public."Collections" c
    where c.id = cid and c.user_id = auth.uid()
  );
$$;

create or replace function public.is_collection_member(cid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.collection_members m
    where m.collection_id = cid and m.user_id = auth.uid()
  );
$$;

-- Owner or member. What almost every policy below actually wants.
create or replace function public.can_use_collection(cid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select public.owns_collection(cid) or public.is_collection_member(cid);
$$;


-- -------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
--
-- NOTE: if this project already has policies on Collections or
-- Activities under different names, they are left in place and these
-- are added alongside. Multiple permissive policies are OR'd, so an
-- older, broader policy would keep granting whatever it granted —
-- check the Policies tab afterwards and drop anything superseded.
-- -------------------------------------------------------------

alter table public."Collections"        enable row level security;
alter table public."Activities"         enable row level security;
alter table public.collection_members   enable row level security;
alter table public.collection_invites   enable row level security;

-- ---- Collections ----
drop policy if exists bl_collections_select on public."Collections";
create policy bl_collections_select on public."Collections"
  for select using (user_id = auth.uid() or public.is_collection_member(id));

drop policy if exists bl_collections_insert on public."Collections";
create policy bl_collections_insert on public."Collections"
  for insert with check (user_id = auth.uid());

-- A member can rename a shared list and change its cover. If you would
-- rather they could not, narrow this to `user_id = auth.uid()`.
drop policy if exists bl_collections_update on public."Collections";
create policy bl_collections_update on public."Collections"
  for update using (user_id = auth.uid() or public.is_collection_member(id));

-- Deleting is the owner's alone. A member leaves instead — see the
-- delete policy on collection_members below.
drop policy if exists bl_collections_delete on public."Collections";
create policy bl_collections_delete on public."Collections"
  for delete using (user_id = auth.uid());

-- ---- Activities ----
-- Everything is decided by the collection the row belongs to, which is
-- what makes a shared list actually shared: a member adds, completes
-- and deletes activities in it exactly as the owner does.
drop policy if exists bl_activities_select on public."Activities";
create policy bl_activities_select on public."Activities"
  for select using (public.can_use_collection(collection_id));

drop policy if exists bl_activities_insert on public."Activities";
create policy bl_activities_insert on public."Activities"
  for insert with check (public.can_use_collection(collection_id));

drop policy if exists bl_activities_update on public."Activities";
create policy bl_activities_update on public."Activities"
  for update using (public.can_use_collection(collection_id));

drop policy if exists bl_activities_delete on public."Activities";
create policy bl_activities_delete on public."Activities"
  for delete using (public.can_use_collection(collection_id));

-- ---- Members ----
-- Everyone in a list can see who else is in it.
drop policy if exists bl_members_select on public.collection_members;
create policy bl_members_select on public.collection_members
  for select using (
    user_id = auth.uid()
    or public.owns_collection(collection_id)
    or public.is_collection_member(collection_id)
  );

-- Deliberately NO insert policy. The only way in is join_collection(),
-- which validates an invite first. Without this, holding any
-- collection's uuid would be enough to add yourself to it.

-- The owner can remove anyone; anyone can remove themselves (leave).
drop policy if exists bl_members_delete on public.collection_members;
create policy bl_members_delete on public.collection_members
  for delete using (public.owns_collection(collection_id) or user_id = auth.uid());

-- ---- Invites ----
-- Only the owner ever reads or writes these. A recipient never selects
-- the row; peek_invite() and join_collection() read it as definer.
drop policy if exists bl_invites_select on public.collection_invites;
create policy bl_invites_select on public.collection_invites
  for select using (public.owns_collection(collection_id));

drop policy if exists bl_invites_insert on public.collection_invites;
create policy bl_invites_insert on public.collection_invites
  for insert with check (created_by = auth.uid() and public.owns_collection(collection_id));

drop policy if exists bl_invites_update on public.collection_invites;
create policy bl_invites_update on public.collection_invites
  for update using (public.owns_collection(collection_id));

drop policy if exists bl_invites_delete on public.collection_invites;
create policy bl_invites_delete on public.collection_invites
  for delete using (public.owns_collection(collection_id));


-- -------------------------------------------------------------
-- 4. JOINING
-- -------------------------------------------------------------

-- Read an invite without accepting it, so the app can say WHAT is
-- being joined before asking. Returns only the collection's name and
-- size — never its contents, and never the owner's email.
create or replace function public.peek_invite(invite_code text)
returns jsonb
language plpgsql security definer stable
set search_path = public
as $$
declare
  inv record;
  cname text;
  owner_name text;
  n int;
begin
  select * into inv from public.collection_invites where code = invite_code;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if inv.revoked then return jsonb_build_object('ok', false, 'error', 'revoked'); end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  select c.name into cname from public."Collections" c where c.id = inv.collection_id;
  if cname is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  select coalesce(u.display_name, u.username) into owner_name
    from public."Users" u where u.id = inv.created_by;

  select count(*) into n from public."Activities" a where a.collection_id = inv.collection_id;

  return jsonb_build_object(
    'ok', true,
    'collection_id', inv.collection_id,
    'name', cname,
    'owner', coalesce(owner_name, 'Someone'),
    'count', n,
    'already', public.can_use_collection(inv.collection_id)
  );
end;
$$;

-- The only path that creates a member row.
create or replace function public.join_collection(invite_code text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  inv record;
  cname text;
  uname text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  select * into inv from public.collection_invites where code = invite_code;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if inv.revoked then return jsonb_build_object('ok', false, 'error', 'revoked'); end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  select c.name into cname from public."Collections" c where c.id = inv.collection_id;
  if cname is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  -- Following your own invite link is not an error, it just does
  -- nothing. Without this the owner would be added as a member of
  -- their own list and then appear twice in the roster.
  if exists (select 1 from public."Collections" c
             where c.id = inv.collection_id and c.user_id = auth.uid()) then
    return jsonb_build_object('ok', true, 'already', true,
      'collection_id', inv.collection_id, 'name', cname);
  end if;

  select coalesce(u.display_name, u.username) into uname
    from public."Users" u where u.id = auth.uid();

  insert into public.collection_members (collection_id, user_id, role, display_name)
  values (inv.collection_id, auth.uid(), inv.role, uname)
  on conflict (collection_id, user_id)
    do update set display_name = excluded.display_name;

  return jsonb_build_object('ok', true, 'collection_id', inv.collection_id, 'name', cname);
end;
$$;

grant execute on function public.peek_invite(text)      to authenticated;
grant execute on function public.join_collection(text)  to authenticated;
-- peek runs before sign-up finishes on some paths, so anon may read it.
-- It exposes only a list's name, owner display name and activity count.
grant execute on function public.peek_invite(text)      to anon;


-- =============================================================
-- UNDOING IT
--
--   drop function if exists public.join_collection(text);
--   drop function if exists public.peek_invite(text);
--   drop table if exists public.collection_invites;
--   drop table if exists public.collection_members;
--   drop function if exists public.can_use_collection(uuid);
--   drop function if exists public.is_collection_member(uuid);
--   drop function if exists public.owns_collection(uuid);
--
-- The policies referring to those helpers must be dropped first, or
-- Postgres refuses. The app falls straight back to single-user
-- behaviour once collection_members is gone.
-- =============================================================
