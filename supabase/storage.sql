-- ============================================================
-- MEDIA STORAGE — the bucket that holds completion photos and video.
--
-- Run this ONCE in the Supabase SQL editor. Until you do, the app
-- degrades on its own: photos keep being stored inline as base64 the
-- way they always were, and the completion sheet refuses video with an
-- explanation. Nothing breaks; the feature is just absent. The probe
-- that decides this is probeStorage() in js/media.js.
--
-- Why a bucket at all: photos used to live as base64 data URLs inside
-- Activities.photos, so every render of every list pulled all of them
-- down again as part of the row JSON. Video was never possible that way
-- — one phone clip is 5–20MB before base64 adds another third.
-- ============================================================

-- ---- The bucket ----
-- Public read. The app renders media straight into <img>/<video> tags,
-- which cannot send an Authorization header, so signed URLs would mean
-- minting one per image on every render. Keys are random UUIDs, so a
-- URL is not guessable from the activity or the user it belongs to.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  true,
  104857600,                      -- 100MB, matching MAX_VIDEO_BYTES in js/media.js
  array[
    'image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif',
    'video/mp4','video/quicktime','video/webm','video/x-m4v'
  ]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---- Policies ----
-- Objects are stored one folder per user: media/<auth.uid()>/<uuid>.<ext>
-- storage.foldername(name) splits the key on '/', so [1] is that folder.
-- Every write policy checks it, which is what stops one signed-in user
-- writing into (or deleting out of) another's folder.

drop policy if exists "media read"   on storage.objects;
drop policy if exists "media insert" on storage.objects;
drop policy if exists "media update" on storage.objects;
drop policy if exists "media delete" on storage.objects;

-- Read is open, matching the public bucket above.
create policy "media read"
  on storage.objects for select
  using (bucket_id = 'media');

create policy "media insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "media update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "media delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================
-- NOTE ON DELETION
--
-- Removing a photo from an activity drops the URL from the row; it does
-- not delete the object. That is deliberate for now — an object can be
-- referenced by an activity that is mid-edit in another tab, and there
-- is no reference counting here to make deletion safe. Storage is cheap
-- and the orphans are small.
--
-- If you want them swept up later, the query below finds objects no
-- activity refers to any more. Read it before you run it.
--
--   select o.name
--   from storage.objects o
--   where o.bucket_id = 'media'
--     and not exists (
--       select 1 from "Activities" a
--       where a.photos::text like '%' || o.name || '%'
--     )
--     and o.created_at < now() - interval '7 days';
-- ============================================================
