/* ==============================================================
   send-reminders — the daily sweep that actually delivers reminders.

   A web app cannot wake itself up, so the push has to originate from a
   server. This runs once a day (see cron.sql), finds every activity
   whose reminder date has arrived, and sends a Web Push to each device
   belonging to everybody who can see it.

   ---- Everybody, not just the owner ----

   This used to select `Collections!inner(user_id)` and send only to
   that one person. On a shared list that is the wrong answer and a
   quiet one: three people share a list, one of them sets a reminder to
   book the campsite, and the notification goes to whoever happens to
   own the list — possibly not even the person who set it. The other
   two are never told, and nothing anywhere says so.

   So the audience for an activity is now the collection's owner plus
   every row in `collection_members` for it. A reminder on a shared
   list is a reminder for the people sharing it.

   ---- Why deliveries are tracked in their own table ----

   `Activities.reminder_sent_at` is a single column, so the first
   successful send marked the reminder done for everyone. That is
   exactly wrong once there is more than one recipient: whoever the
   sweep reached first would silently consume the notification for the
   whole list. `reminder_deliveries` is keyed on
   (activity_id, user_id, remind_at) instead, so each person is tracked
   separately, and moving the date re-arms it for all of them without
   needing the trigger to clear anything.

   The old column is still written, purely so anything else looking at
   it keeps seeing what it expects. Nothing here reads it.

   Deploy:
     supabase functions deploy send-reminders

   Secrets it needs (see supabase/README.md):
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET
   ============================================================== */

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type Item = { id: string; name: string; note: string };

Deno.serve(async (req) => {
  /* The function is reachable from the internet, so require a shared
     secret. Without this anyone could spam every user's devices. */
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT') ?? 'mailto:noreply@example.com',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );

  const today = new Date().toISOString().split('T')[0];

  /* Due = reminder date reached and not already done. Who has been
     told is no longer part of this question — that is per-person now,
     and is resolved against reminder_deliveries below. The embedded
     Collections row is how an activity reaches a user; Activities has
     no user_id of its own. */
  const { data: due, error } = await supabase
    .from('Activities')
    .select('id, name, remind_at, reminder_note, collection_id, Collections!inner(user_id)')
    .lte('remind_at', today)
    .is('date_completed', null);

  if (error) return json({ error: error.message }, 500);
  if (!due?.length) return json({ sent: 0, note: 'nothing due' });

  const rows = due as any[];
  const collectionIds = [...new Set(rows.map((r) => r.collection_id).filter(Boolean))];

  /* ---- Who can see each collection ----

     Shared lists are optional: sharing.sql may never have been run on
     this project, in which case collection_members does not exist and
     this errors. That is not a failure — it means every list has an
     audience of one, which is what the owner map below already says.
     So the error is swallowed rather than returned. */
  const audience = new Map<string, Set<string>>();
  for (const r of rows) {
    const ownerId = r.Collections?.user_id;
    if (!ownerId || !r.collection_id) continue;
    if (!audience.has(r.collection_id)) audience.set(r.collection_id, new Set());
    audience.get(r.collection_id)!.add(ownerId);
  }

  const { data: members, error: membersError } = await supabase
    .from('collection_members')
    .select('collection_id, user_id')
    .in('collection_id', collectionIds);

  if (membersError) {
    console.info('[send-reminders] no collection_members table — owner-only delivery');
  } else {
    for (const m of members ?? []) {
      if (!audience.has(m.collection_id)) audience.set(m.collection_id, new Set());
      audience.get(m.collection_id)!.add(m.user_id);
    }
  }

  /* ---- Who has already been told ----

     Keyed on the reminder date as well as the activity, so moving a
     reminder re-arms it for everybody automatically. */
  const activityIds = rows.map((r) => r.id);
  const { data: delivered, error: deliveredError } = await supabase
    .from('reminder_deliveries')
    .select('activity_id, user_id, remind_at')
    .in('activity_id', activityIds);

  if (deliveredError) {
    /* Without this table there is no way to tell who has already been
       notified, and sending anyway would re-notify everyone every day
       until it is created. Refuse loudly instead. */
    return json({
      error: 'reminder_deliveries table missing — run supabase/schema.sql',
      detail: deliveredError.message,
    }, 500);
  }

  const already = new Set(
    (delivered ?? []).map((d: any) => `${d.activity_id}|${d.user_id}|${d.remind_at}`),
  );

  /* Group by recipient so somebody with five due reminders gets one
     notification rather than five separate banners. */
  const byUser = new Map<string, Item[]>();
  for (const r of rows) {
    for (const userId of audience.get(r.collection_id) ?? []) {
      if (already.has(`${r.id}|${userId}|${r.remind_at}`)) continue;
      if (!byUser.has(userId)) byUser.set(userId, []);
      byUser.get(userId)!.push({ id: r.id, name: r.name, note: r.reminder_note ?? '' });
    }
  }

  if (!byUser.size) return json({ due: rows.length, sent: 0, note: 'all already delivered' });

  const remindAt = new Map<string, string>(rows.map((r) => [r.id, r.remind_at]));
  let sent = 0;
  const staleEndpoints: string[] = [];
  const deliveries: { activity_id: string; user_id: string; remind_at: string }[] = [];

  for (const [userId, items] of byUser) {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);

    /* No device registered. Deliberately NOT recorded as delivered, so
       this person still gets their reminder on the day they turn
       notifications on. */
    if (!subs?.length) continue;

    const payload = JSON.stringify(
      items.length === 1
        /* The activity is the headline; the note is what you have to do
           about it, which is the part worth reading on a lock screen. */
        ? { title: items[0].name, body: items[0].note || 'Reminder', activityId: items[0].id }
        : {
            title: `${items.length} reminders`,
            body: items.slice(0, 3).map((i) => i.name).join(', ') +
              (items.length > 3 ? '…' : ''),
          },
    );

    let reached = false;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
        reached = true;
      } catch (e: any) {
        /* 404/410 mean the browser threw the subscription away — the
           user cleared site data or uninstalled. Collect and prune, or
           the table fills with endpoints that can never receive. */
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          staleEndpoints.push(sub.endpoint);
        } else {
          console.error('push failed', sub.endpoint, e?.statusCode, e?.body);
        }
      }
    }

    /* Only once something actually landed. A user whose every endpoint
       was stale has not been told, and marking them delivered would
       mean they never are. */
    if (reached) {
      for (const item of items) {
        deliveries.push({
          activity_id: item.id,
          user_id: userId,
          remind_at: remindAt.get(item.id)!,
        });
      }
    }
  }

  if (deliveries.length) {
    await supabase
      .from('reminder_deliveries')
      .upsert(deliveries, { onConflict: 'activity_id,user_id,remind_at' });

    /* Kept current only so anything still reading the old column sees
       what it expects. Nothing above consults it. */
    await supabase
      .from('Activities')
      .update({ reminder_sent_at: new Date().toISOString() })
      .in('id', [...new Set(deliveries.map((d) => d.activity_id))]);
  }

  if (staleEndpoints.length) {
    await supabase.from('push_subscriptions').delete().in('endpoint', staleEndpoints);
  }

  return json({
    due: rows.length,
    recipients: byUser.size,
    sent,
    delivered: deliveries.length,
    pruned: staleEndpoints.length,
  });
});
