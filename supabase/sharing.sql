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
--   invite_claims        an invite waiting for an account that does
--                        not exist yet — see section 5
--   claim_invite()       record that intent, before signing up
--   claim_invites_for_me()   redeem it, on whatever device signs in
--
-- ⚠️ IF YOU HAVE ALREADY RUN AN EARLIER VERSION OF THIS FILE, RUN IT
-- AGAIN. Every statement is idempotent, and section 5 is new: without
-- it, an invite sent to somebody who has to create an account is lost
-- inside the confirmation email.
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


-- -------------------------------------------------------------
-- 5. AN INVITE FOR SOMEONE WHO DOES NOT HAVE AN ACCOUNT YET
--
-- The whole point of inviting by link is that it works on a person
-- you know nothing about in advance — including that they have never
-- heard of this app. That is also the one case the link alone cannot
-- carry, and the reason is not sharing at all, it is sign-up:
--
--   1. B opens the link. The code is captured and stripped from the
--      URL, and held in that browser's localStorage.
--   2. B has no account, so B creates one. This project confirms
--      addresses, so signUp() returns a user and NO session.
--   3. B goes to their inbox — very often on another device — and
--      opens the confirmation link. They are signed in.
--   4. The join code is in step 1's localStorage, on step 1's device,
--      which is not where B is standing. The invite is gone, nothing
--      says so, and it reads as "the link didn't do anything".
--
-- This was attempted once client-side, by carrying the code in the
-- auth user's metadata. It was reverted: the chain ran in-memory
-- global → localStorage → auth metadata → a probe race → a sheet, and
-- every link in it fails silently, so each fix was a guess about which
-- one had broken.
--
-- So the intent is recorded HERE instead, keyed by the email address
-- being signed up with, before signUp() is even called. That has no
-- device, no browser storage, no dependency on which copy of the
-- client-side code happens to be running, and no dependency on the
-- email template. Whatever device B eventually signs in on asks the
-- server "is anything waiting for me?" and the answer is a row.
--
-- WHY NO TRIGGER ON auth.users. The obvious shape is a trigger that
-- creates the membership when the account row appears (the way
-- profiles.sql creates the Users row). Deliberately not done:
--
--   - it would join B to a list before B has confirmed the address,
--     i.e. before we know B owns it;
--   - it fires exactly once, so if it errors the invite is gone for
--     good — where an unclaimed row here simply waits and is redeemed
--     on the next sign-in;
--   - the client cannot then TELL B they have joined, and an invite
--     that silently works is only marginally better than one that
--     silently doesn't. claim_invites_for_me() returns what it joined,
--     so the app can say so and open the list.
--
-- WHAT THIS EXPOSES. claim_invite() is callable by anon — it has to
-- be, there is no session at sign-up — so anyone holding a live invite
-- code can register any address against it. The consequence is that if
-- that address later signs up, the shared list appears in their
-- account, which they can leave. Someone holding the code could
-- already have emailed it to that address directly, so this widens
-- nothing meaningfully. Claims are capped per address, expire, and are
-- never readable: RLS is on with no policies at all, so PostgREST
-- returns nothing to anyone, and only the definer functions below can
-- see the table.
-- -------------------------------------------------------------

create table if not exists public.invite_claims (
  -- Lower-cased by claim_invite(); auth.users.email is compared the
  -- same way, so "Foo@Bar.com" and "foo@bar.com" are one person.
  email      text not null,
  code       text not null references public.collection_invites(code) on delete cascade,
  created_at timestamptz not null default now(),
  -- Set when it has been acted on. The row is kept rather than deleted
  -- so a second sign-in cannot re-announce a join that already
  -- happened, and so the table can be read when debugging one of these.
  claimed_at timestamptz,
  claimed_by uuid references auth.users(id) on delete set null,
  primary key (email, code)
);

create index if not exists invite_claims_pending_idx
  on public.invite_claims (email) where claimed_at is null;

-- No policies, on purpose. See the note above.
alter table public.invite_claims enable row level security;

