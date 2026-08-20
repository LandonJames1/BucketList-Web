-- =============================================================
-- PROFILE PHOTOS — an avatar on the Users row, and the one way
-- other people are allowed to see it.
--
-- Optional, like every other migration here. Without it the app
-- keeps drawing the initial-letter discs it always drew:
-- probeAvatars() in js/me.js checks for the column once at sign-in
-- and the upload row on the You tab hides itself when it is absent.
--
-- ---- What this adds ----
--
--   Users.avatar_url        the photo, as a public storage URL
--   collection_avatars(id)  everyone's avatar for one shared list
--
-- ---- Why the RPC exists ----
--
-- profiles.sql deliberately does NOT grant a signed-in user SELECT
-- on anybody else's Users row — that would turn a private table
-- into a directory of every account on the project, searchable by
-- name and handle. That decision stands, and it is the reason a
-- message's avatar cannot simply be joined onto Users from the
-- client.
--
-- So the disclosure is narrowed to exactly what the Messages tab
-- needs and no more: given a collection you are actually in, the
-- avatars of the people who are also in it. It returns the id and
-- the photo and nothing else — no email, no handle, no display
-- name (the message already carries a snapshot of that). Scoped by
-- can_use_collection(), the same helper every messages policy
-- uses, so being in the list is the whole of the permission check.
--
-- SECURITY DEFINER because it reads Users past that table's own
-- RLS, which is the entire point; `set search_path` because a
-- definer function without one is how privilege escalation gets in.
--
-- ---- Where the file itself lives ----
--
-- In the `media` bucket from storage.sql, under the uploader's own
-- folder, exactly like a completion photo — same bucket, same
-- policies, same public URLs. There is no separate avatars bucket
-- and there should not be one: a second bucket would be a second
-- set of policies to keep in step for no gain.
--
-- Run AFTER profiles.sql, and after sharing.sql if you want the
-- RPC (it needs can_use_collection). Re-running is safe.
-- =============================================================


-- -------------------------------------------------------------
-- 1. THE COLUMN
-- -------------------------------------------------------------
alter table public."Users" add column if not exists avatar_url text;

-- The existing bl_users_update_own policy from profiles.sql already
-- covers writing it: a user may update their own row, and this is
-- one more field on it. Nothing further is needed to let somebody
-- set their own photo.


-- -------------------------------------------------------------
-- 2. READING OTHER PEOPLE'S
-- -------------------------------------------------------------
-- Skipped when sharing is not installed: without collection_members
-- there are no shared lists, so there is nobody else's avatar to
-- read and the client never asks for one.
do $mig$
begin
  if to_regclass('public.collection_members') is null then
    raise notice 'sharing.sql not run - skipping collection_avatars(). Your own avatar still works.';
    return;
  end if;

  execute $fn$
    create or replace function public.collection_avatars(cid uuid)
    returns table(uid uuid, avatar_url text)
    language sql
    stable
    security definer
    set search_path = public
    as $body$
      -- The owner, plus everyone who has joined. Exactly the audience
      -- send-message-push builds, and exactly the set of people whose
      -- names can appear in this conversation.
      select u.id, u.avatar_url
      from public."Users" u
      where public.can_use_collection(cid)
        and u.avatar_url is not null
        and (
          u.id = (select c.user_id from public."Collections" c where c.id = cid)
          or exists (
            select 1 from public.collection_members m
            where m.collection_id = cid and m.user_id = u.id
          )
        );
    $body$;
  $fn$;

  execute 'revoke all on function public.collection_avatars(uuid) from public';
  execute 'grant execute on function public.collection_avatars(uuid) to authenticated';
end $mig$;
