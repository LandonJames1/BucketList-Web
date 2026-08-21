-- =============================================================
-- MESSAGES — a conversation per shared list, plus the append-only
-- notes log on an activity.
--
-- Run this AFTER supabase/sharing.sql. It depends on that file's
-- collection_members table and on its three SECURITY DEFINER
-- helpers (owns_collection / is_collection_member /
-- can_use_collection) — read that file's header for why those exist
-- and why policies here call them instead of writing the subquery
-- out longhand.
--
-- ---- What this adds ----
--
--   messages             one row per message, scoped to a collection
--   conversation_reads   how far each person has read, per list
--   activity_notes       the append-only log on an activity
--   conversation_prefs   per-person mute, read by send-message-push
--   conversation_list()  the hub query — one round trip for the
--                        Messages tab, see below
--   can_use_activity()   the notes policies' helper
--
-- ---- Only shared lists have a conversation ----
--
-- A conversation exists for a collection with at least one row in
-- collection_members. A list nobody else is in has nobody to talk
-- to, and a chat with yourself on every private list would be the
-- Messages tab's entire content for most people. Nothing here
-- creates a conversation: it is simply the messages that exist for
-- a collection, so sharing a list makes one and it needs no setup.
--
-- ---- Messages outlive their author ----
--
-- sender_id is `on delete set null`, and sender_name is a snapshot
-- of the display name taken when the message was sent. Deleting an
-- account therefore leaves the conversation intact and readable —
-- deleting somebody's messages tears holes in a discussion other
-- people had and still need. The null sender_id is what the client
-- renders as "Deleted account"; the snapshot is only there so the
-- rest of the thread still reads as a conversation between people.
--
-- The same applies to activity_notes.author_id.
--
-- ---- Why activity_notes is a table and not a JSON column ----
--
-- Activities.description is dead and unused, and stuffing the log
-- into it would need no migration at all. It was rejected: the
-- whole point of an append-only log is that two people adding to it
-- at once cannot clobber each other, and a JSON array in one column
-- is exactly the last-write-wins field the log exists to replace.
-- Row-level appends never conflict. description stays dead.
-- =============================================================


-- -------------------------------------------------------------
-- 0. PREFLIGHT
-- -------------------------------------------------------------
do $$
begin
  if to_regclass('public.collection_members') is null then
    raise exception 'Run supabase/sharing.sql first — messages are scoped to shared lists.';
  end if;
end $$;


-- -------------------------------------------------------------
-- 1. TABLES
-- -------------------------------------------------------------

create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public."Collections"(id) on delete cascade,
  -- Set null rather than cascade: see the header. The message stays.
  sender_id     uuid references auth.users(id) on delete set null,
  -- Snapshot of the sender's display name at send time, exactly as
  -- collection_members.display_name is. Keeps the thread readable
  -- once the account is gone, and saves a join on every read.
  sender_name   text,
  body          text not null default '',
  -- Which activities this message is about. An array rather than a
  -- junction table: this app is backed by two cached queries and a
  -- junction table would be a third, plus its own RLS helper, for a
  -- handful of ids the client already writes with the row. Renders as
  -- chips; the array is authoritative, not the text.
  activity_ids  uuid[] not null default '{}',
  created_at    timestamptz not null default now(),
  edited_at     timestamptz,
  -- Soft delete: a removed message leaves a tombstone so the thread
  -- does not silently reflow under someone who is reading it.
  deleted_at    timestamptz
);

create index if not exists messages_collection_idx
  on public.messages(collection_id, created_at desc);
create index if not exists messages_activities_idx
  on public.messages using gin(activity_ids);

