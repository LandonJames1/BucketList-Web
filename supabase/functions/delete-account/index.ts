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

  const failures: string[] = [];
  const note = (e: string | null) => { if (e) failures.push(e); };

  /* ---- 1. Leave every shared list, and give up every invite ----
     Done first so that if anything later fails, the caller has at
     least stopped appearing in other people's lists. */
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
  }

  /* ---- 3. Everything else keyed to the user ---- */
  note(await tryDelete(admin, 'reminder_deliveries', 'user_id', uid));
  note(await tryDelete(admin, 'push_subscriptions', 'user_id', uid));
  note(await tryDelete(admin, 'Users', 'id', uid));

  /* ---- 4. Their folder in the media bucket ----
     Storage has no "delete by prefix", so the folder is listed and
     removed by name. Best effort: an orphaned image is not a reason to
     refuse to delete an account, and storage.sql is optional anyway. */
  try {
    const { data: files } = await admin.storage.from('media').list(uid, { limit: 1000 });
    if (files?.length) {
      await admin.storage.from('media').remove(files.map((f: { name: string }) => `${uid}/${f.name}`));
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
