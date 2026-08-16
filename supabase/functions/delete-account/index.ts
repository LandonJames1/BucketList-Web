/* ==============================================================
   delete-account — erase the caller's account and everything in it.

   This has to be a function rather than client code for one reason:
   removing the row from `auth.users` needs the service_role key, and
   the service_role key must never reach a browser. Everything else it
   does the client could technically do under RLS, but doing it here
   means the whole erasure is one call that either happens or does not,
   rather than a sequence a dropped connection can leave half done.

   ---- It deletes the caller, and only the caller ----

   The uid comes from verifying the caller's own JWT, never from the
   request body. There is no "delete user X" parameter and there must
   never be one: this runs as service_role, so a uid taken from the
   body would let any signed-in user erase anybody.

   ---- What survives, and why ----

   A shared list the caller does not own is not theirs to destroy, so
   leaving it is all that happens — the other members keep the list and
   everything in it. The reverse case is the awkward one: a list the
   caller OWNS but has shared with other people. Deleting the account
   deletes that list, because it is their data and they asked for it to
   go, and there is nobody to transfer ownership to without asking. The
   client says so in as many words before it calls this.

   Activities are deleted before collections: there is no DB cascade
   between them (see delList in js/collections.js).

   ---- Nothing the caller leaves behind may break for anybody else ----

   "Leaving a shared list" is easy to get right at the row level and
   easy to get wrong everywhere else, because three things the caller
   owns are pointed at from lists they do not:

   1. MEDIA. Uploads go to `${uid}/…` in the media bucket whichever
      list they land on — mediaKey() in js/media.js keys the folder by
      the uploader, not by the collection. So a photo the caller
      attached to an activity in a list they merely JOINED is stored
      under the caller and displayed to everyone else on that list.
      Deleting the folder wholesale blanked those photos for the other
      members, which is precisely the thing deleting an account must
      not do. Every object still referenced by a surviving activity is
      now kept; only the rest of the folder goes.

   2. LIST LINKS. An activity homed in someone else's list can carry
      one of the caller's collections in `extra_collection_ids`
      (multilist.sql). Deleting that collection used to leave the id
      behind, dangling, on a row belonging to somebody else. It is
      stripped instead.

   3. CLAIMED INVITES. invite_claims rows are keyed by email address,
      so they outlive the account unless they are removed by hand.

   What the caller must NOT take with them, and does not: activities
   they added to somebody else's list (those are homed there, so they
   are never in the delete set), the completion notes and photos on
   them, and any reminder they set on a shared activity — remind_at is
   a column on the activity, so it stays with the list.

   ---- Order matters ----

   auth.users goes LAST. Several tables reference it with `on delete
   cascade`, so removing it first would take rows out from under the
   deletes still to run, and any failure after that point would leave
   an account that cannot sign in but still owns data. Doing it last
   means a mid-way failure leaves the account intact and re-runnable.

   Deploy:
     supabase functions deploy delete-account

   Needs no secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
   injected into every function by the platform.

   Auth: default JWT verification. Do NOT deploy with --no-verify-jwt.
   ============================================================== */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

/* A table that may not exist in this project — sharing.sql and
   schema.sql are both optional. "relation does not exist" (42P01) is a
   fine outcome; anything else is a real failure and has to be
   reported, or a half-deleted account looks like a clean one. */
async function tryDelete(
  admin: any, table: string, column: string, value: string,
): Promise<string | null> {
  const { error } = await admin.from(table).delete().eq(column, value);
  if (!error) return null;
  if (error.code === '42P01') return null;
  return `${table}: ${error.message}`;
}

/* `photos` is a JSON array column holding two shapes at once — a bare
   string for a photo, `{type:'video',url,poster}` for a video — and
   PostgREST may hand it back as either an array or a JSON string. Same
   tolerance mapActivity() has in js/api.js, for the same reason. */
function mediaUrls(photos: unknown): string[] {
  let raw: any = photos;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m === 'string') out.push(m);
    else if (m && typeof m === 'object') {
      if (typeof m.url === 'string') out.push(m.url);
      if (typeof m.poster === 'string') out.push(m.poster);
    }
  }
  return out;
}

/* Take the caller's now-deleted collections out of every surviving
   activity's extra_collection_ids. Run AFTER the collections are gone,
   so whatever still matches is by definition somebody else's row.

   A round trip per row, which is the same cost delList() pays in
   js/collections.js for the same reason: PostgREST has no way to
   express "subtract this set from this array column". The count is
   bounded by how many of the caller's lists other people filed things
   into, which is small or zero. */