-- How long an unredeemed claim is good for. Longer than a confirmation
-- link (24h) by a wide margin, because people sign up and then go and
-- do something else for a week.
create or replace function public.invite_claim_ttl()
returns interval language sql immutable as $$ select interval '30 days' $$;

-- Record that whoever is about to sign up with this address means to
-- join this list. Callable before there is any session at all.
create or replace function public.claim_invite(invite_code text, claim_email text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  inv     record;
  addr    text := lower(trim(coalesce(claim_email, '')));
  pending int;
begin
  -- Not validation for its own sake: this is the one anon-callable
  -- write in the schema, so it refuses anything that is not plausibly
  -- an address rather than accumulating junk rows.
  if addr = '' or addr not like '%_@_%.__%' then
    return jsonb_build_object('ok', false, 'error', 'bad_email');
  end if;

  -- Opportunistic housekeeping. Nothing else sweeps this table, and a
  -- claim nobody redeemed is worthless the moment it expires.
  delete from public.invite_claims
   where claimed_at is null and created_at < now() - public.invite_claim_ttl();

  select * into inv from public.collection_invites where code = invite_code;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if inv.revoked then return jsonb_build_object('ok', false, 'error', 'revoked'); end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  select count(*) into pending
    from public.invite_claims where email = addr and claimed_at is null;
  if pending >= 10 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;

  insert into public.invite_claims (email, code) values (addr, invite_code)
  on conflict (email, code) do nothing;

  return jsonb_build_object('ok', true);
end;
$$;

-- The other end: redeem anything waiting for the signed-in address.
-- Returns only the lists this call actually joined, so the app can say
-- so — a list that silently appeared is barely better than one that
-- never did.
create or replace function public.claim_invites_for_me()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  addr   text;
  uname  text;
  rec    record;
  inv    record;
  cname  text;
  joined jsonb := '[]'::jsonb;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  select lower(trim(u.email)) into addr from auth.users u where u.id = uid;
  if addr is null or addr = '' then
    return jsonb_build_object('ok', true, 'joined', joined);
  end if;

  select coalesce(u.display_name, u.username) into uname
    from public."Users" u where u.id = uid;

  for rec in
    select * from public.invite_claims
     where email = addr and claimed_at is null
     order by created_at
  loop
    select * into inv from public.collection_invites where code = rec.code;

    if found
       and not inv.revoked
       and (inv.expires_at is null or inv.expires_at >= now())
       and (rec.created_at + public.invite_claim_ttl()) >= now()
    then
      select c.name into cname from public."Collections" c where c.id = inv.collection_id;
      -- Already in it — the owner following their own link, or the
      -- ordinary link path having joined them a moment ago on this same
      -- device. Consume the claim quietly: announcing a join that has
      -- already happened is how the reverted attempt read from outside.
      if cname is not null and not public.can_use_collection(inv.collection_id) then
        insert into public.collection_members (collection_id, user_id, role, display_name)
        values (inv.collection_id, uid, inv.role, uname)
        on conflict (collection_id, user_id) do update set display_name = excluded.display_name;

        joined := joined || jsonb_build_array(
          jsonb_build_object('collection_id', inv.collection_id, 'name', cname));
      end if;
    end if;

    -- Claimed either way. A revoked, expired or deleted invite is not
    -- going to become good again, and leaving the row would mean
    -- re-checking it on every launch for the life of the account.
    update public.invite_claims
       set claimed_at = now(), claimed_by = uid
     where email = rec.email and code = rec.code;
  end loop;

  return jsonb_build_object('ok', true, 'joined', joined);
end;
$$;

grant execute on function public.claim_invite(text, text)   to anon, authenticated;
grant execute on function public.claim_invites_for_me()     to authenticated;


-- =============================================================
-- UNDOING IT
--
--   drop function if exists public.claim_invites_for_me();
--   drop function if exists public.claim_invite(text, text);
--   drop function if exists public.invite_claim_ttl();
--   drop table if exists public.invite_claims;
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
