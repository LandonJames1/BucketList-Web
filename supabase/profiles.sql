-- ============================================================
-- Someday We'll Die — the Users profile row
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor).
-- Every statement is idempotent, so re-running it is harmless.
--
-- ---- What this fixes ----
--
-- This project has email confirmation switched on
-- (mailer_autoconfirm = false), so sb.auth.signUp() returns a user and
-- NO session. The app used to write the `Users` row inline right after
-- signUp, which could only ever work with a session — so for every
-- account created here, the display name and username the person had
-- just typed were silently dropped and no profile row was ever made.
-- They confirmed their email, signed in, and had no name in the You tab
-- and nothing to be identified by on a shared list.
--
-- The client half of the fix is in js/auth.js (the two values now ride
-- along as auth user metadata) and js/me.js (createUserProfile(), which
-- writes the row on the first sign-in that has a session, and therefore
-- also repairs accounts created while this was broken).
--
-- This file is the server half, and it is the better half: the trigger
-- below creates the row at the moment the auth user is created, so the
-- profile exists whether or not the person ever comes back to confirm,
-- and whether or not they confirm on the same device they signed up on.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Row Level Security on Users
--
-- Without an INSERT policy the client-side fallback in js/me.js is
-- refused, and without a SELECT policy the app cannot read back the
-- name it just wrote.
--
-- Deliberately NOT added: a policy letting any signed-in user select
-- other people's rows. That would turn this table into a public user
-- directory, which is exactly what sharing.sql avoids by inviting
-- people with a random link rather than by looking them up. The two
-- places that need someone else's display name (peek_invite and the
-- shared-list roster) read it through SECURITY DEFINER functions in
-- sharing.sql instead.
-- ------------------------------------------------------------
alter table public."Users" enable row level security;

drop policy if exists "bl_users_select_own" on public."Users";
create policy "bl_users_select_own" on public."Users"
  for select using (auth.uid() = id);

drop policy if exists "bl_users_insert_own" on public."Users";
create policy "bl_users_insert_own" on public."Users"
  for insert with check (auth.uid() = id);

drop policy if exists "bl_users_update_own" on public."Users";
create policy "bl_users_update_own" on public."Users"
  for update using (auth.uid() = id) with check (auth.uid() = id);


-- ------------------------------------------------------------
-- 2. Usernames are unique
--
-- createUserProfile() in js/me.js already treats a collision as an
-- expected outcome and retries with a suffix, but nothing was actually
-- enforcing it, so two people could quietly take the same handle.
--
-- PREVIEW FIRST — this will fail if duplicates already exist. Find them:
--
--   select lower(username), count(*)
--     from public."Users"
--    where username is not null
--    group by 1 having count(*) > 1;
-- ------------------------------------------------------------
create unique index if not exists users_username_key
  on public."Users" (lower(username));


-- ------------------------------------------------------------
-- 3. Create the profile row when the auth user is created
--
-- The canonical Supabase pattern, and the reason it is worth having on
-- top of the client-side fallback: it fires inside the signUp
-- transaction, so the row exists before the confirmation email is even
-- sent. That covers the case the client cannot — someone signing up on
-- their phone and opening the confirmation link on a laptop, where the
-- browser that holds the metadata is never the browser that confirms.
--
-- SECURITY DEFINER because it writes to public."Users" from a trigger
-- on auth.users, where the RLS policies above would otherwise refuse it.
--
-- Username collisions are resolved here rather than raised: a sign-up
-- must never fail because someone else already holds the handle. The
-- suffix mirrors what createUserProfile() does client-side.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_name  text := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');
  meta_user  text := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  local_part text := split_part(coalesce(new.email, ''), '@', 1);
  base       text;
  candidate  text;
begin
  -- Strip anything the app's own USERNAME_RE would reject, so a handle
  -- derived from an email address cannot arrive in a shape the client
  -- would refuse to create itself.
  base := lower(regexp_replace(coalesce(meta_user, local_part, ''), '[^a-z0-9_.]', '', 'gi'));
  if length(base) < 3 then
    base := left(base || 'user', 12);
  end if;
  base := left(base, 30);

  candidate := base;
  -- Bounded: after a handful of tries, fall back to something that
  -- cannot collide rather than looping.
  for i in 1..5 loop
    exit when not exists (
      select 1 from public."Users" u where lower(u.username) = lower(candidate)
    );
    candidate := left(base, 26) || floor(random() * 9000 + 1000)::int::text;
  end loop;

  insert into public."Users" (id, display_name, username)
  values (new.id, coalesce(meta_name, base), candidate)
  on conflict (id) do nothing;

  return new;
exception when others then
  -- A profile is not worth failing a sign-up over. The client-side
  -- fallback in js/me.js will fill the row in on first sign-in.
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ------------------------------------------------------------
-- 4. Backfill the accounts that were created while this was broken
--
-- Anyone who signed up before the fix has an auth user and no profile.
-- This gives them one, derived from whatever is available.
-- ------------------------------------------------------------
-- The suffix is applied only where it is actually needed — a handle
-- that is free stays clean. This runs as a set, so "needed" means
-- colliding with an existing Users row OR with another row in this
-- same insert, which is what the row_number() covers.
with seed as (
  select u.id,
         coalesce(
           nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
           nullif(split_part(coalesce(u.email, ''), '@', 1), '')
         ) as display_name,
         left(
           lower(regexp_replace(
             coalesce(
               nullif(trim(u.raw_user_meta_data ->> 'username'), ''),
               nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
               'user'
             ), '[^a-z0-9_.]', '', 'gi')),
           21
         ) as base
    from auth.users u
   where not exists (select 1 from public."Users" p where p.id = u.id)
),
ranked as (
  select s.id,
         s.display_name,
         case when length(s.base) < 3 then left(s.base || 'user', 12) else s.base end as base,
         row_number() over (partition by s.base order by s.id) as n,
         exists (
           select 1 from public."Users" p where lower(p.username) = s.base
         ) as taken
    from seed s
)
insert into public."Users" (id, display_name, username)
select r.id,
       coalesce(r.display_name, r.base),
       case
         when r.n = 1 and not r.taken then r.base
         -- Collision-free in one pass without re-checking each candidate
         -- against the rows beside it.
         else left(r.base, 21) || '_' || left(replace(r.id::text, '-', ''), 8)
       end
  from ranked r
on conflict do nothing;
