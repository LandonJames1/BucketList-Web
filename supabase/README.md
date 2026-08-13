# Backend setup

Three things live here: the SQL the app needs, the storage bucket that
holds completion photos and video, and the Edge Function that delivers
reminders as real push notifications.

Everything is optional, and each piece probes for itself at boot rather
than assuming it is there:

| Piece | Probe | Without it |
| --- | --- | --- |
| `schema.sql` | `probeRemindColumn()` in `js/api.js` | The reminder UI hides itself |
| `storage.sql` | `probeStorage()` in `js/media.js` | Photos stay inline as base64; video is refused with an explanation |
| `functions/send-reminders` | — | Reminders still show on Home and on next open, just not as background push |

---

## 0. Media storage (recommended)

Open **Dashboard → SQL Editor**, paste in `storage.sql`, run it. It
creates a public `media` bucket and the row-level policies that keep each
user inside their own folder.

This is worth doing even if you do not care about video. Photos were
stored as base64 data URLs *inside* `Activities.photos`, so every render
of every list pulled all of them down again as part of the row JSON — it
is the single biggest thing making the app slow with any real amount of
data. With the bucket in place the column holds URLs and the images are
fetched (and HTTP-cached) separately.

Existing base64 photos keep working: `js/api.js` normalises both shapes,
so old rows render exactly as before and only new uploads become files.

Idempotent, so re-running it is harmless.

---

## 1. Database (required for reminders)

Open **Dashboard → SQL Editor**, paste in `schema.sql`, run it. It:

- adds `Activities.remind_at` and `Activities.reminder_sent_at`
- migrates every activity still set to "Someday" or no date to `In 5+ Years`
- creates `push_subscriptions` with row-level security
- adds a trigger that re-arms a reminder if you move its date

Idempotent, so re-running it is harmless.

**Preview the migration first** if you want to see what it will touch:

```sql
select target_date, count(*)
  from "Activities"
 where target_date is null
    or target_date = ''
    or target_date = 'Before I Die'
 group by target_date;
```

At this point reminders work: the banner on Home, plus a notification when
you open the app on or after the date. Stop here if that is enough.

---

## 2. Background push (optional)

This is what makes a reminder arrive on the day with the app closed.

### Generate a VAPID key pair

```bash
npx web-push generate-vapid-keys
```

Put the **public** key in `js/config.js` as `VAPID_PUBLIC_KEY` — it is public
by design and safe to commit. Keep the private one out of the repo.

### Deploy the function

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy send-reminders

supabase secrets set VAPID_PUBLIC_KEY=...
supabase secrets set VAPID_PRIVATE_KEY=...
supabase secrets set VAPID_SUBJECT=mailto:you@example.com
supabase secrets set CRON_SECRET=$(openssl rand -hex 32)
```

`CRON_SECRET` is what stops anyone on the internet triggering a send to every
user's devices. The function rejects any request without it.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### Schedule it

Edit `cron.sql`, replacing `YOUR_PROJECT_REF` and `YOUR_CRON_SECRET`, then run
it in the SQL editor.

### Test before waiting a day

```bash
curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-reminders \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

Returns `{"due":N,"users":N,"sent":N,"pruned":N}`. `sent: 0` with `due > 0`
means nobody has a registered device yet — open the app, go to **You →
Reminder alerts**, and turn them on.

---

## On iOS

Web Push only works for a PWA **installed to the home screen** — Safari tabs
cannot receive it, and `Notification.requestPermission()` will not even resolve
there. The app detects this and points you at Add to Home Screen rather than
appearing to hang.

Requires iOS 16.4 or later.
