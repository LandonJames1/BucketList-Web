# Backend setup

Two things live here: the SQL the app needs, and the Edge Function that
delivers reminders as real push notifications.

Everything is optional. With none of it deployed the app runs fine — the
reminder UI just hides itself, because `probeRemindColumn()` in `js/api.js`
checks whether the column exists before showing anything.

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
