/* ==============================================================
   send-message-push — a Web Push the moment a message is sent.

   ---- Why this is not a cron, and not a database trigger ----

   A reminder is "tell me on March 3rd": nothing happens on March 3rd,
   so something has to wake up and check the calendar. That is the ONLY
   reason send-reminders is scheduled, and it does not generalise. A
   message's event is the insert itself, so it is pushed immediately.

   The obvious shape is a trigger on `messages` calling this over
   pg_net. It is deliberately called from the client instead, right
   after the insert succeeds:

     - no pg_net, no pg_cron, no trigger to keep in step with the table;
     - the caller's JWT is right here, so membership can be verified
       against the *user*, not just asserted by the row;
     - a failure is visible to the sender rather than buried in
       Postgres logs.

   The tradeoff, stated plainly: a message that reaches the table by
   some other route does not push. In practice that is the offline
   queue replay in js/offline.js, which upserts directly — so a message
   written in a tunnel syncs silently. Accepted rather than fixed,
   because the alternative is the trigger and everything above.

   ---- What the client is NOT trusted for ----

   It sends a message id and nothing else. Every fact used to build the
   notification — the body, the sender, the collection, who is in it —
   is read back here with the service role. A caller cannot push
   arbitrary text to arbitrary people by lying in the body, which is
   the whole reason this is not "here is a payload, deliver it".

   Deploy:
     supabase functions deploy send-message-push

   Secrets (shared with send-reminders):
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT

   ⚠️ Never deploy this with --no-verify-jwt. Unlike send-reminders,
   which has its own CRON_SECRET as a second gate, the JWT IS the gate
   here — it is how the sender is identified at all.
   ============================================================== */

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/* A lock screen is not the place for four paragraphs. */
const PREVIEW_MAX = 140;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'missing authorization' }, 401);

  let messageId = '';
  try {
    const body = await req.json();
    messageId = String(body?.messageId ?? '');
  } catch {
    return json({ error: 'bad request body' }, 400);
  }
  if (!messageId) return json({ error: 'messageId required' }, 400);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  /* Who is calling. Taken from the token, never from the body — the
     same rule delete-account follows, and for the same reason: this
     runs as service_role, so a caller-supplied id would let anyone
     act as anyone. */
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  const caller = userData?.user;
  if (userError || !caller) return json({ error: 'invalid session' }, 401);

  /* ---- The message, read back rather than trusted ---- */
  const { data: msg, error: msgError } = await admin
    .from('messages')
    .select('id, collection_id, sender_id, sender_name, body, activity_ids, deleted_at')
    .eq('id', messageId)
    .maybeSingle();

  if (msgError) return json({ error: 'lookup failed', detail: msgError.message }, 500);
  if (!msg) return json({ error: 'no such message' }, 404);
  if (msg.deleted_at) return json({ skipped: 'deleted' });

  /* Only the author can trigger the push for their own message. Without
     this, anyone in the list could re-push somebody else's message at
     will — a notification spam vector wearing a valid JWT. */
  if (msg.sender_id !== caller.id) return json({ error: 'not your message' }, 403);

  /* ---- The list it belongs to ---- */
  const { data: collection, error: colError } = await admin
    .from('Collections')
    .select('id, name, user_id')
    .eq('id', msg.collection_id)
    .maybeSingle();

  if (colError || !collection) return json({ error: 'no such collection' }, 404);

  /* ---- The audience: the owner plus every member ----
     Exactly the rule send-reminders arrived at. A conversation belongs
     to the list, so it reaches everyone on the list. */
  const audience = new Set<string>();
  if (collection.user_id) audience.add(collection.user_id);

  const { data: members, error: membersError } = await admin
    .from('collection_members')
    .select('user_id')
    .eq('collection_id', msg.collection_id);

  if (membersError) {
    /* sharing.sql not run. There is then no conversation to have, so
       there is nobody to tell — but this is worth saying rather than
       silently pushing to the owner alone. */
    console.info('[send-message-push] no collection_members table');
  } else {
    for (const m of members ?? []) audience.add(m.user_id);
  }

  /* The sender is holding the phone that sent it. */
  audience.delete(caller.id);

  /* Verifying membership properly: the caller has to be in the audience
     they are about to notify. Checked AFTER the sender is removed, so
     it is computed from the pre-deletion set. */
  const senderIsInList =
    collection.user_id === caller.id ||
    (members ?? []).some((m) => m.user_id === caller.id);
  if (!senderIsInList) return json({ error: 'not in this list' }, 403);

  if (!audience.size) return json({ sent: 0, note: 'no one else in this list' });

  /* ---- Anyone who has muted this conversation ----
     Tolerated as absent: the table is optional and its absence means
     nobody has muted anything, which is the correct default. */
  const { data: muted, error: mutedError } = await admin
    .from('conversation_prefs')
    .select('user_id')
    .eq('collection_id', msg.collection_id)
    .eq('muted', true);

  if (mutedError) {
    console.info('[send-message-push] no conversation_prefs table — nothing muted');
  } else {
    for (const row of muted ?? []) audience.delete(row.user_id);
  }

  if (!audience.size) return json({ sent: 0, note: 'everyone has muted this list' });

  /* ---- The banner ----
     "Sarah · Japan 2027" over the message itself: the list is the
     context and the sender is who to answer, and both have to be on a
     lock screen or the notification says nothing about what to do. */
  const senderName = msg.sender_name || 'Someone';
  const listName = collection.name || 'a shared list';
  let preview = String(msg.body ?? '').trim();
  if (!preview) {
    const n = (msg.activity_ids ?? []).length;
    preview = n === 1 ? 'Shared an activity' : `Shared ${n} activities`;
  }
  if (preview.length > PREVIEW_MAX) preview = preview.slice(0, PREVIEW_MAX - 1) + '…';

  const payload = JSON.stringify({
    kind: 'message',
    title: `${senderName} · ${listName}`,
    body: preview,
    collectionId: msg.collection_id,
    messageId: msg.id,
  });

  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT') ?? 'mailto:noreply@example.com',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );

  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, user_id')
    .in('user_id', [...audience]);

  if (!subs?.length) return json({ sent: 0, note: 'no registered devices' });

  let sent = 0;
  const stale: string[] = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (e: any) {
      /* 404/410: the browser threw the subscription away. Prune, or the
         table fills with endpoints that can never receive again. Same
         handling as send-reminders. */
      if (e?.statusCode === 404 || e?.statusCode === 410) stale.push(sub.endpoint);
      else console.error('push failed', sub.endpoint, e?.statusCode, e?.body);
    }
  }

  if (stale.length) {
    await admin.from('push_subscriptions').delete().in('endpoint', stale);
  }

  return json({ recipients: audience.size, sent, pruned: stale.length });
});
