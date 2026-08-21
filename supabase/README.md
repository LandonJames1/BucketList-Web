# Backend setup

Everything the backend needs: the SQL the app runs on, the shared-lists
schema, the multi-list column, the storage bucket that holds completion
photos and video, and three Edge Functions — one that delivers reminders
as real push notifications, one that reads a shared link or a screenshot
into an activity, and one that erases an account.

Everything is optional, and each piece probes for itself at boot rather
than assuming it is there:

| Piece | Probe | Without it |
| --- | --- | --- |
| `schema.sql` | `probeRemindColumn()` in `js/api.js` | The reminder UI hides itself |
| `sharing.sql` | `probeSharing()` in `js/sharing.js` | No Share entry in the ⋯ menu; the app is single-user, exactly as before |
| `storage.sql` | `probeStorage()` in `js/media.js` | Photos stay inline as base64; video is refused with an explanation |
| `functions/send-reminders` | — | Reminders still show on Home and on next open, just not as background push |
| `messages.sql` | `probeMessages()` in `js/messages.js` | No Messages tab, no activity notes log |
| `functions/send-message-push` | — | Messages arrive silently; the in-app tab badge is the only signal, and it only refreshes on foreground |
| **`rls-lockdown.sql`** | — | **Every signed-in user can read, edit and delete every other user's data. Run it.** |
| `functions/unfurl` | — | A shared link still opens the activity sheet with the URL attached; screenshot import says it needs the key; the location guess stays quiet |
| `single-list.sql` | — | Nothing visible: the app never reads `extra_collection_ids`. Run it to take the dead column off the table |
| `functions/delete-account` | — | **Delete Account reports an error rather than half-deleting.** Deploy this if you offer the button at all |

Note that **offline needs nothing here.** The write queue and the row
snapshot live in the browser's IndexedDB (`js/offline.js`); there is no
server-side component to deploy.

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

## 3. Reading shared links (optional)

`functions/unfurl` is what makes a shared TikTok arrive as a filled-in
activity rather than a bare URL. It runs three stages, each degrading on
its own: fetch the page's metadata, have Claude turn a caption into a
name/location/description, then geocode the place so the activity lands
on the map.

### Deploy

```bash
supabase functions deploy unfurl
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

> ⚠️ **Do not pass `--no-verify-jwt`.** The function fetches a
> caller-supplied URL from inside Supabase's network. Default JWT
> verification is what stops it being an open fetch proxy for the
> internet — it is the only caller check there is. (`send-reminders`
> uses a shared secret instead because cron invokes it, not a user.)

Without `ANTHROPIC_API_KEY` the function still deploys and still works:
it falls back to using the page's raw title as the activity name. The
key is what buys "📍hidden gem you NEED to see 😍 #kyoto" becoming
*Visit Fushimi Inari at sunrise*, and a listicle becoming ten activities
instead of one.

Cost is roughly **1–2¢ per import** on `claude-opus-5`.

### Test

```bash
TOKEN=$(…your signed-in user's access token…)
curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/unfurl \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.tiktok.com/@scout2015/video/6718335390845095173"}'
```

Returns `{activities:[{name,location,description,lat,lng}],cover,source,degraded}`.

Check the guard is live while you are there — both must be rejected
before any fetch happens:

```bash
curl … -d '{"url":"http://169.254.169.254/latest/meta-data/"}'   # cloud metadata
curl … -d '{"url":"file:///etc/passwd"}'
```

### What each platform gives back

| Source | Works | Note |
| --- | --- | --- |
| TikTok | ✅ | Public oEmbed; the caption arrives as the title |
| X / Twitter | ✅ | `publish.twitter.com/oembed`, via a 301 |
| YouTube | ✅ | Public oEmbed |
| Blogs, guides, listings | ✅ | OpenGraph tags; some sites 403 datacenter IPs |
| **Instagram** | ❌ | Serves a login wall with no OG tags to anything unauthenticated. The app offers a **screenshot** instead (below), which is the real fix. Official access would need a Meta app with `oembed_read` App Review. |

### Screenshots

The same function reads an image, which is how Instagram — and anything
else with no readable metadata — actually gets in. Send `{image,
mediaType}` instead of `{url}`:

```bash
curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/unfurl \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"$(base64 -i shot.jpg)\",\"mediaType\":\"image/jpeg\"}"
```

Same response shape. `degraded` comes back as `no_model` when
`ANTHROPIC_API_KEY` is unset — unlike the link path there is no fallback,
because without a model nothing can read an image, and the app offers
"add by hand" rather than an empty sheet.

The client downscales to 1568px on the long edge before sending, which is
the size above which the model gains nothing.

---

## 4. Shared lists (optional)

Run `sharing.sql` in the SQL editor. It adds `collection_members` and
`collection_invites`, rewrites the RLS policies on `Collections` and
`Activities` so membership grants access, and creates two functions:
`peek_invite()` and `join_collection()`.

Read the comments at the top of that file before running it — in
particular:

- **It enables RLS** on `Collections` and `Activities` and adds policies
  named `bl_*`. Any existing policies under other names are left alone,
  and multiple permissive policies are OR'd together, so check the
  Policies tab afterwards and drop anything now superseded.
- **The `SECURITY DEFINER` helpers are load-bearing.** The obvious
  policy recurses the moment `collection_members` has a policy pointing
  back at `Collections`; the wrappers break the cycle.
- **There is deliberately no INSERT policy on `collection_members`.**
  The only way to join is `join_collection()`, which validates an invite
  first — otherwise holding any collection's uuid would be enough to add
  yourself to it.

Invites are a link with a random 18-character code, generated
client-side. There is no username lookup, on purpose: it would need a
policy letting any signed-in user search `Users`, turning a private
table into a user directory.

Rolling it back is at the bottom of `sharing.sql`. The app falls straight
back to single-user behaviour as soon as `collection_members` is gone.

---

## On iOS

Web Push only works for a PWA **installed to the home screen** — Safari tabs
cannot receive it, and `Notification.requestPermission()` will not even resolve
there. The app detects this and points you at Add to Home Screen rather than
appearing to hang.

Requires iOS 16.4 or later.

---

## Deleting an account

```
supabase functions deploy delete-account
```

No secrets: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected
into every function by the platform.

**Do not deploy this with `--no-verify-jwt`.** It runs as `service_role`
and identifies the caller by verifying their JWT; without that check it
would erase accounts for anyone who can reach the URL. There is
deliberately no "which user" parameter — the uid comes from the token
and nowhere else.

Until it is deployed, Delete Account in the You tab reports a failure
rather than doing part of the job. That is the intended degradation: a
half-deleted account is worse than one that is still there.