-- How far each person has read each conversation. One row per
-- person per list, which is the same shape reminder_deliveries uses
-- and for the same reason: one column on the conversation could not
-- serve several readers.
create table if not exists public.conversation_reads (
  collection_id uuid not null references public."Collections"(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  last_read_at  timestamptz not null default now(),
  primary key (collection_id, user_id)
);

-- The append-only log on an activity. Entries are attributed and
-- timestamped; an author (or the list's owner) can remove one.
create table if not exists public.activity_notes (
  id          uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public."Activities"(id) on delete cascade,
  author_id   uuid references auth.users(id) on delete set null,
  author_name text,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists activity_notes_activity_idx
  on public.activity_notes(activity_id, created_at);


-- -------------------------------------------------------------
-- 2. HELPERS
--
-- can_use_activity() is can_use_collection() reached through an
-- activity. SECURITY DEFINER for the same reason the helpers in
-- sharing.sql are: a policy on activity_notes that selected from
-- "Activities" directly would re-enter that table's own policies.
-- -------------------------------------------------------------

create or replace function public.can_use_activity(aid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public."Activities" a
    where a.id = aid and public.can_use_collection(a.collection_id)
  );
$$;

-- Does the caller own the collection this activity is homed in?
-- Only used to let a list's owner remove somebody else's note; the
-- home list is the right one to ask about, since that is the list
-- the activity actually belongs to.
create or replace function public.owns_activity_collection(aid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public."Activities" a
    where a.id = aid and public.owns_collection(a.collection_id)
  );
$$;


-- -------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
--
-- Reading is "anyone who can use the collection". Writing is that
-- AND being the author — nobody edits or deletes somebody else's
-- message. The one widening is that a list's OWNER can remove a
-- note or a message from their own list, which is the moderation
-- floor a shared space needs.
-- -------------------------------------------------------------

alter table public.messages           enable row level security;
alter table public.conversation_reads enable row level security;
alter table public.activity_notes     enable row level security;

-- ---- messages ----
drop policy if exists bl_messages_select on public.messages;
create policy bl_messages_select on public.messages
  for select to authenticated
  using (public.can_use_collection(collection_id));

-- sender_id must be the caller: without this check anyone in the
-- list could post as anybody else in it.
drop policy if exists bl_messages_insert on public.messages;
create policy bl_messages_insert on public.messages
  for insert to authenticated
  with check (public.can_use_collection(collection_id) and sender_id = auth.uid());

drop policy if exists bl_messages_update on public.messages;
create policy bl_messages_update on public.messages
  for update to authenticated
  using (sender_id = auth.uid() or public.owns_collection(collection_id))
  with check (public.can_use_collection(collection_id));

drop policy if exists bl_messages_delete on public.messages;
create policy bl_messages_delete on public.messages
  for delete to authenticated
  using (sender_id = auth.uid() or public.owns_collection(collection_id));

-- ---- conversation_reads ----
-- Yours and nobody else's, in every direction. How far someone else
-- has read is not this app's business to show.
drop policy if exists bl_reads_all on public.conversation_reads;
create policy bl_reads_all on public.conversation_reads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_use_collection(collection_id));

-- ---- activity_notes ----
drop policy if exists bl_notes_select on public.activity_notes;
create policy bl_notes_select on public.activity_notes
  for select to authenticated
  using (public.can_use_activity(activity_id));

drop policy if exists bl_notes_insert on public.activity_notes;
create policy bl_notes_insert on public.activity_notes
  for insert to authenticated
  with check (public.can_use_activity(activity_id) and author_id = auth.uid());

-- Deliberately no UPDATE policy. The log is append-only: an entry is
-- a timestamped statement of what somebody said at a moment, and
-- letting it be rewritten afterwards is the thing a log is for
-- preventing. Wrong entry, remove it and add another.
drop policy if exists bl_notes_delete on public.activity_notes;
create policy bl_notes_delete on public.activity_notes
  for delete to authenticated
  using (author_id = auth.uid() or public.owns_activity_collection(activity_id));


-- -------------------------------------------------------------
-- 3b. MUTING A CONVERSATION
--
-- Read only by supabase/functions/send-message-push, which drops
-- muted users out of the audience before it sends. Absent, nothing
-- is muted — which is why that function tolerates the table not
-- existing rather than failing.
--
-- Deliberately NOT part of conversation_reads: read state is written
-- on every open and this is written approximately never, and folding
-- a preference into a high-write row means one clobbering the other.
-- -------------------------------------------------------------
create table if not exists public.conversation_prefs (
  collection_id uuid not null references public."Collections"(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  muted         boolean not null default false,
  primary key (collection_id, user_id)
);

alter table public.conversation_prefs enable row level security;

-- Yours and nobody else's, in both directions. Whether somebody else
-- has muted you is not this app's business to show.
drop policy if exists bl_prefs_all on public.conversation_prefs;
create policy bl_prefs_all on public.conversation_prefs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_use_collection(collection_id));


-- -------------------------------------------------------------
-- 4. THE HUB QUERY
--
-- Everything the Messages tab draws, in one round trip: every list
-- with somebody else in it, its last message, and how many messages
-- in it this user has not read.
--
-- This is what keeps messages OUT of the app's two backing queries.
-- The hub is bounded by the number of shared lists, so it caches and
-- snapshots like the other two; the messages themselves are fetched
-- per conversation and paginated. Building the hub client-side would
-- mean pulling every message in every list on every launch.
-- -------------------------------------------------------------

create or replace function public.conversation_list()
returns table (
  collection_id    uuid,
  name             text,
  cover_image      text,
  owner_id         uuid,
  member_count     int,
  last_body        text,
  last_sender_id   uuid,
  last_sender_name text,
  last_at          timestamptz,
  unread_count     int
)
language sql security definer stable
set search_path = public
as $$
  with mine as (
    select c.id, c.name, c.cover_image, c.user_id as owner_id
    from public."Collections" c
    where public.can_use_collection(c.id)
      -- A conversation exists only where there is somebody to have
      -- it with. See the header.
      and exists (
        select 1 from public.collection_members m where m.collection_id = c.id
      )
  )
  select
    mi.id, mi.name, mi.cover_image, mi.owner_id,
    -- The owner has no collection_members row of their own, so they
    -- are added back here.
    (select count(*) from public.collection_members m
      where m.collection_id = mi.id)::int + 1,
    lm.body, lm.sender_id, lm.sender_name, lm.created_at,
    (select count(*) from public.messages g
      where g.collection_id = mi.id
        and g.deleted_at is null
        -- Your own messages are never unread.
        and g.sender_id is distinct from auth.uid()
        and g.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
    )::int
  from mine mi
  left join lateral (
    select m.body, m.sender_id, m.sender_name, m.created_at
    from public.messages m
    where m.collection_id = mi.id and m.deleted_at is null
    order by m.created_at desc
    limit 1
  ) lm on true
  left join public.conversation_reads r
    on r.collection_id = mi.id and r.user_id = auth.uid()
  -- Most recently active first, and a conversation nobody has
  -- started yet sorts to the bottom rather than disappearing.
  order by lm.created_at desc nulls last, mi.name;
$$;

revoke all on function public.conversation_list() from public, anon;
grant execute on function public.conversation_list() to authenticated;


-- -------------------------------------------------------------
-- 5. REALTIME
--
-- The client subscribes to postgres_changes on `messages`, filtered
-- to the collection whose conversation is open. That filter is a
-- single column equality, which is exactly what a conversation
-- needs and cannot express "any list I am in" — so the hub is
-- refreshed on foreground and after a push instead. See
-- js/messages.js.
--
-- Realtime respects RLS on this table, so a subscriber only ever
-- receives rows the select policy above would have returned.
-- -------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'messages'
    ) then
      alter publication supabase_realtime add table public.messages;
    end if;
  end if;
end $$;

-- Realtime sends the old row on a delete/update only where there is
-- a replica identity to send. Messages are soft-deleted (an update),
-- and the client needs the id either way.
alter table public.messages replica identity full;


-- -------------------------------------------------------------
-- 6. CHECKING IT
-- -------------------------------------------------------------
-- select * from public.conversation_list();
--
-- select tablename, policyname, cmd, roles
--   from pg_policies
--  where tablename in ('messages','conversation_reads','activity_notes')
--  order by tablename, policyname;