async function unlinkDeletedCollections(
  admin: any, ids: string[],
): Promise<string | null> {
  if (!ids.length) return null;
  const { data, error } = await admin.from('Activities')
    .select('id, extra_collection_ids').overlaps('extra_collection_ids', ids);
  /* Column absent — multilist.sql is optional, and without it there is
     no second way for an activity to reference a collection. */
  if (error) return error.code === '42703' ? null : `stale list links: ${error.message}`;

  for (const row of data || []) {
    const kept = (row.extra_collection_ids || []).filter((c: string) => !ids.includes(c));
    const { error: e } = await admin.from('Activities')
      .update({ extra_collection_ids: kept }).eq('id', row.id);
    if (e) return `stale list links: ${e.message}`;
  }
  return null;
}

/* The object names under `${uid}/` that activities in `listIds` are
   still showing. Null means the question could not be answered, which
   is different from "nothing" — the caller keeps the whole folder
   rather than guessing, because an orphaned file costs storage and a
   wrongly deleted one costs somebody else their photos.

   Only the lists the caller actually joined are consulted. A list they
   were removed from, or left, before deleting their account is not
   knowable from here and its media is deleted with the folder; that is
   the same orphan problem the sweeper comment at the bottom of
   storage.sql already describes, pointed the other way. */
