/* ==============================================================
   send-reminders — the daily sweep that actually delivers reminders.

   A web app cannot wake itself up, so the push has to originate from a
   server. This runs once a day (see cron.sql), finds every activity
   whose reminder date has arrived, and sends a Web Push to each device
   the owner has subscribed.

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

  /* Due = reminder date reached, not already sent, not already done.
     The embedded Collections row is how an activity reaches a user —
     Activities has no user_id of its own. */
  const { data: due, error } = await supabase
    .from('Activities')
    .select('id, name, remind_at, collection_id, Collections!inner(user_id)')
    .lte('remind_at', today)
    .is('reminder_sent_at', null)
    .is('date_completed', null);

  if (error) return json({ error: error.message }, 500);
  if (!due?.length) return json({ sent: 0, note: 'nothing due' });

  /* Group by owner so somebody with five due reminders gets one
     notification rather than five separate banners. */
  const byUser = new Map<string, { id: string; name: string }[]>();
  for (const row of due as any[]) {
    const userId = row.Collections?.user_id;
    if (!userId) continue;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId)!.push({ id: row.id, name: row.name });
  }

  let sent = 0;
  const staleEndpoints: string[] = [];
  const notifiedActivityIds: string[] = [];

  for (const [userId, items] of byUser) {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);

    if (!subs?.length) continue;

    const payload = JSON.stringify(
      items.length === 1
        ? { title: 'Reminder', body: items[0].name, activityId: items[0].id }
        : {
            title: `${items.length} reminders`,
            body: items.slice(0, 3).map((i) => i.name).join(', ') +
              (items.length > 3 ? '…' : ''),
          },
    );

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
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
    notifiedActivityIds.push(...items.map((i) => i.id));
  }

  /* Mark only what was actually attempted for a user with a device, so
     someone who has not enabled notifications yet still gets their
     reminder the day they do. */
  if (notifiedActivityIds.length) {
    await supabase
      .from('Activities')
      .update({ reminder_sent_at: new Date().toISOString() })
      .in('id', notifiedActivityIds);
  }
  if (staleEndpoints.length) {
    await supabase.from('push_subscriptions').delete().in('endpoint', staleEndpoints);
  }

  return json({
    due: due.length,
    users: byUser.size,
    sent,
    pruned: staleEndpoints.length,
  });
});