async function mediaStillInUse(
  admin: any, uid: string, listIds: string[],
): Promise<Set<string> | null> {
  const keep = new Set<string>();
  if (!listIds.length) return keep;

  const rows: any[] = [];
  /* Homed in one of those lists. */
  const home = await admin.from('Activities').select('photos').in('collection_id', listIds);
  if (home.error) return null;
  rows.push(...(home.data || []));

  /* Linked into one of them from elsewhere. The column is optional —
     multilist.sql may not have been run — and "column does not exist"
     (42703) simply means there is no second way in. */
  const extra = await admin.from('Activities').select('photos')
    .overlaps('extra_collection_ids', listIds);
  if (extra.error && extra.error.code !== '42703') return null;
  if (!extra.error) rows.push(...(extra.data || []));

  const marker = `/${uid}/`;
  for (const r of rows) {
    for (const url of mediaUrls(r.photos)) {
      /* A base64 data URL is inline in the row and owns no object. */
      if (!url.includes(marker)) continue;
      const name = url.split('?')[0].split('/').pop();
      if (name) keep.add(decodeURIComponent(name));
    }
  }
  return keep;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) return json({ error: 'server not configured' }, 500);

  /* ---- Who is calling ----
     Verified against the auth server rather than decoded locally, so a
     forged or expired token cannot get past this. */
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'not signed in' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: got, error: whoErr } = await admin.auth.getUser(jwt);
  if (whoErr || !got?.user) return json({ error: 'not signed in' }, 401);
  const uid = got.user.id;
  /* claim_invite() lower-cases the address it stores, so the row for
     this account is only findable the same way. */
  const email = (got.user.email || '').toLowerCase();

  const failures: string[] = [];
  const note = (e: string | null) => { if (e) failures.push(e); };

  /* ---- 0. Which lists belong to other people ----
     Read BEFORE the membership rows are deleted, because it is the
     only record of them and step 4 needs it to know which media is
     still on somebody else's screen. A failure here is fatal rather
     than tolerated: without the answer the storage step below would be
     deleting into the dark. */
  const shared = await admin.from('collection_members')
    .select('collection_id').eq('user_id', uid);
  if (shared.error && shared.error.code !== '42P01')
    return json({ error: `reading memberships: ${shared.error.message}` }, 500);
  const joinedIds: string[] =
    (shared.data || []).map((m: { collection_id: string }) => m.collection_id);

  /* ---- 1. Leave every shared list, and give up every invite ----
     Done first so that if anything later fails, the caller has at
     least stopped appearing in other people's lists.

     Invites can only be created by a list's owner (the RLS insert
     policy in sharing.sql checks owns_collection), so every row here
     belongs to a collection that is about to be deleted anyway —
     this cannot revoke a link somebody else is relying on. */
  note(await tryDelete(admin, 'collection_members', 'user_id', uid));
  note(await tryDelete(admin, 'collection_invites', 'created_by', uid));

  /* ---- 2. Owned collections, activities first ---- */
  const { data: owned, error: ownErr } = await admin
    .from('Collections').select('id').eq('user_id', uid);
  if (ownErr) return json({ error: `reading collections: ${ownErr.message}` }, 500);

  const ids = (owned || []).map((c: { id: string }) => c.id);
  if (ids.length) {
    /* Anything homed in a list being deleted goes with it. An activity
       merely *linked* into one of these lists from elsewhere is left
       alone — it belongs to whoever owns its home list. See
       supabase/multilist.sql. */
    const { error } = await admin.from('Activities').delete().in('collection_id', ids);
    if (error) failures.push(`activities: ${error.message}`);
    /* Members of a list about to disappear. The FK cascades, but only
       once the collection row actually goes; being explicit keeps the
       order correct if that FK is ever changed. */
    const { error: memErr } = await admin
      .from('collection_members').delete().in('collection_id', ids);
    if (memErr && memErr.code !== '42P01') failures.push(`memberships: ${memErr.message}`);
    const { error: colErr } = await admin.from('Collections').delete().eq('user_id', uid);
    if (colErr) failures.push(`collections: ${colErr.message}`);

    /* Anything still standing that was ALSO filed into one of those
       lists keeps a dangling id in extra_collection_ids otherwise. The
       row belongs to somebody else, so leaving a reference to a
       collection that no longer exists on it is the caller's mess left
       in another person's list. */
    note(await unlinkDeletedCollections(admin, ids));
  }

  /* ---- 3. Everything else keyed to the user ---- */
  note(await tryDelete(admin, 'reminder_deliveries', 'user_id', uid));
  note(await tryDelete(admin, 'push_subscriptions', 'user_id', uid));
  /* An invite waiting for this address, or one it already redeemed.
     Keyed by email rather than by uid, so nothing else removes it. */
  note(await tryDelete(admin, 'invite_claims', 'claimed_by', uid));
  if (email) note(await tryDelete(admin, 'invite_claims', 'email', email));
  note(await tryDelete(admin, 'Users', 'id', uid));

  /* ---- 4. Their folder in the media bucket, minus what other people
             are still looking at ----

     Storage has no "delete by prefix", so the folder is listed and
     removed by name — which is the opening this needs anyway, because
     the names are what get filtered. See mediaStillInUse() above for
     why a photo of the caller's can be load-bearing on a list that is
     not theirs.

     Best effort throughout: an orphaned image is not a reason to
     refuse to delete an account, and storage.sql is optional. But the
     bias is always toward keeping — a file wrongly kept costs a few
     kilobytes, a file wrongly deleted costs somebody else a photo they
     cannot get back. */
  try {
    const keep = await mediaStillInUse(admin, uid, joinedIds.filter(id => !ids.includes(id)));
    const { data: files } = await admin.storage.from('media').list(uid, { limit: 1000 });
    if (keep === null) {
      console.warn('delete-account: could not check shared media; keeping the folder');
    } else if (files?.length) {
      const doomed = files
        .map((f: { name: string }) => f.name)
        .filter((name: string) => !keep.has(name));
      if (doomed.length) {
        await admin.storage.from('media').remove(doomed.map((n: string) => `${uid}/${n}`));
      }
      if (doomed.length !== files.length) {
        console.info(`delete-account: kept ${files.length - doomed.length} media file(s) still shown on shared lists`);
      }
    }
  } catch (e) {
    console.warn('storage cleanup:', e);
  }

  /* ---- 5. The auth user, last ---- */
  if (failures.length) {
    /* Deliberately stopping short. Removing the login while rows are
       still out there would strand data with no owner and no way back
       in to try again. */
    console.error('delete-account: leaving auth user in place after', failures);
    return json({ error: 'could not delete everything', details: failures }, 500);
  }

  /* ---- Every device, not just this one ----

     Deleting the user cascades auth.refresh_tokens away, so this is
     belt to that brace — but it is worth being explicit about, because
     it is the only half of "log out everywhere" that a server can
     actually do.

     Scope 'global' revokes every refresh token this account holds, on
     every device, so no other copy of the app can ever renew. What it
     CANNOT do is revoke an access token that has already been issued:
     those are stateless signed JWTs, verified by signature alone, and
     nothing on the server is consulted while one is still inside its
     lifetime. That residual window is closed from the client instead —
     see IS THIS SESSION STILL A REAL ACCOUNT? in js/auth.js — and its
     size is the project's "JWT expiry" setting, so shortening that
     shortens the worst case.

     Placed after the failure check: everything above has succeeded, so
     this account is going. Doing it earlier would sign the caller out
     of every device and then leave the account alive.

     Not fatal if it fails. deleteUser() below removes the same tokens
     by cascade a line later. */
  try {
    const { error: outErr } = await admin.auth.admin.signOut(jwt, 'global');
    if (outErr) console.warn('delete-account: global signOut:', outErr.message);
  } catch (e) {
    console.warn('delete-account: global signOut threw:', e);
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(uid);
  if (delErr) return json({ error: `deleting the account: ${delErr.message}` }, 500);

  return json({ ok: true });
});
