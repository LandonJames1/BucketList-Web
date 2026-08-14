# Someday We'll Die — Codebase Guide

**The app is called "Someday We'll Die".** The name lives in `APP_NAME`
(`config.js`) for anywhere it is spoken, and is written out in `index.html`
(title, `apple-mobile-web-app-title`, the auth eyebrow) and
`manifest.webmanifest`. `nav.js` sets it as Home's bar title and `home.js` as
the large greeting.

**Storage identities are deliberately NOT named after it** and must not be
renamed to match: the auth `storageKey` (`bucketlist-auth`), the IndexedDB name
(`bucketlist`), the `sw.js` cache prefix, and the `bl_*` localStorage keys.
Changing any of them signs every existing user out or orphans their cached data.
The repo folder and CSS class names are likewise unchanged.

A single-page web app for curating and tracking bucket-list collections: nested
collections of activities, completion with photos/notes, a location map, and
bulk entry. Vanilla JS + HTML + CSS on the front end; **Supabase** (Postgres +
Auth) on the back end. No build step, no framework, no bundler.

It is also an **installable PWA** — see the PWA section below — and the layout
is mobile-first from 320px up.

## 📌 KEEP THIS FILE CURRENT (do this every time)

**Whenever you add/remove/rename/move a file, feature, page, or notable
function, update this `CLAUDE.md` in the same change** so the file map, function
list, and script-load order below stay accurate. Treat updating this guide as
part of the task, not an optional extra. Specifically:

- New `js/*.js` file → add it to **File structure**, the **JS file map** table,
  add its `<script src>` tag to `index.html` in the correct order, **and add it
  to `SHELL_ASSETS` in `sw.js`** (otherwise it will not be available offline).
- New `css/*.css` file → add it to the **CSS file map**, `<link>` it in
  `index.html` *before* `responsive.css`, **and add it to `SHELL_ASSETS`**.
- New/removed/renamed function → update the affected row in the JS file map.
- New page → note it under `nav.js` and in the **Adding a page** checklist.
- New Supabase table/column/policy → update the **Back end** section.
- Any change to a shell file → **bump `CACHE_VERSION` in `sw.js`** so returning
  installs fetch the new build instead of serving the cached one.

After structural edits, regenerate the function inventory with:

```bash
for f in js/*.js; do echo "=== $f"; grep -oE '^(async function|function|let|const) [A-Za-z0-9_$]+' "$f"; done
```

## ⚠️ Critical constraints — read before editing JS

This app was refactored out of one 2,804-line `index.html`, but it is **NOT
modular**. Every `js/*.js` file loads as an ordinary (classic) `<script>` tag at
the end of `<body>`. They all share **one single global scope**. Hard rules:

1. **No `import`/`export`, no `type="module"`.** Modules would scope every
   function away and break all ~100 inline `onclick="..."` handlers in
   `index.html`. This is the single reason for the classic-script design.
2. **Functions are global by design.** The markup calls them inline
   (`onclick="nav('collections')"`, `onclick="openNewList()"`). Do not wrap a
   file in an IIFE, and do not change a top-level `function`/`let`/`const` to
   something scoped.
3. **Load order matters.** `config.js` creates the `sb` Supabase client that
   everything else assumes exists; `state.js` declares the shared mutable
   globals; `main.js` runs the boot sequence and **must stay last**. The full
   order is in the comment block above the `<script>` tags in `index.html`.
4. **Top-level `let`/`const` are shared, but subject to TDZ.** Two files
   declaring the same top-level name is a runtime `SyntaxError`, not a silent
   shadow. Cross-file reads are fine *inside functions* (they run after all
   scripts load) but a file must not read another file's `let` at top level
   unless that file loads first.
5. **A function may live in a different file than where it's called.** If you
   can't find something, grep everything: `grep -rn "functionName" js/`
6. **`responsive.css` must stay last** in the `<link>` list so its media
   queries win.
7. **`sw.js` is the one exception to rules 1–4.** It is a service worker, not a
   classic script: it runs in its own worker scope, shares nothing with the
   app's globals, and must stay at the project root (a worker's scope is capped
   by its own path, so moving it into `js/` would stop it controlling `/`). It
   is registered by `js/pwa.js`; it is *not* in the `<script>` manifest.

Verify a change didn't break the shared-scope model — this concatenation models
exactly what the browser does, so it catches duplicate top-level declarations:

```bash
grep -o 'js/[a-z]*\.js' index.html | while read -r f; do cat "$f"; echo; done > /tmp/all.js && node --check /tmp/all.js
```

⚠️ That grep is a text match over the whole file, not a parse of the
`<script>` tags — so writing `js/foo.js` inside an HTML **comment**
concatenates `foo.js` twice and reports every one of its top-level
declarations as a duplicate. Refer to files as `foo.js` in comments in
`index.html`, or the check cries wolf.

The untouched pre-refactor original is in `_backup/index.original.html`. The
split was verified by diffing every CSS declaration and JS statement against it;
no logic was changed.

## File structure

```
index.html            Markup only — page sections, modals, and the ordered <link>/<script> manifest
CLAUDE.md             This guide
README.md             Human-facing setup + structure overview
manifest.webmanifest  PWA metadata (name, icons, standalone display, theme color)
sw.js                 Service worker — offline app shell + runtime caching. Must stay at the root.
supabase/             Backend — schema.sql (reminders + reminder_deliveries), profiles.sql (the Users row, its RLS and the sign-up trigger), sharing.sql (shared lists), multilist.sql (one activity in several lists), storage.sql (the media bucket), cron.sql, and three Edge Functions: send-reminders, unfurl (shared links, screenshots *and* location prediction) and delete-account (erasing an account needs the service_role key, so it cannot live in the client). All optional except profiles.sql; each other piece probes for itself and the UI that needs it hides when it is absent.
css/                  One stylesheet per concern (see CSS file map)
js/                   One script per concern (see JS file map)
icons/                App icon PNGs + generate.py, the script that draws them
Supabase Setup/       CSV exports of the Collections / Activities / Users tables (schema reference; STALE, see Back end)
_backup/              The original single-file version, kept as a safety net
```

There is no build step. Serve statically: `python3 -m http.server 8000`.

**Serving over plain http on a LAN IP is not a secure context**, and more than
the service worker depends on that. Testing on a phone against
`http://192.168.x.x:8000` disables:

- **service worker registration** — no offline shell, no install prompt.
  Registration failure is caught and logged; the rest of the app works.
- **`crypto.randomUUID`** — which the app needs for every row id. Always go
  through `uuidv4()` in `utils.js`, never `crypto.randomUUID()` directly. See
  the warning under **Working offline**; this shipped broken once and presented
  as `invalid input syntax for type uuid` on a phone while being perfectly fine
  on localhost.

`crypto.getRandomValues` is *not* gated and stays available. The same applies to
a `file://` URL. If you need the real thing on a device, tunnel localhost
(`ssh -R`, ngrok, Tailscale) rather than serving the LAN address directly.

### Screens and navigation

The app is modelled on a UIKit tab controller: **four root destinations in a
bottom tab bar**, plus three screens that push on top of a tab. All are
`<div class="page">` siblings shown one at a time by `nav()` toggling `.active`.
There is no router and no URL state — reloading always lands on Home.

| Page id | Route key | Tab | Rendered by |
| --- | --- | --- | --- |
| `page-home` | `home` | Home | `renderHome()` — the dashboard |
| `page-upnext` | `upnext` | (pushed on Home) | `renderUpNext()` — every unfinished activity |
| `page-done` | `done` | (pushed on Home) | `renderDone()` — everything ever completed |
| `page-search` | `search` | (pushed on Home) | `renderSearch()` — one field over everything |
| `page-lists` | `lists` | Lists | `renderCollections()` — every collection as a photo card |
| `page-detail` | `detail` | (pushed on Lists) | `renderDetail()` — one collection's activities |
| `page-globalmap` | `globalmap` | Map | `renderGlobalMap()` — every located activity |
| `page-me` | `me` | You | `renderMe()` — profile and account actions |

Tab labels are short ("Lists", "You") while every identifier in the code uses
the domain word (`collections`, `me`). Both name the same thing.

`nav(page, listId)` is the single entry point for changing screens. It:

- picks the entry animation — a rise/fade between tabs, a right-to-left push
  into `detail` (`PAGE_TAB` maps each screen back to the tab that owns it, so
  the right tab stays lit while a pushed screen is showing);
- **tears down the collection map** when leaving `detail`. The Map tab's
  globe is deliberately *kept* — see **The immersive map**;
- rebuilds the navigation bar via `updateNavbar()`, which is where each
  screen's bar buttons are defined.

`selectTab(tab)` handles tab-bar taps and pops back to a tab's root if you tap
the tab you are already inside. `goBack()` returns from `detail` to the tab it
was pushed from (`backTab`).

There is also a screen outside this system: the signed-out `#authPage`, which
`showAuth()`/`showApp()` swap against `#appWrap`. It is not a `.page` and
`nav()` knows nothing about it.

#### Home is derived, never authoritative

`renderHome()` owns no state. Every section is computed from
`fetchCollections()` + `fetchAllActivities()`:

- the progress ring, from the completed/total split;
- **Up Next**, the four most pressing unfinished activities, with a "See all"
  that pushes `page-upnext` (`js/upnext.js`) — the same rows grouped into
  urgency bands. Both share `upNextRowHTML()` and `sortUpNext()` from
  `home.js`, so the two screens cannot disagree about what "next" means. Its rows are
  deliberately fixed-height: the name is one ellipsised line and the meta line
  is `flex-wrap: nowrap` with the collection name as the only shrinkable
  child. Both matter — letting either wrap made row height depend on how long
  a name happened to be, so the deadline sat inline on some rows and on its
  own line on others and the list visibly re-flowed as you read down it. Below
  375px the collection name is hidden outright rather than truncated to a
  meaningless stub. Ranked by
  `targetRank()` then `priorityRank()` (both in `utils.js`). Deadline comes
  first and priority second, not the reverse: something due this month
  outranks a high-priority "someday", because the deadline is the part you
  cannot move. Sorting is on `daysToTarget()` — **actual days**, not the
  urgency band: the band is what colours the badge but is too coarse to order
  by, since a flight tomorrow and something three weeks out are both `urgent`
  and priority would otherwise push the flight below it. The grouping on the
  Up Next screen still uses the band, so a row's group always matches the
  colour of its label;
- Recently accomplished, by `completedDate` descending, **capped at six** —
  two rows of three.

Both shelves' "See all" links are shown whenever their section has anything in
it, **not** only once there is more than the shelf displays. Gating them on a
threshold was tried and reverted: it made the Up Next and Accomplished screens
undiscoverable for anyone with a short history, which is exactly the person
still learning where things are.

Home has no floating action button: the composer near the top is already the
add affordance, and two competing ones on a single screen is one too many. It
also has no lists shelf — that duplicated the Lists tab sitting in the tab bar.

Because Home has no collection context, adding from here goes through the
full activity sheet rather than inserting directly — see **The two-speed
activity flow**. Its one remaining private copy is `toggleCompleteFrom()`,
which reads the activity's own `listId` before updating that collection's
stats rather than assuming `curListId`. Keep it in step with
`toggleComplete()` in `activities.js`.

#### The cache

Two queries back the whole app — every collection, and every activity in
them — and both are held in memory for the session by `js/api.js`, and
on disk in IndexedDB by `js/offline.js`. Switching tabs re-renders from
that cache. It is why moving between screens no longer feels like a page
load, and it is what every other feature below reads from: duplicate
detection, search, and offline all run against it rather than the
network.

Five rules, and the first one is the one that bites:

1. **Every write must keep the cache honest.** `dbInsert`/`dbUpdate`/
   `dbDelete` handle this themselves via `applyOp()`; nothing else
   should have to. Miss it and the screen renders stale rows until
   something else happens to refetch.
2. **A write patches the cache, it does not drop it.** `applyOp()` has
   to compute the new row set for the on-disk snapshot anyway, so it
   hands that same result to `primeActivities()`/`primeCollections()`
   rather than nulling the cache and making the re-render fetch the
   whole table back to learn something the client just wrote. **Both
   refuse a cold cache** — priming one that has never been filled would
   make `cacheWarm()` true off the back of a single write — and fall
   through to the invalidate, which is the old behaviour and still
   correct.
3. **In-flight requests are shared.** Home renders four sections from the
   same two fetches; without this they raced into duplicate round trips.
4. **A failed request is never cached** — it returns `[]` as before but
   leaves the cache empty, so the next call retries instead of pinning an
   empty list for the session.
5. **`fetchActivitiesFor()` filters the shared cache** rather than
   issuing its own query. Entering a collection used to fetch the same
   rows twice, because `renderDetail()` and `renderActivitiesList()` each
   called it.

**`updateCollectionStats()` is not on the critical path and must not go
back on it.** `number_activities`/`activites_completed` are written but
never read — every count the UI shows is derived client-side. They were
nonetheless costing two serialised round trips on *every* mutation (a
select to recount, an update to store it), both awaited before the screen
was allowed to redraw, plus a third from the `invalidateCollections()`
they ended with. So it now returns immediately, does the work detached
and debounced per collection (`recountCollection`), and invalidates
nothing. `cancelPendingStats()` drops anything still queued at sign-out.

Together, rules 2 and that change took completing an activity from **five
serialised round trips to one**.

`cacheWarm()` is what lets a screen skip its spinner: blanking a screen
that is about to paint from memory turns an instant redraw into a visible
flash of nothing. `renderCollections`, `renderUpNext`, `renderDone` and
the list picker all check it.

`revalidate()` covers the case where this client is not the only writer —
the same account on another device, or someone else editing a shared
list — and is called from `auth.js` when the app is foregrounded and when
the network returns. **It flushes the offline write queue before it
refetches**; the other order makes the user's offline additions visibly
disappear and then come back a moment later. Sign-out clears the cache
*and* the on-disk snapshot, or the next person to sign in on the device
inherits the previous one's lists.

`readRows()` is the one helper behind both fetches and the only place
that decides between network and disk. Offline it does not attempt a
request at all — a tunnel should cost nothing, not a timeout.

#### Painting before the network answers

`readRows()` only reaches for the snapshot when the network *cannot*
answer, which is right for any single fetch and wrong for a cold launch:
a complete copy of the user's data is already on disk, and Home was
nonetheless waiting on two **serialised** round trips — collections, then
the activities that depend on their ids — before drawing a row.

So `showApp()` calls **`primeFromSnapshot()`** before its first `nav('home')`.
The screen paints from IndexedDB, and the network refresh happens behind
it. Four things about that sequence are load-bearing:

- **`main.js` awaits `showApp()`.** The splash has to hold until Home has
  actually painted; dropping it first shows an empty shell for the few
  milliseconds the IndexedDB read takes.
- **Everything else in `showApp()` stays un-awaited.** The probes, the
  profile load, the queue flush — none of them gate the first paint, and
  awaiting any of them puts it straight back on the critical path.
- **`probeSharing()` is awaited before `revalidate()`, and only there.**
  Nothing is waiting on that refresh, so letting the probe answer first
  costs nothing visible and guarantees the collections query runs with
  the right scope the first time.
- **A first-ever launch has no snapshot**, `primeFromSnapshot()` returns
  false, and the boot waits exactly as it always did.

`probeSharing()` no longer invalidates unconditionally when it comes back
true. It checks **`collectionsScope()`** — which records whether the
cached collections were fetched under RLS (`true`), under the client-side
`user_id` filter (`false`), or came off the snapshot and are correct by
construction (`null`). Only `false` needs the refetch. Unconditional, it
was a second full fetch of both tables on every single launch.

#### Refreshing after a change

`refreshAfterChange(src)` in `nav.js` is the single answer to "something
was written, what needs redrawing?". **Every mutation ends there**, and
it defaults to whatever screen is actually showing.

That default is the entire point. The old code passed a source string
around by hand and several paths hardcoded `'detail'` — so completing or
editing an activity from Up Next re-rendered the collection screen, a
screen the user was not even on, and the row they had just changed sat
there unchanged until they reloaded. Pass a source only to force a
specific screen; leave it off and the current one is correct by
construction.

The same applies to `selectTab()`. A tab button must **always** go
somewhere: the old guard bailed out whenever the tapped tab was already
lit, which broke every screen pushed on top of a tab — standing on Up
Next or Accomplished and pressing Home did nothing, because Home was
already the selected tab. It only special-cased `detail`. The rule is now
"if you are not on the tab's root, go to it", and tapping the root you
are already on scrolls to the top. It also calls `dismissOverlays()`
first: the tab bar sits above the scrim and stays tappable, so without
that a tap navigated the page underneath and left a sheet stranded over
the wrong screen.

#### Media

Photos **and video**, in `js/media.js`, stored in a Supabase Storage
bucket called `media`, one folder per user.

The `Activities.photos` column now holds only URLs, and holds two shapes
at once:

```
"https://…/x.jpg"          a photo — or a legacy base64 data URL
{type:'video',url,poster}  a video, with a still frame for thumbnails
```

**Photos stayed bare strings deliberately**, so every row written before
video existed still reads correctly. `normMedia`/`denormMedia` in
`api.js` convert, and `mapActivity` exposes both `a.media` (the full
ordered list — what the completion sheet and the lightbox walk) and
`a.photos` (images only — what thumbnails, grid cards and map pins want,
with a video contributing its poster). Keep that split: dropping
`a.photos` would mean touching every list in the app.

This was also the fix for the app's biggest performance problem. Photos
used to be base64 data URLs *inside the row*, so every render of every
list pulled all of them down again as part of the JSON. Video was never
possible that way — one phone clip is 5–20MB before base64 adds a third.

**It degrades rather than breaking.** `probeStorage()` checks for the
bucket once at sign-in, exactly as `probeRemindColumn()` checks for
`remind_at`. Without it, photos fall back to base64 (what the app did
before, so nothing regresses) and video is refused with an explanation
instead of failing at save time. Run `supabase/storage.sql` to enable it.

**The first piece of media is the cover** — it is what the activity's
row thumbnail, its grid card and its map pin all show. So "choose the
cover" and "reorder" are one operation with one control: tapping a
thumbnail in the completion sheet opens a menu (`openMediaMenu`) with
Make cover / Move earlier / Move later / Remove, and the current cover
carries a badge so the idea is visible without opening anything.

Drag-to-reorder is the obvious gesture and is deliberately not used: a
drag inside a scrolling sheet that also has swipe-to-dismiss on it is
three gestures competing for one finger, and touch behaviour cannot be
verified headlessly.

**The add button is a small pill and the tiles are 92px.** It was a
full-width dashed drop zone 26px deep, which made the control for adding
media louder than the media itself — the photos are the content on that
sheet, the button is only the way in.

`coverIndex()` picks the first entry with an image to show, matching how
`mapActivity()` builds `a.photos` — so the badge cannot disagree with
what the rest of the app draws, and a video whose poster frame failed to
capture is skipped by both (and is not offered "Make cover", since there
would be nothing for a pin to draw).

**Un-completing an activity never touches its media.** The toggle writes
only `date_completed`, and the media lives in `photos` — so photos and
notes attached to a completion survive being marked not-done and are
still there when it is completed again. Anything that changes what
un-completing writes has to preserve that.

Deleting a photo drops the URL from the row; it does not delete the
object. There is no reference counting here to make deletion safe, and
storage is cheap — `storage.sql` carries a sweeper query in a comment.

#### Guessing the location from the name

`maybeGuessLocation()` in `location.js`, over a
`{activity:{name,description}}` payload on the `unfurl` Edge Function. When a
**new** activity's name names a place, the location field fills itself in.

An activity with no location never appears on the map, and the location field
is the one people skip. The photo's EXIF answers that after the fact; this
answers it at the moment of capture, from the name alone.

**The whole feature is the strictness.** A model asked "can you think of
somewhere plausible" will always answer, and a place written into someone's
records on a guess becomes a wrong fact they believe later, having forgotten
a model put it there. So the bar is not plausibility, it is: *does the name
itself identify one specific place, such that any reader would agree?*

```
"Go on a hike"               → nothing. Anywhere on earth.
"Go to Arches National Park" → Arches National Park, Utah, USA.
"Take a cooking class in Italy" → nothing. A country is not a pin.
"See the Northern Lights"    → nothing. Tromsø is an association, not a reading.
```

**Four gates, and all four must pass.** Three are in `predictPlace()` on the
function — the model answering at all, its `certain` flag, and Nominatim
actually finding the place (somewhere the map cannot plot is worthless, since
plotting it is the only reason to guess). The fourth is `guessMatchesName()`
here: the predicted place has to **share a real word with the activity name**.
That is the rule the feature is built on written as code — if none of the name
is in the answer, the answer came from an association. It costs some true
positives ("See the Mona Lisa" will not resolve to the Louvre) and that is the
right side to miss on.

**It fills rather than offers, unlike the EXIF chip** — a deliberate
difference, and it rests entirely on the above. EXIF says "the camera was at
these coordinates", which is often true of the poster, the screenshot or the
drive there rather than the thing itself, so it has to be asked about. This
says "the name of this activity is the name of this place", which is either
right or the model should not have answered. What is filled in is marked with
a `.loc-guess` caption and one tap clears it — `undoLocationGuess()` empties
the field, because leaving a rejected value in place would be the silent write
the design exists to avoid.

Things to keep:

- **Only on create.** `openNewActivity()` arms it, `openEditAct()` disarms it.
  Renaming an existing activity is not an invitation to rewrite where it
  happens.
- **`change`, not `input`.** This costs a model call; one per keystroke is
  absurd. `openNewActivity(prefillName)` asks explicitly, because a name that
  arrived from a composer was never typed into the field and `change` will
  never fire for it — and that is the most common way an activity is created.
- **Typing in the location field settles it** (`onActLocInput()`), and a
  dismissal is sticky for the life of the sheet. `_guessSeq` drops answers
  that arrive after the sheet has moved on.
- **The cost is one model call per activity created this way**, and nothing
  caches across sessions.

The same "read it, never infer it, never a whole country" rule is now in the
import schema's `location` description, so a typed name, a shared link and a
screenshot cannot disagree about what counts as a place.

#### Where the photo was taken

`js/exif.js` reads the GPS block out of a JPEG, and `handleMedia()`
offers it as the activity's location when there isn't one already.

The case: an activity with no location never appears on the map, and the
completion sheet is exactly where that gets missed — you have just done
the thing, you are attaching the photos of it, and the one field that
would put it on the map is the one you skip. The photos already know.

Three things that are not negotiable:

- **It reads the original `File`, before anything re-encodes it.**
  `compress()` in `utils.js` draws to a canvas and reads back with
  `toDataURL()`, and a canvas knows nothing about EXIF — every tag is
  gone from the result. So the read happens in `handleMedia()` on the
  file as picked, never on anything `uploadPhoto()` has touched. Moving
  it downstream silently returns null for every photo.
- **It suggests, it never fills.** `suggestLocationFromPhoto()` draws a
  `.loc-suggest` chip under the field; `acceptPhotoLocation()` is what
  writes. EXIF can be wrong — a photo of the poster advertising the
  thing, a screenshot someone sent you, a stale fix — and writing a place
  into the record of something you did on that evidence is worse than not
  offering. Same rule the import sheet follows.
- **Only when the field is empty** (`needsLocationSuggestion()`), and a
  dismissal is sticky for the life of the sheet so the next photo does
  not bring the offer back. `openComp()` calls `resetLocationSuggestion()`
  so that stickiness cannot leak into the next activity.

The parser is hand-rolled because it is a fixed walk over a specified
binary layout, and that is smaller than the smallest library. It handles
both byte orders, tolerates junk segments ahead of APP1, and returns null
on anything malformed rather than throwing.

**Two containers, because a phone produces both:**

| | EXIF lives in | Reads |
| --- | --- | --- |
| JPEG | an APP1 segment near the front | one slice |
| HEIC / HEIF / AVIF | an addressable *item*, via the ISOBMFF box tree | two |

HEIC is what an iPhone shoots by default. Safari *usually* converts it to
JPEG on the way through a file input — but "usually" is doing real work
there: it depends on the iOS version and how the picker was opened, and
when it does not convert, the feature silently does nothing. Which is
what it did. The box walk is
`ftyp → meta → iinf` (which item id has type `Exif`) `→ iloc` (where in
the file those bytes are), then a second targeted slice. **The payload
lands on an ordinary TIFF header, so everything downstream is reused
unchanged** — HEIC support is a new way to *find* the same block, not a
second parser. `iloc` is the awkward part: the width of every offset
field is declared inside the box and the layout shifts across its three
versions, all of which are handled.

**Dispatch is on the magic bytes, never on `file.type`.** iOS reports the
type inconsistently and sometimes not at all, and that mislabelling was
itself a way the feature silently failed. The bytes cannot be wrong.

**What it will not find:** screenshots, anything shot with the in-app
camera, and anything that has been through a messaging app (most strip
metadata on send, which is a feature). A real PNG is left alone rather
than guessed at.

`reverseGeocode()` in `location.js` turns the fix into a name, at
`zoom=14` — the default returns a full postal address, which is both too
precise to be useful and slightly unnerving to be shown back to you.

#### Working offline

`js/offline.js`. Before it, "offline" meant the shell loaded and every
list was empty: `sw.js` caches the app's own files but Supabase is on
`NEVER_CACHE_HOSTS`, so there was nothing to show and nothing you could
do. That is the wrong failure for an app whose purpose is catching an
idea the moment it arrives — ideas arrive on planes and in tunnels.

Two halves: a **snapshot** of the two backing queries in IndexedDB, and
a durable **queue** of writes replayed in order on reconnect.

**The whole design rests on one fact: `Collections.id` and
`Activities.id` are `uuid` columns.** So the client mints a row's
permanent id itself and inserts it explicitly. That removes the hardest
part of offline sync — there are no temporary ids, nothing is rewritten
when a queued insert lands, and a row created offline can be edited,
completed and deleted *by id* before it has ever reached the server. Ids
are minted for online writes too, so the two paths are one code path.
`saveList()` no longer needs `.select().single()` to learn the new id.

⚠️ **Mint them with `uuidv4()` (`utils.js`), never `crypto.randomUUID()`
directly.** `crypto.randomUUID` is only defined in a **secure context** —
https or localhost — so it is `undefined` when the app is served over
plain http on a LAN address, which is exactly how you test it on a phone.
The same restriction that stops the service worker registering there.
This shipped broken once: the fallback returned `'x' + timestamp +
random`, which is not a uuid, and every insert failed with `invalid input
syntax for type uuid` on a LAN IP while working perfectly on localhost.
`uuidv4()` falls back to `crypto.getRandomValues` (which is *not*
secure-context-gated) and formats a real RFC-4122 v4 string, and
`stampRow()` asserts the shape with `isUuid()` before anything is sent.
Anything else that needs a random id — `mediaKey()` in `media.js` —
shares it.

Things to keep in mind:

- **Every mutation goes through `dbInsert`/`dbUpdate`/`dbDelete`**, not
  `sb.from(...)` directly. They return the familiar `{error}` plus
  `offline:true` when queued. They also call `invalidateActivities()`/
  `invalidateCollections()` themselves, so mutation sites no longer do —
  see the backlog note about this being the real fix for rule 1 above.
- **Only a *network* failure queues.** `isNetworkError()` separates
  "could not reach the server" from "the server said no". A row rejected
  by a constraint or by RLS would be rejected again forever, so it is
  reported rather than queued; a replay that keeps failing is dropped
  and logged rather than wedging the queue behind it.
- **Replayed inserts use `upsert(..., {onConflict:'id'})`**, because the
  original attempt may in fact have reached the server before the
  connection dropped.
- **The snapshot stores raw PostgREST rows**, not the camelCase UI
  shapes. `mapActivity()`/`mapCollection()` stay the single place that
  knows column names, so a mapper change applies to cached rows too.
- **`updateCollectionStats()` is skipped offline.** Those two columns are
  written but never read; queueing a write of them would add a round
  trip's worth of ops for a number nothing displays.
- **Media is the one thing not queued.** Photos taken offline fall back
  to inline base64 (what the app did before the bucket existed) so a
  completion syncs whole; video is refused with an explanation, because
  a 5–20MB clip sitting in IndexedDB is a different feature.
- No conflict resolution — last write wins. Correct for a library one
  person curates from their own devices, and the honest answer for
  shared lists too.

The banner's text lives here rather than in `pwa.js`, because what it
should say depends on how many writes are waiting.

#### Finding things again

`js/search.js`, over `js/fuzzy.js`. The detail screen has always had a
search box, but it only searched the collection you were already
standing in — the wrong shape for an app whose point is that an idea can
be filed anywhere. "Where did I put that" is a question about the whole
library.

A **pushed screen, not a tab**: the tab bar is full at four, and search
is somewhere you arrive with a question rather than a place you browse.
Reachable from the bar button on Home, Lists, Up Next and Accomplished —
not the Map (its chrome floats over the globe and already has a filter)
or You.

Like `renderDetail()`, it is **split in two**: `renderSearch()` builds
the screen, `renderSearchResults()` rebuilds only the results. The field
is part of the page so it can pin under the nav bar, and rebuilding it
per keystroke would drop focus. `refreshAfterChange('search')` calls the
second one for the same reason.

Only the **literal** query substring is highlighted, never the fuzzy
match: a fuzzy hit has no single span to point at, and per-character
marks read as corruption. `searchMark()` is therefore the one place in
the app that does not `esc()` a rendered string wholesale — it splits on
the raw text and escapes each piece itself. Don't "simplify" it.

#### Catching duplicates

`js/dupes.js`. Pulling scattered ideas into one place necessarily drags
the same idea in more than once, so the moment capture got easy,
duplicates became the next failure. Three rules:

1. **Nothing is ever deleted or merged automatically.** A match is a
   question, not a verdict. "Add anyway" is the primary button, because
   the app being wrong must never cost more than one tap.
2. **It must not slow capture down.** `dupeGuard()` runs synchronously
   against the in-memory cache and calls its callback immediately when
   there is no match — the fast path is unchanged, not merely quick. A
   cold cache means nothing to compare against and the add proceeds.
3. **Matching is fuzzy.** An exact-text check — what most apps ship —
   catches neither "Skydive in Interlaken" vs "Go skydiving in
   Interlaken" nor a typo.

Every add path routes through it: both composers, `saveActivity()`, and
`saveBulkActivities()`. An **edit** is only checked when the name
actually changed, or saving an untouched activity would report it as a
duplicate of every near-miss in the library; `excludeId` stops it
matching itself.

A **batch** is checked as a whole (`dupeGuardBatch()`, which returns a
promise for the subset to keep). Stopping on the first collision would
mean fixing one row and being stopped by the next — intolerable at ten
rows. Every way out of that sheet has to settle the promise, including
the scrim, Escape and a swipe down; cancelling resolves to `[]`.

**On the thresholds.** `DUPE_POSSIBLE` (.58) is deliberately loose.
There is a class of pair — one distinctive word inside a longer phrase —
where no threshold separates a true duplicate ("Eat at Noma" / "Dinner
at Noma Copenhagen") from a false one ("Visit Paris" / "Paris Hilton
documentary"); they score within a hundredth of each other. The tie goes
to catching it: a false positive costs one tap, a missed duplicate is
the problem the user came here to fix.

`similarity()` also uses **location to adjust, never to decide**: two
activities called "Watch the sunrise" in different countries are not
duplicates, and the place is the only thing that says so.

#### How the fuzzy matching works

`js/fuzzy.js` has **two entry points because they are different
problems**, and using one for the other gives bad results both ways:

| | Compares | Used by |
| --- | --- | --- |
| `similarity(a,b)` | two finished phrases, symmetric | duplicate detection |
| `matchScore(q,text)` | a fragment against a whole phrase, asymmetric | search |

Search has to score "fush" highly against "Fushimi Inari" even though
the two are barely similar as strings; duplicate detection must not.

Underneath: normalise (case, accents, punctuation), tokenise (dropping
leading verbs so "Visit X" ≈ "X", and a tiny abbreviation table so
"Mt Fuji" ≈ "Mount Fuji"), then blend **soft token Dice** with
**character trigrams**. "Soft" matters — pairing words by how alike they
are rather than demanding equality is what makes "skydive" match
"skydiving", which no amount of character overlap does. `fuzzyStem()`
exists for exactly that and is a crude suffix stripper, not a real
stemmer.

Containment is scaled hard by the length ratio. A generous floor there
was what made "Visit Paris" a duplicate of "Paris Hilton documentary":
the short name is genuinely inside the long one, but it accounts for a
fifth of it, and a fifth is not a match.

**If you retune any of these, re-run the pairs in the header comment.**
The constants are tuned against real phrasings, not derived.

#### Shared lists

`js/sharing.js` plus `supabase/sharing.sql`. A shared collection is an
**ordinary collection** — it appears on the Lists tab, its activities are
on Home, on the map, in search — so nothing in the app had to learn a
second kind of list. The only differences are a badge, a Share entry in
the ⋯ menu, and Leave in place of Delete for a list you do not own.

**Invites are a link with a random code, not a username lookup.**
Inviting by username needs a policy letting any signed-in user search
`Users`, which turns a private table into a directory; a link needs
nothing known about the other person in advance, works before they have
signed up, and travels over whatever the two people already use to talk.
The code is minted client-side so the link exists the instant the sheet
opens. `?join=<code>` is read at boot **before `restoreSession()`**, for
the same reason `?share=` is: it can arrive while signed out.

**And it has to survive a reload, which is not the same thing.** Both
captures are read at boot, stripped from the URL immediately, and then
held until there is a signed-in user to hand them to — and the gap
between those two moments is precisely where a reload is most likely,
because the recipient of an invite is the one person guaranteed to have
to sign in first. A reload there finds a URL with nothing left in it and
a global that has been reinitialised, so the capture is gone for good.

This shipped broken, and the reload was the app's own: `sw.js` calls
`clients.claim()` on activate, so a **first** visit acquires a controller
it never had, which fired `controllerchange`, which `pwa.js` turned into
`window.location.reload()`. Every invite link opened by someone whose
browser had not seen the app before — which is every recipient, the
first time — landed on the plain app with the code already destroyed. It
presented exactly as "sharing doesn't work; the link just opens the
normal page".

Two things fix it and both should stay, because they fail differently:

- **`pwaHadController` in `pwa.js`.** The reload is for when the worker
  *changes*, never when it *arrives*: on a first install the page is
  already running the newest code, so the reload buys nothing and costs
  the query string. The flag is read at parse time because by the time
  `controllerchange` fires the controller is non-null either way. The
  `updatefound` handler beside it already drew this distinction; this is
  the same check, which it was missing.
- **`bootKeep`/`bootRead`/`bootDrop` (`utils.js`)**, a sessionStorage
  shelf for anything captured from the URL at boot. That is the general
  answer — any reload eats these, not only the service worker's.
  **Reading does not remove**: a capture is dropped when it is
  *consumed*, by `handlePendingJoin()`/`handleSharedInput()`, so it
  survives any number of reloads before sign-in and none after. Dropping
  on consume rather than on accept is what preserves the original
  property that a reload cannot re-run a join.

#### Accepting an invite, and why it needs four answers

The link is the convenient path and it is *not* the reliable one,
because everything it has to survive happens in apps this code does not
control. Three separate defects here all presented identically — "I sent
the link, they opened it, and nothing happened" — which is why the
mechanism now has a floor under it rather than one more fix.

**A shared link dies with its tab; an invite must not.** `bootKeep` is
sessionStorage, which is the right lifetime for `?share=` and the wrong
one for `?join=`, and the difference is what the recipient does next. A
shared link lands on someone already signed in. An invite lands on
someone who has to sign in *first*, and signing in is exactly when people
leave the tab — to open a password manager, to check which email they
used, to fetch a confirmation. iOS Safari discards background tabs
aggressively, so they come back to a fresh tab, an empty sessionStorage,
and a URL whose query string was stripped on the way in. The invite was
gone, and it looked like the link had never carried anything.
**`bootKeepLong`/`bootReadLong`/`bootDropLong` (`utils.js`)** are the same
shelf on localStorage, with an explicit stamp and a 7-day TTL replacing
the "cannot be re-run days later" property sessionStorage gave for free.
Only the join code uses them; a stale link import resurfacing a day later
would be a regression, so `?share=` keeps the short shelf.

**A failed join must not consume the invite.** `handlePendingJoin()`
dropped the code from the shelf one line after reading it, and *three* of
the paths below that can fail before the user has had any chance to join
— the sharing probe answering false, the device being offline, the invite
not reading back. Consuming it first meant a failure destroyed the invite
permanently: the link had already stripped itself out of the URL, so
there was nothing left to retry with. The code is now dropped once
`peek_invite` has succeeded and the sheet is showing, which keeps the
property the early drop existed for — a reload while the sheet is open
finds no code and cannot re-run the join — and leaves every recoverable
failure recoverable. A code that *cannot* be read is still consumed, or
the same error sheet reopens on every launch.

**The sign-in screen has to admit it is holding something.**
`updateAuthInviteNotice()`, called from `showAuth()`. Without it the
recipient sees an ordinary login form, and if anything downstream goes
wrong they cannot tell whether the link ever carried an invite — which is
precisely how this reads from the outside when it breaks.

**And there is a path with no link in it at all.** `openJoinByCode()` /
`submitJoinCode()` / `parseInviteCode()`, reachable from *Join a shared
list* in the You tab and from the error state of a failed invite. The
invite has always *been* an 18-character code; this just lets it be
typed. Same shape as the reminder delivery tiers and the four ways a link
gets shared in — the reliable floor exists so that the convenient path
failing is an annoyance rather than the feature not existing. It lands
straight back on `handlePendingJoin()`, so a code and a link cannot
disagree about what joining looks like, and `parseInviteCode()` accepts a
whole pasted invite URL or share message as readily as a bare code,
because what people have in their clipboard is whatever they were sent.
The share sheet therefore shows the code beside the link, and
`sendInviteLink()` puts it in the message body.

#### An invite that survives creating an account

**The state lives on the server, keyed by email address.** Every other
capture in `sharing.js` is bounded by one device, which is enough for a
recipient who already has an account and not enough for the case sharing
exists for — handing the app to somebody who has never seen it. They have to
sign up, this project confirms addresses, and the confirmation link gets
opened wherever their mail is, which is usually the other phone. There the
`bootKeepLong` shelf is empty and the invite is gone with nothing on screen
to say so.

Carrying the code on the auth user's metadata was built and reverted — the
chain ran in-memory global → localStorage → auth metadata → a probe race → a
sheet, and every link in it fails silently. So:

- **`claimInviteForEmail(code, email)`** is called from `handleAuth()` *before*
  `signUp()`, and records "whoever signs up with this address means to join
  this list" in `invite_claims` (section 5 of `sharing.sql`). Before rather
  than after: if the request reaches the server and the response never
  arrives, the account exists and this page may never run again.
- **`claimInvitesForMe()`** redeems it from `showApp()`, on whatever device
  eventually signs in, and **returns what it joined** so the app can say so
  and open the list. A shared list that silently materialises is only
  marginally better than one that never arrives.

Four things hold it up:

- **There is deliberately no trigger on `auth.users`**, though that is the
  obvious shape and the one profiles.sql uses. It would join them before the
  address is confirmed, it fires exactly once so an error loses the invite for
  good, and the client could not then tell them. An unclaimed row simply waits
  and is redeemed on the next sign-in.
- **`inviteSweepDue()` (`auth.js`) decides when to ask**, because for almost
  every launch the answer is "nothing waiting" and this is a round trip. Two
  things make it due: a real authentication just happened (the form, or a
  confirmation link redeemed at boot), **or** the account is under a week old.
  The second is the retry belt — a session restored from storage never passes
  the first test, so a sweep that failed while offline would otherwise never
  run again, the person being already signed in and having no reason to sign
  in twice.
- **The two paths never race.** `showApp()` skips the sweep when the ordinary
  link capture is already running. Nothing is lost: the claim stays on the
  server and a later launch consumes it in silence, because
  `claim_invites_for_me()` reports only lists it actually joined and says
  nothing about one the user is already in.
- **The sign-in screen opens on Create Account** when an invite is pending and
  this browser has never held a session (`showAuth()`), and
  `updateAuthInviteNotice()` names the list — `peek_invite` is granted to
  `anon` precisely so it can. *"Landon shared "Japan 2027" with you"* is a
  reason to make an account; *"sign in to continue"* is a form. Once they have
  gone off to their inbox, `authInviteWaitingNotice()` repoints the same block
  to say the invite is no longer riding on this browser.

What this exposes: `claim_invite` has to be callable by `anon` — there is no
session at sign-up — so anyone holding a live code can register any address
against it, and that list would appear in their account if they later sign up.
Someone holding the code could already have emailed it to them directly.
Claims are capped per address, expire after 30 days, and are readable by
nobody: RLS is on with no policies at all.

**Moving the shelf ate one release's invites, and `bootReadLong()` now
carries the migration.** The join code lived in sessionStorage under the same
key until `bootKeepLong` arrived, and `sw.js` calls `skipWaiting()` on install
plus `clients.claim()` on activate — so opening an invite link on a device
that already had the app cached ran the *old* code first. It captured the code
into sessionStorage and stripped the query string; the new worker took over,
`pwa.js` reloaded the page (correctly — a real update); and the new code looked
in localStorage, found nothing, and the invite was gone with no URL left to
retry from. So a miss falls through to the old location and promotes what it
finds. **Keep that as the general rule, not as this one migration**: any boot
capture that changes where it lives has the same one-page-load window, and it
is silent at both ends.

**iOS cannot be made to open the PWA instead of Safari.** There is no
API for it: Universal Links need a native app and an AASA file, and a
manifest scope is a hint the OS is free to ignore. This is the same
platform wall that makes the app unable to register as a share target.
It matters less than it looks, though, and that is worth stating plainly
in any future debugging: **joining is a server-side membership row**, so
an invite accepted in Safari is already in effect in the installed PWA —
the detour is cosmetically annoying, never the reason a list fails to
appear. If a list is missing after a join, the join did not happen; look
at the four mechanisms above, not at which browser it opened in.

**A shared list is badged on the Lists tab in both directions** — one you
joined and one you own and invited someone into. `isSharedWithMe()` answers
the first from the row itself; `sharedCollectionIds()` answers the second
with one query, since the RLS policy on `collection_members` returns your own
membership rows *plus* every row for a collection you own. It is cached and
dropped by `invalidateSharedIds()` wherever membership can change (join,
leave, remove). The badge is an icon-only disc in the **top-right**, opposite
the "N High" count so the two coexist — a shared list is as likely to have
urgent work in it as any other.

It degrades like everything else optional: `probeSharing()` looks for
`collection_members` once at sign-in. Two traps:

- **The probe races the first render.** `fetchCollections()` has usually
  already answered with `sharingReady()` still false — which means it
  filtered to owned lists and cached that. So the probe invalidates and
  re-renders when it flips true, or joined lists stay invisible until a
  reload.
- **`fetchCollections()` drops its `user_id` filter once sharing is on**
  and relies on RLS to scope the result. That filter was never a
  security boundary (see **Back end**), but with sharing off it is left
  in place: without RLS, removing it would return every user's rows.

Permissions are enforced by **RLS, not by this file** — the checks here
decide which buttons to draw. Owner: everything, including deleting the
list and revoking links. Member: add, complete, edit and delete
activities, rename the list, leave. See the header of `sharing.sql` for
why the `SECURITY DEFINER` helpers exist (policy recursion) and why
`collection_members` deliberately has **no INSERT policy**.

Joining and inviting both need the network. Activities in an
already-joined shared list queue and sync like any other.

#### The immersive map

The Map tab is full bleed: `.page-map` drops all padding and the map
container is `position:absolute; inset:0`, so it runs under both bars. Every
control floats on top of it — a glass filter pill, a place count, and two
round buttons — rather than being laid out around it.

**It is MapLibre GL, not Leaflet.** That swap was the point: Leaflet is a
DOM/raster map that cannot draw a globe and repositions hundreds of nodes on
every pan. MapLibre renders on the GPU and has a real globe projection, so
zoomed out you get the Earth as a sphere and it eases into flat web-mercator
as you zoom in — the Google Earth behaviour. Things worth knowing:

- **`projection:{type:'globe'}` must be set in the *style*.** Passing it only
  as a `Map` option silently does nothing in v5.
- **The style has no `glyphs` endpoint**, so it cannot contain a `symbol`
  layer with a `text-field` — adding one throws inside the `load` handler and
  leaves the map with no data source at all. That is why cluster bubbles are
  DOM markers (`makeClusterEl`) rather than a GPU symbol layer. Clustering
  itself still happens in MapLibre's worker; only the handful of visible
  bubbles and pins are DOM.
- **In globe projection MapLibre paints nothing outside the sphere**, so the
  sky is a CSS gradient on `#globalMapContainer`, not a map layer.
- **There are no DOM markers.** Pins and cluster bubbles are drawn into
  canvases, registered with `map.addImage()`, and rendered by `symbol` layers,
  so they are composited in the same GPU pass as the map. They started as
  `maplibregl.Marker` elements, which JavaScript repositions once per frame —
  that can never stay in step with a GPU-composited map, and the pins visibly
  swam against the terrain during a pan. The MARKER ICONS section of `map.js`
  is entirely about keeping them welded to the map.
- Because cluster properties are generated by MapLibre, cluster icons are
  selected by the `CLUSTER_ICON_EXPR` expression and the matching images are
  registered on demand as counts appear. Point icons are stamped onto the
  GeoJSON as `_icon` instead, since we own that data.
- Photo pins decode asynchronously and fall back to a dot until ready. Reading
  a canvas back taints it if the photo is cross-origin without CORS headers;
  the app's own photos are base64 data URLs so this only affects remote covers,
  and it degrades to a dot rather than failing.
- **`globeFillZoom()`** computes the zoom at which the globe just fills the
  viewport (the sphere is ~211px across at zoom 0 and doubles per level) and
  is used as the map's `minZoom` and as a floor on `fitGlobal()`. Without it
  you can zoom out to a tiny marble adrift in space, which reads as broken.
  `refreshMapZoomFloors()` recomputes it on resize/rotate.
- **The globe is kept alive across navigation.** `nav()` tears down only
  the collection map. Rebuilding the globe on every visit meant
  re-downloading the style, re-fetching tiles and re-spinning it up,
  which was most of what made this tab feel slow; keeping it leaves at
  most two live WebGL contexts, an order of magnitude under what
  browsers cap. Because a hidden container measures 0,
  `renderGlobalMap()` resizes on the way back in, `globeFillZoom()`
  floors at 0 rather than returning `-Infinity`, and
  `refreshMapZoomFloors()` skips a map that is not on screen.
  `destroyGlobalMap()` still exists and is called on sign-out.
- **Build the map and fetch the data at the same time.**
  `renderGlobalMap()` starts the query, then builds the map without
  awaiting it, and joins the two with `Promise.all`. It also used to call
  `updateGlobalMapMarkers()` on load, which refetched every activity —
  photos included — purely to filter a list it was already holding.
- `webglOK()` degrades to a message rather than a blank rectangle.

The per-collection map inside the detail screen uses the same code but stays
flat — at one collection's scale a globe is unhelpful.

#### Staying signed in

Being asked to log in again is the failure users notice most, so the boot path
is defensive about it. `restoreSession()` in `main.js` handles three separate
causes, and they need different answers:

1. **The access token lapsed while the app was closed.** `getSession()` usually
   refreshes it; if that call fails we retry with `refreshSession()` before
   giving up.
2. **The device is offline at launch.** A network failure is *not* a signed-out
   user. If a session is on disk and `navigator.onLine` is false, the app opens
   anyway and the offline banner explains the missing data. Signing someone out
   because their train went into a tunnel is the worst version of this bug.
3. **The refresh timer stalled while backgrounded.** Handled in `auth.js` — see
   its row in the JS map.

The opposite failure — staying signed in when you should *not* be — is
`ensureSessionLive()`; see **Being signed into an account that no longer
exists**.

Supporting pieces: `config.js` spells out the auth options rather than relying
on defaults (and pins `storageKey`, so a supabase-js upgrade cannot silently
sign everyone out by changing it), and `body.booting` shows a splash until the
restore resolves, so a slow connection never flashes the login screen at
someone who is already signed in.

Worth knowing: **an installed PWA has its own storage partition on iOS**, so
signing in inside Safari and then installing to the home screen means signing
in once more. That is the platform, not a bug.

#### Being signed into an account that no longer exists

**This shipped, and it is the other half of staying signed in: a stored
session is not proof the account behind it still exists.** Deleting an account
signs out the device that pressed the button and nothing else — and there is
always something else. Another browser, a laptop, and on iOS the installed
PWA, which by the note above is a second signed-in copy of the app by
construction.

Nothing ever asked the server about any of them:

- `getSession()` answers **from disk with no request** while the access token
  has not expired, so `restoreSession()` saw a perfectly good session;
- PostgREST verifies a JWT's **signature**, not that `auth.uid()` still exists
  in `auth.users`. The token kept being accepted, and reads came back empty
  because the rows had cascaded away — which is indistinguishable from an
  account with nothing in it.

So the app opened as a deleted account for the lifetime of an access token.
It was found by following an invite link into one, and everything downstream
then failed pointing anywhere but here: `peek_invite` succeeded (the JWT is
signed, and it is granted to `anon` regardless), the sheet opened, the invite
was consumed, and only `join_collection()` failed — on a foreign key onto
`auth.users` — reading on screen as *"that invite link isn't valid"* for a
link that was perfectly good.

`ensureSessionLive()`/`verifyLiveUser()` in `auth.js` ask once per launch, via
`sb.auth.getUser()` — a real request to `/auth/v1/user`, which 4xxs for a user
that has been deleted or banned. Four things about it:

- **It never blocks the first paint.** `main.js` starts it and does not await
  it. The two things that must not run against a dead session —
  `handlePendingJoin()` and `claimInvitesForMe()` — await it themselves, and
  `handlePendingJoin()` does so **before** it takes the code out of the global,
  so a rejected session cannot consume an invite.
- **Only a definitive answer signs anyone out** (`authAnswerIsDefinitive`). A
  request that never arrived is not an answer; nor is a 429 or a 408. This is
  the same rule `restoreSession()` follows for the same reason, and getting it
  wrong here would be a worse bug than the one it fixes.
- **It runs at every moment a device could act, not only at launch.** The
  launch check alone leaves an app that is *already open* running as a deleted
  account until somebody closes it, and an installed PWA is rarely killed —
  "the next launch" can be days away. So `recheckSessionSoon()` is also called
  on foreground, on the network returning, every five minutes while the app is
  on screen (`startSessionWatch`), and — the one that matters most — **when
  the server rejects a write**, in all three of `dbInsert`/`dbUpdate`/
  `dbDelete`. That last one means the first thing the user tries to *do* in a
  deleted account throws them out, rather than the next tick. They share one
  30-second throttle, so a run of failing writes is one question and not one
  each: eight rejected writes cost exactly one `getUser`.
- **`signOutStaleSession()` is `handleSignOut()` minus everything needing a
  working session** — no server-side revoke, no push unsubscribe, both of
  which would only 4xx. It keeps `pendingJoin`, so the invite that exposed
  this survives to the sign-in screen it lands on.

**Signing out everywhere is two halves, and only one of them is a server's to
do.** `delete-account` now calls `admin.signOut(jwt, 'global')` before
`deleteUser`, which revokes every refresh token the account holds on every
device — so no other copy of the app can ever *renew*. (Deleting the user
cascades those rows anyway; being explicit is belt to that brace, and it is
placed after the failure check so a half-failed deletion cannot sign the
caller out of an account that is still alive.)

What no server can do is revoke an **access token that has already been
issued**: they are stateless signed JWTs, verified by signature alone, with
nothing consulted while one is inside its lifetime. That residual window is
what the client checks above close, and **its size is the project's JWT
expiry setting** — Authentication → Sessions → *Access token (JWT) expiry*,
3600s by default. Lowering it shortens the worst case for anything that never
opens the app at all; it is the one lever on this that is not code.

#### One account at a time

**This is a security boundary and it shipped broken once. Read this
before touching anything that runs at sign-in.**

Every cache in the app is per-account: the two row caches in `api.js`,
`userProfile`, `_sharedIds`, the live WebGL maps, and the navigation
state. All of them were cleared in `handleSignOut()` **and nowhere
else**, so any sign-in that followed a session ending some *other* way
was served the previous account's rows out of memory. Creating a new
account was the worst case rather than the safest: a new account has no
disk snapshot, so `primeFromSnapshot()` returned false, so `showApp()`'s
`if(warm)` skipped the `revalidate()` that would eventually have
corrected it — and the new account saw the old one's lists, activities,
notes and photos for the entire session.

**Do not repeat the mistake that was made when this was diagnosed.**
It was written up as "client-side only — RLS still refuses every
write", on the strength of an unauthenticated probe coming back empty.
That was wrong. Three `to authenticated ... using (true)` policies were
sitting on `Collections`, `Activities` and `Users`, OR'd over every
correct `bl_*` policy, so the account really did have full read, write
and delete on everyone's data. They granted nothing to a logged-out
request, which is exactly why the probe looked clean.

An anonymous request cannot tell you a project is scoped. Only
`pg_policies` can. See `supabase/rls-lockdown.sql`.

Two mechanisms now, and **both should stay** — they fail differently:

1. **`cacheOwnerCheck()` in `api.js`** is the structural one. The cache
   records whose rows it holds, and every entry point that can read or
   fill it — `fetchCollections`, `fetchAllActivities`, `cacheWarm`,
   `cachedCollections`/`cachedActivities`, `primeCollections`/
   `primeActivities`, `primeFromSnapshot` — calls it first. A mismatch
   wipes the cache rather than answering. It lives beside the cache
   deliberately: anything else relies on every present *and future*
   sign-in path remembering to clear it, which is exactly what failed.
   **A new cache read must call it.**
2. **`resetAccountState()` in `auth.js`** clears the per-account state
   in the other files, which the cache guard cannot see. It runs on
   every auth transition in both directions — `handleSignOut()`, both
   success paths in `handleAuth()`, the `SIGNED_OUT` branch of
   `onAuthStateChange`, and the branch where a *different* user's
   session arrives on an existing page.

Two things `resetAccountState()` deliberately does **not** touch:

- **The disk snapshot.** It is keyed by user id already (`snapKey()` in
  `offline.js`), so it cannot leak, and a session lapsing in a tunnel
  is not a reason to destroy someone's offline copy of their own data.
  Explicit sign-out still clears it.
- **`probeStorage()` / `probeRemindColumn()`.** Facts about the
  database, identical for everyone. `probeSharing()` *is* reset, only
  because `_sharedIds` beside it is per-user.

**The offline write queue is one shared store**, unlike the snapshot,
so `queueWrite()` stamps each op with `uid`. `flushQueue()` skips ops
belonging to anyone else — not replaying them and, importantly, not
dropping them either: they belong to an account that may well sign back
in, and RLS would reject every one under this session. `queueLoadCount()`
counts only the signed-in user's, so the banner never reports someone
else's stranded writes. Ops with no `uid` predate the field and are
treated as the current user's.

#### Deleting an account

`supabase/functions/delete-account` plus `openDeleteAccount()` in
`me.js`. It has to be a function because removing the row from
`auth.users` needs the `service_role` key, which must never reach a
browser.

**The uid comes from verifying the caller's own JWT, never from the
request body**, and there must never be a "delete user X" parameter:
this runs as `service_role`, so a uid taken from the body would let any
signed-in user erase anybody.

Order matters. `auth.users` goes **last** — several tables reference it
with `on delete cascade`, so removing it first would pull rows out from
under the deletes still to run, and a failure after that point would
leave an account that cannot sign in but still owns data. If any earlier
step fails the function stops short and reports, leaving the account
intact and the call re-runnable.

What survives: a shared list the caller *joined* is only left, and the
other members keep it. A list the caller *owns* and has shared is
deleted for everyone on it — there is nobody to hand ownership to
without asking. The sheet says both in as many words.

**It is the one place in the app that makes you type something.** Every
other destructive action is a single action sheet, which is right when
the cost is one list; this ends the account with no undo, and an action
sheet is dismissed by a stray tap on the scrim. The button stays
disabled until the word matches, so the tap that destroys the account
cannot be the same reflex tap that opened the sheet. The local sign-out
only happens *after* the server confirms, or a failure would look like
success.

#### Signing up

**This project has email confirmation switched on** (`mailer_autoconfirm` is
false — check with `GET /auth/v1/settings`), which means `signUp()` returns a
user and **no session**. That single fact broke profile creation for every
account made here: `handleAuth()` wrote the `Users` row inline right after
`signUp`, which can only work with a session, so the name and username the
person had just typed were dropped and no row was ever created. They
confirmed their email, signed in, and had no name in the You tab and nothing
to be identified by on a shared list.

The fix has two halves and both should stay:

- **The values ride on the auth user.** `signUp()` passes them as
  `options.data`, so they survive the round trip through the confirmation
  email — including the common case where it is opened on a different
  device from the one that signed up.
- **`loadUserProfile()` creates the row when it is missing**, via
  `createUserProfile()`. Running on every sign-in rather than only after
  sign-up is deliberate: it also repairs accounts created while this was
  broken. Username collisions are an expected outcome there, not an error —
  it suffixes and retries.

`supabase/profiles.sql` is the server half and the better one: a trigger on
`auth.users` writes the row inside the sign-up transaction, so it exists
whether or not the person ever comes back to confirm. It also carries the
RLS policies on `Users` — without an INSERT policy the client-side fallback
is simply refused — a unique index on `lower(username)`, and a backfill for
the accounts already stranded. **Run it.**

#### Coming back through the confirmation email

The other half of the same round trip, in the CONFIRMING AN EMAIL ADDRESS
block of `auth.js`. Confirmation takes the person out of the app entirely —
through a mail client, very often onto a different device — so like accepting
an invite it is built with a floor under it rather than one happy path.

**Three of the four things that decide whether the link works are in the
Supabase dashboard, not in this repo**, and every one of them fails
identically from the outside: *"I clicked the link and it opened a broken
page"*.

| Setting | What goes wrong |
| --- | --- |
| **Auth → URL Configuration → Site URL** | Left at the Supabase default it is `http://localhost:3000`, so every recipient lands on a dead page. This is where the link goes. |
| **Auth → URL Configuration → Redirect URLs** | `emailRedirectTo` does **not** override Site URL on its own. Supabase silently ignores a redirect that is not allow-listed and falls back — which is exactly how the setting above hides. The app's real origin has to be listed before `confirmRedirectUrl()` has any effect at all. |
| **Auth → Emails → Confirm signup** | Should be `{{ .SiteURL }}/index.html?token_hash={{ .TokenHash }}&type=email`. |

**That template is what makes the link work on a device other than the one
that signed up**, which is the common case — people sign up on a laptop and
read their mail on a phone. `config.js` sets `flowType:'pkce'`, so the default
`{{ .ConfirmationURL }}` comes back as `?code=…`, and redeeming that code
needs the verifier `signUp()` wrote to **localStorage in the original
browser**. Anywhere else the exchange fails with *"both auth code and code
verifier should be non-empty"* and the recipient lands on the sign-in screen
having apparently done nothing. `verifyOtp()` carries no such requirement.
The `?code=` branch is still handled, for links already sitting in inboxes.

`detectSessionInUrl` is **off**, and it is the one auth option in `config.js`
that is not the default. supabase-js reads the URL inside `createClient()` —
before any of the app's own code has run — so the landing would be consumed by
a background promise nothing can await, racing the boot sequence and reporting
its failures only to the console. `consumeEmailConfirmation()` does it
explicitly instead, in a known order and with somewhere to show the answer.

Things to keep:

- **`readEmailConfirmation()` runs FIRST of the three boot readers**
  (`main.js`). It removes only its own keys and puts the rest of the query
  string back; `readSharedInput()` and `readPendingJoin()` blank the search
  string wholesale once they have taken what they came for. Reading it last
  looked equivalent and was not — an invite link followed to a sign-up puts
  `?join=` and the confirmation keys on one URL, and the join reader took the
  confirmation down with it, silently.
- **The confirmation is tried before the stored session** (`main.js`). Both
  orders matter: someone confirming on a second device has no stored session
  to find, and someone confirming on the first has a stale one — same account,
  issued before the address was verified.
- **Every failure ends in the same offer**, because every one is fixed the
  same way: send another link. `confirmFailureHTML()` names *which* failure
  (expired, already used, wrong device) and then draws one button. An expired
  link with no way to get another is the same dead end the link itself was.
- **A sign-up that has to be confirmed swaps the form out for
  `#authCheck`** — `setAuthView()`. Leaving a filled-in Create Account button
  on screen only earns "user already registered" when it is pressed again.
  `applyAuthMode()` was split out of `toggleAuthMode()` so coming back can
  *restore* a mode rather than invert the flag underneath it.
- **An already-registered email is caught.** Supabase deliberately returns a
  user and no session for one, so `signUp()` cannot be used to test whether
  someone has an account here; the only tell is an empty `identities` array.
  Without that check the person waits for an email that was never sent.
- **The resend cooldown is not politeness.** Supabase rate-limits per address,
  and a second press inside the window returns an error that reads as though
  the resend itself failed.

#### Sorting a collection

`ACT_SORTS` and `sortActivities()` in `utils.js`, the control in
`sortButtonHTML()` (`detail.js`), the menu in `openSortMenu()`/`setSort()`
(`activities.js`). Three orders: **Date added** (the default, newest first),
**Target date** and **Date completed**.

**The control is a compact button beside the filter, not a fourth segment.**
The segments answer "which subset"; sort answers "in what order", and four
segments across a 320px phone leaves each one too narrow to read. It carries
the current order as a label so the screen says how it is sorted without being
opened, goes tinted on anything but the default, and below 375px drops to the
glyph alone — the same trade `responsive.css` already makes for the collection
name on an Up Next row.

Two rules every comparator shares, and both are load-bearing:

- **A finished activity sorts to the end of an unfinished order and vice
  versa.** Ordering by target date puts what to do next in front of you, and
  something already done has no next; ordering by completion date, a row with
  no completion has nothing to be ordered by at all.
- **Every comparator ends in a total order**, falling through to `createdAt`.
  Without that the many rows sharing a preset band — every "This Year"
  resolves to the same 31 December — come out in array order and visibly
  shuffle between renders of the same list.

`sortActivities()` sorts a **copy**: its input comes straight out of the
shared activity cache, and sorting in place would reorder it for every other
screen reading it.

`curSort` persists for the session rather than resetting on entry, matching
`curFilter` and unlike `curView`. Filter and sort sit on the same control row,
and having one of the two forget itself between visits reads as a bug.
`setSort()` redraws only the button and the list, never the whole control
block, for the same reason `renderDetail()` and `renderActivitiesList()` are
separate — rebuilding the search field would drop focus.

#### Target dates

Opening a collection always resets `curView` to `list`. It is keyed on
*entering* the detail screen rather than on the collection id, so re-opening
the one you just left resets too — the view mode is a per-visit choice, not a
saved preference.

`Activities.target_date` is a **text** column holding one of two kinds of
value, and code that reads it must handle both:

- a **preset band** — `This Month`, `This Year`, `Next Year`, `In 2-3 Years`,
  `In 5+ Years`;
- an **ISO date** the user picked — `2026-12-25`.

Because the column is text, adding real dates needed no schema change.
`isCustomDate()` tells them apart and `presetTargetDate()` resolves a band to
the end of its window, so `dateInfo()` and `daysToTarget()` can treat both
uniformly. In the sheet the two are one control: a `__custom__` sentinel option
reveals the date field, and `readTargetDate()` collapses select + field back
into the single value that gets stored. The sentinel is never written.

A specific date counts down while it is close and then shows the date itself —
once something is months out, "Dec 25" is more use than "184 days left".

**Bands that name a range or an open end never count down.** `OPEN_BANDS` in
`utils.js` holds `In 2-3 Years` and `In 5+ Years`, and `dateInfo()` returns
their label as-is. Counting down to one states something the user never said:
`In 5+ Years` has no cutoff at all — it resolves to +5 years only so it can be
sorted and bucketed — so rendering it as "5 years left" invents a deadline.
The labels are the same strings `targetBand()` uses for its group headers, so
a row reads identically to the section it sits under. This Month / This Year /
Next Year do close on a real date and keep their countdowns.

**`targetBand()` buckets by the resolved date, not by the band that was
chosen.** That is what lets the two kinds of value interleave correctly on the
Up Next screen: an activity dated 5 September and one set to "This year" both
land under *This year*, and because the band resolves to 31 December the dated
one sorts above it. Grouping and ordering therefore agree by construction —
there is no separate list of rules to keep in step.

"Someday" (`Before I Die`) and "No date" (`''`) were retired from the picker:
both were reachable, one was the default, and anything holding them never
surfaced in Up Next.

They are retired from the *picker*, not from the data. `dateInfo()` still
renders both, because existing rows carry them. And `openEditAct()` calls
`addLegacyDateOption()` to put the retired value back as an option **for that
one activity** if it has one — otherwise opening an old activity and pressing
Save would silently rewrite its target date. Keep that behaviour if you touch
the date field.

#### Showing priority

`priClass(a)` and `priTagHTML(a)` in `utils.js` are the single source of this,
and every list of activities uses them. **All three levels get the same
treatment — a rail down the row's leading edge and a capsule in the meta line
— and differ only in hue:**

| Priority | Token | Colour |
| --- | --- | --- |
| High | `--tint` | terracotta |
| Medium | `--violet` | saturated purple |
| Low | `--slate` | blue-teal |

**They are separated on chroma as well as hue, and that is deliberate.**
Medium and low were `#8a72b5` and `#4d5a6b` — a muted violet and a muted
slate. Both mid-toned, both cool, both low-chroma, so at 10px inside a
soft tint they read as the same colour twice, which defeats the point of
a three-step scale. Pulling them apart on hue alone was not enough. If
you retune these, check them as capsules at actual size, side by side,
not as swatches.

They are three steps of one scale, so they have to look like it. An earlier
version marked only high, left medium bare and made low recede; that read as
three unrelated things rather than a ranking, and was reverted. **If you touch
this, keep the shape identical across the three and vary only the colour.**

Completed activities show no priority at all — it is about what to do next,
and a finished thing has no next.

**In the activity sheet the chooser shows all three colours, not just the
one selected** (`.seg-pri`, `setPriorityChoice()`). It was a native
`<select>`, which can only show the level already picked and cannot show
its colour at all — the one thing you read the priority by everywhere
else. Each option now carries its swatch, and the swatches stay at full
strength whether or not that option is selected; dimming the unselected
ones would hide the two colours the control exists to show. The value
lives in a hidden `#aPri` input so `saveActivity()` still just reads
`$('aPri').value`, which means **anything setting priority must go
through `setPriorityChoice()`** or the buttons and the value drift
apart.

**The rail is `.pri-high/.pri-medium/.pri-low::before`** in `components.css`,
absolutely positioned so it is not a flex item on the rows and cards it lands
on, and clipped to the card radius by the `overflow: hidden` already on
`.act-group` / `.act-card`. Grid cards take the rail but not the capsule:
their body is a fixed skeleton so every tile in a row lines up, and there is
no width beside the deadline badge for a second capsule.

**Any row that can show a capsule must reserve its height.** The capsule is
19px and the mono text beside it is not, so `.act-meta` and `.up-meta` both
carry `min-height: 19px`. Without it a row without a capsule is ~6px shorter
than one with, and the list visibly steps as you read down it — the same
defect the `flex-wrap: nowrap` rules on those lines exist to prevent.

On the map the pin takes the priority colour (`PRI_VAR` in `map.js` maps to
the same three tokens), a high-priority pin is drawn larger as well, and
`symbol-sort-key` keeps it above the pins it overlaps. Completed pins stay
olive — done outranks priority. The Lists tab shows an outstanding
high-priority count per collection (`.coll-card-pri`) so the tab says which
list wants attention before you open any of them.

#### One activity, several lists

`supabase/multilist.sql` plus `activityListIds`/`splitListIds` in `api.js`. An
activity can belong to **any number of collections** — a personal list and a
shared one at the same time — and it is still **one row**, so completing it,
adding photos to it or renaming it happens once and shows up everywhere.

**It is an array column, not a junction table**, and the SQL file's header is
where that argument lives in full. The short version: two queries back this
entire app and both are cached in memory and mirrored to IndexedDB, so a
junction table would be a third query, a third snapshot store, new offline
replay logic and a new SECURITY DEFINER helper — where a column is carried by
the cache, the snapshot and the write queue for free. Both allow an unbounded
number of lists.

**`collection_id` is unchanged and still the home list.** The extras live in
`extra_collection_ids`, and `activityListIds()` is the one place the two are
assembled, exposed as `a.listIds` with the home list always first.
`a.listId` still means the home list. Four rules follow from that:

1. **Anywhere the app has room for exactly one list, it names the home one.**
   `activityListLabel(a, lists)` is that decision, shared by Home's Up Next,
   the Up Next screen, search results, the reminder rows and the duplicate
   sheet, and it counts only the lists this user can actually *see* — an
   activity shared into one of yours is homed in someone else's.
2. **Membership is `listIds.includes(id)`, never `listId === id`.**
   `fetchActivitiesFor()`, the Lists tab's per-collection counts, and search's
   collection-name field all match on the set. Getting this wrong shows an
   activity in the list it was created in and nowhere else, which looks like
   the feature silently not working.
3. **It degrades like everything else optional.** `probeMultiList()` checks
   for the column once at sign-in; without it the picker stays single-select
   and `listFieldsFor()` leaves the array off the payload entirely — sending
   a column the table does not have fails the whole insert. Like
   `probeSharing()`, it **races the first render** and drops the activities
   cache when it flips true, or an activity shared into one of your lists
   stays invisible until a reload.
4. **An activity must always be in at least one list.** One in none is in the
   database, on the map, and reachable from nowhere. The picker refuses to
   uncheck the last row and `removeActivityFromList()` refuses to empty the
   set.

**Getting rid of something now means two different things, and only one of
them is destructive.** *Remove from this list* is an update, is grey, and is
not confirmed — nothing is lost and it is undone by ticking the list again.
*Delete* destroys the row in every list at once, so on a multi-list activity
it says **Delete Everywhere** and the confirmation names the count. The RLS
delete policy is deliberately **not** widened to the extra lists: being able
to put an activity on a list you share does not make its photos and its
completion record yours to destroy.

Deleting a whole collection follows the same logic — `delList()` unlinks the
activities that live elsewhere too and deletes only the ones with nowhere to
go. That costs a round trip per activity, so the old single bulk delete is
kept verbatim for anyone who has not run the migration, where no activity can
have a second list.

Two things it does **not** do: `recountCollection()` still counts on
`collection_id` alone, so the two denormalised columns undercount a
multi-list activity — nothing reads them (see **Back end**). And the bulk-add
sheet files everything into one list, which is the right default for it.

#### The list picker

`openListPicker({subtitle, currentId, currentIds, multi, title, onPick})` in
`modals.js` is the one way to assign an activity to a collection, used by both
the Home composer and the activity sheet's Lists row. Both previously called
`showActionSheet()`, which lays out a 57px full-width button per list — fine at
three, an unusable tower at twenty. The picker is a normal sheet with a compact
scrollable list, a cover thumbnail per row, and a search field that appears only
past seven lists. **Don't route this back through an action sheet.**

**Two modes.** Single-select: a tap picks and closes, and `onPick` gets an id.
Multi-select (`multi:true`, used by the activity sheet once the migration is
run): rows toggle, the bar grows a **Done** button, and `onPick` gets an
**ordered array** — the first entry is the home list, so re-checking a row
appends it and unchecking the first promotes the second. The current home
carries a `HOME` badge once there is more than one, since that is the list
every other screen will name.

`.lp-sub` is a single ellipsised line, so a subtitle passed here has to be
short — "An activity can be in as many lists as you like. The first is its
home." was truncated to "The fi…" at 390px.

The activity sheet's Lists row reads **"3 lists"** rather than "Japan +2".
It is half of a `.fg-pair`, so at 320px it has room for about ten characters,
and the `+2` — the only part saying something new — was exactly what got
ellipsised away.

#### Gestures

Two, in `js/gestures.js`, both delegated from `document` so nothing that
opens a sheet or renders a row has to opt in.

**Swipe a sheet down to dismiss it.** The grab handle has always looked
draggable; now it is, and so is the rest of the sheet. The rule that
makes this coexist with a scrolling sheet body is that **the drag only
starts when the body is already at the top** — halfway down a long sheet
a downward swipe is a scroll, and stealing it would make the sheet
unreadable. Dismissal needs 110px, *or* 48px at speed: velocity alone
would let a 20px twitch throw the sheet away, because a short fast
movement scores as high as a long one.

**Swipe sideways to change screen.** iOS pops a pushed screen with a
swipe that must start at the very left edge, which is a hard target on a
big phone — here it works from anywhere. Pushed screens go back; root
tabs move to their neighbour in `TAB_ORDER`.

**The map is the exception, and has to be.** The globe is dragged
horizontally to spin it, so a full-screen swipe there would fight the
map on every pan. On a map surface only, the gesture must start within
`SWIPE_EDGE` (34px) of a screen edge — still the iOS gesture, just
narrower — leaving the middle to the globe. Without that escape hatch
the Map tab would be the one screen you cannot swipe out of. The same
applies to the per-collection map inside the detail screen.

Everything else that owns a gesture is listed in `ownsHorizontal()` /
`ownsVertical()`: fields, `.seg` controls, the location dropdown. An
open overlay takes the gesture entirely — the page underneath must not
also react to it.

**Room for a date picker.** A native date picker opens anchored to its
field and the browser will happily run it off the bottom of the window.
Every date field here lives in a bottom-anchored sheet, which is the
worst case: the reminder sheet is short, so its field sits low and the
calendar had nowhere to go. The picker's own placement cannot be set
from script, so `ensurePickerRoom()` in `modals.js` controls the only
thing that can be — the room beneath the field. On focus, if there is
less than `PICKER_ROOM` (310px) below it, the sheet gets that much extra
scrollable space (a `::after` spacer, so releasing it needs no knowledge
of the sheet's real padding) and is scrolled to match. **The size is
clamped**, because a sheet is tappable before it has finished sliding
in: a field focused mid-animation measures from wherever the sheet had
got to and would otherwise ask for a screen-sized spacer.

#### Reminders

`js/reminders.js`. A reminder is a date to be nudged *about* an activity,
separate from the activity's own target — the case it exists for is a campsite
whose reservations open months before the trip.

**There are three delivery paths, in order of reliability. Understand why
before changing any of them.** A web app cannot wake itself up — Notification
Triggers never shipped past an experiment — so nothing in the browser can
schedule a banner for a future date.

1. **The Home banner.** Needs no permission, no backend, no install. The floor.
2. **A local notification** when the app is opened or foregrounded on or after
   the date. Needs permission only.
3. **Real background push**, delivered on the day with the app closed. Needs
   the backend in `supabase/` deployed, `VAPID_PUBLIC_KEY` set in `config.js`,
   permission granted, and on iOS the PWA installed to the home screen.

All three coexist because each fails differently. Building on (3) alone would
mean a reminder that silently never arrives for anyone missing one of its four
prerequisites — and the failure would look like the feature not existing.

The backend lives in **`supabase/`**: `schema.sql` (columns, the
`push_subscriptions` table with RLS, the `reminder_deliveries` table, and a
trigger that re-arms a reminder when its date moves),
`functions/send-reminders/` (the daily sweep, which groups by recipient so
five due reminders are one notification, and prunes endpoints that
return 404/410), and `cron.sql`. `supabase/README.md` has the deploy steps.
The function requires an `x-cron-secret` header — without it, anyone could
trigger a send to every user's devices.

**A reminder on a shared list goes to everyone on it.** The sweep used to
select `Collections!inner(user_id)` and notify that one person, which on a
shared list is both wrong and quiet: three people share a list, one sets a
reminder to book the campsite, and it fires at whoever happens to *own* the
list — possibly not even the person who set it. The audience is now the
owner plus every `collection_members` row.

That forced the delivery marker apart from the activity.
`Activities.reminder_sent_at` is one column for what is now several
recipients, so the first successful send silently consumed the notification
for the whole list. **`reminder_deliveries` is keyed on
`(activity_id, user_id, remind_at)`** instead. Two consequences worth
keeping: the date being part of the key means moving a reminder re-arms it
for everybody with no trigger needed, and a user with **no** registered
device is deliberately *not* recorded as delivered, so they still get the
reminder on the day they turn notifications on. `reminder_sent_at` is still
written, but only so anything reading it directly sees what it expects —
nothing consults it.

The function tolerates `collection_members` not existing (sharing is
optional; the audience is then just the owner) but **refuses to run without
`reminder_deliveries`**, because with no way to tell who has already been
told it would re-notify everyone every day.

There is still **one `remind_at` per activity, not one per person** — a
reminder on a shared list is the list's reminder. That is the right default
("book the campsite" is not a private thought when three people are going)
but it is surprising to discover afterwards, so `updateRemindAudience()`
says so in the sheet, on shared lists only. It deliberately does not
promise a *push*: whether each person gets one depends on their permission
and install state, which this client cannot see.

**A reminder can count back from the target date** — "1 month before"
is how people actually think about a permit window. `REMIND_OFFSETS` in
`reminders.js` holds the choices, and only the *resolved* date is stored
in `remind_at`, so the schema is unchanged and the three delivery paths
need no idea the feature exists. Reopening the sheet infers which offset
was used by matching the stored date back against the target, so a
relative choice still reads as relative without a column to hold it.

**They are offered only when the activity has a specific target date,
and that restriction is the whole design.** A preset band resolves to
the end of its window — "This year" is 31 December. Counting back a week
from that would file a reminder on Christmas Eve for *every* activity
set to "This year", all firing on the same day, none on a date the user
picked or would connect to the thing. The menu is rebuilt on each open,
since the target may have just changed, and when it cannot offer them
the sheet says why rather than leaving them mysteriously absent.

**Location is a top-level field**, in both the activity sheet (under
Priority) and the edit sheet (under the date). It decides whether an activity
ever appears on the map, so hiding it behind "More options" meant most
activities silently never did — and that argument eventually took the whole
disclosure with it. The activity sheet has none: see **The activity sheet's
shape**. The completion sheet still keeps one, holding photos and "How it
went".

**Setting one is a row, not a field.** The activity sheet carries a
`Remind me` row directly under Priority, reading `None` or `Scheduled`,
which opens `remindSheet` (`openRemindSheet`/`saveRemindSheet`/
`clearRemindSheet` in `reminders.js`). It was a date input plus a
textarea at the bottom of the sheet's old "More options" disclosure: two
controls for one optional idea, which made the disclosure look like the
sheet's main event, and neither said whether a reminder was actually set
without reading the date off it.

The sheet only **stages** — Done copies its two fields into the hidden
`#aRemind`/`#aRemindNote` inputs, and nothing reaches the database until
the activity itself is saved. That is what lets Cancel on either sheet
leave everything as it was, and it is why `updateRemindRow()` reads the
label back off those hidden inputs rather than keeping state of its own.
`remindSheet` needs `z-index: 210` because it opens on top of another
`.modal-overlay`, and equal z-index would fall back to document order.

Already-announced reminders are remembered in `localStorage` keyed by
`activityId@date`, so re-opening the app does not re-ping but moving a reminder
re-arms it.

#### Sharing a link in

`js/share.js`, plus `supabase/functions/unfurl`. Sharing a TikTok, X post
or web page into the app should produce a filled-in activity — name,
location, description, and the URL in `links` — not a bare URL.

**iOS cannot register a PWA as a share target.** The Web Share Target API
is Chrome/Android-only; the WebKit bug has been open since 2019. That is
the single fact shaping this feature, and it is why capture has four
tiers rather than one, in the same order-of-reliability shape as the
three reminder delivery paths:

1. **Paste a link into the Home composer.** No permissions, no backend,
   no install. The floor.
2. **Screenshot anything** — the camera button in the Home composer. See
   below; this is the general path and the one that finally makes
   Instagram work.
3. **An iOS Shortcut** that opens `?share=<url>`. The user builds it once
   and Bucket List is then in the real share sheet. The **You** tab has a
   setup screen (`openShareSetup`) because there is no API to do this —
   all the app can do is explain it and hand over the URL.
4. **`share_target` in the manifest**, which gets Android and desktop
   Chrome for free.

All three land on a query param. `readSharedInput()` runs at boot **before
`restoreSession()`** — a link can be shared in while signed out, and the
sign-in screen must not eat it — stashes it in the `pendingShare` global,
and **strips the query string immediately** so a reload cannot import the
same link twice. `showApp()` then calls `handleSharedInput()`.

**Nothing is written without review.** The import sheet hands off to the
ordinary activity sheet (one result) or the bulk sheet (several), both of
which still require a Save. Extraction is sometimes wrong, and silently
creating junk is worse than the feature not existing. Several results get
a checklist, because a listicle always carries one or two you don't want.

**A screenshot that reads as one activity skips the review card
entirely** and goes straight to the activity sheet (`runUnfurl`). That
card was showing the user their own screenshot back with a single result
under it and an Add button — a confirmation of something they had not
asked about yet, in front of a sheet that is itself the review step and
still needs a Save. It is the *card* that is skipped, not the review.
Several results still get the checklist, because there is a real choice
to make between them, and the loading state still shows — reading takes
a few seconds and the sheet is what says so. Link imports keep the card
at one result too: a link's row is built from metadata the user never
saw, so the card is the first sight of it.

**The composer changes what it does rather than Home growing a button.**
`onHomeComposerInput()` swaps the go glyph to a link when what you typed
is a URL. Home already has one add affordance; two is one too many.

**Extraction has to be server-side** — CORS blocks every one of these
pages from the browser. What each source gives back, verified by direct
request:

| Source | Path | Note |
| --- | --- | --- |
| TikTok | public oEmbed | Caption arrives as the title |
| X / Twitter | `publish.twitter.com/oembed` | 301 — redirects must be followed |
| YouTube | public oEmbed | |
| General web | OpenGraph tags | Some sites 403 datacenter IPs |
| **Instagram** | none | Login wall, zero OG tags unauthenticated |

**Instagram has no readable link, and the answer is a screenshot.** There
is no unauthenticated path — a login wall with zero OG tags — and
official access needs a Meta app with `oembed_read` App Review. The
alternatives were a paid scraper that violates their terms and breaks
periodically, or a native iOS Share Extension a PWA cannot register. A
screenshot sidesteps all of it: the user already has the post on screen
and the phone already has a screenshot button. `degraded:"instagram"`
now leads with "read a screenshot instead", with pasting the caption
still there behind it.

**The screenshot path is general, and that is its point.** The link path
knows five platforms; the screenshot path knows none, so it handles a
Reel, a Safari page, a Maps pin, a friend's message, or printed text
photographed off a page. Same `unfurl` function, same response shape —
send `{image, mediaType}` instead of `{url}` and it goes through Claude's
vision with its own system prompt. That prompt names the sources it will
be handed on purpose: without it the model describes the screenshot ("A
photo of a waterfall posted by @user") instead of extracting the plan
inside it ("Swim at Havasu Falls"), and it has to be told to ignore
interface chrome — like counts, comment threads, status bars.

The image is downscaled to **1568px** on the long edge client-side, the
size above which the model gains nothing; a raw phone screenshot is
several seconds of upload on cellular for no better result. Unlike the
link path there is **no fallback without `ANTHROPIC_API_KEY`** — nothing
else can read an image — so it reports `no_model` and the sheet offers
"add by hand" rather than showing an empty result.

**Both prompts are written to produce the user's own plan, generalised —
not a report on the source, and not a transcript of it.** Two rules,
and the second is the one that keeps getting lost:

1. *Their voice, not the source's.* Never "The video shows a group of
   friends paragliding off a hill in Turkey". Never open with "The
   video…", "This post…", "A photo of…", or a handle.
2. **Capture the idea, not the instance.** A post is one person's
   particular afternoon; the activity is the general thing the user
   wants to do. Prices, brands, marketplaces, named friends, specific
   technique, gear and conditions all get dropped.

The worked example both prompts carry:

```
SOURCE  "POV: You & the boys bought a $600 paraglider off Facebook Marketplace"
GOOD    "Buy and learn to fly a used paraglider"
BAD     "Buy a $600 secondhand paraglider on Facebook Marketplace"
BAD     …+ "~$600 secondhand wing · practice ground-handling on open
        rolling hills · calm evening/sunset air"
```

That last line is a real output from an earlier version of the prompt,
and it is worth understanding why: the prompt had *asked* for "price,
best season, gear needed", so the model dutifully supplied them and
invented the rest. **`description` now defaults to `""`** and is
reserved for a hard constraint stated in the source that could not be
looked up later — a permit window, a booking lead time, a short season.
Never a tip. The instruction "if you are unsure whether a detail
belongs, it does not" is doing real work; don't soften it.

`IMAGE_SYSTEM`, `SYSTEM` and the `SCHEMA` field descriptions all say
this, so a screenshot and a link cannot produce differently-voiced rows,
and so the schema does not quietly contradict the system prompt.

**The camera lives in the Home composer**, replacing the old decorative
plus rather than joining it. Home already has one add affordance; the
placeholder and the go arrow both say "add", so a third would be one too
many. Anything imported is also checked against the library —
`dupeHintFor()` marks a result that looks like something you already
have, because a shared listicle is where duplicates arrive in bulk.

**The function must never be deployed with `--no-verify-jwt`.** It fetches
a caller-supplied URL from inside Supabase's network; the JWT check is the
only thing stopping it being an open fetch proxy. There is a second guard
in `safeUrl()`/`privateHost()` rejecting non-http(s) schemes and private,
loopback and link-local addresses — `169.254.169.254` is cloud metadata.
Both matter; neither is redundant.

One trap worth keeping: `ogTag()` matches the opening quote of `content=`
and back-references it. A character class excluding both quote styles
truncates at the first apostrophe inside a double-quoted value, so
`"World's largest salt flat"` came back as `"World"`.

The whole feature degrades like `probeStorage()` does: no function, or a
failing one, still opens the sheet with the URL attached and the name left
to type.

#### The floating action button

The primary "add" action is a fixed `.fab` in the shell, not a bar button. The
top-right corner is the hardest place on a phone to reach, and a bar button
also has to share space with Back and the overflow menu. `updateNavbar()` binds
it per screen via `setFab(fn, label)` and hides it where it makes no sense (Map
and You). Because it is `position: fixed` it never reflows anything; `.page`
simply reserves bottom padding so the last row can scroll clear of it.

### Design language

The app has **iOS bones and its own voice**. The structure is UIKit — tab bar,
collapsing large titles, sheets, action sheets — but the surface is not the
system default. That combination is the whole point: a stock-iOS skin read as
generic, and a purely editorial one read as a website.

Three typefaces, each with exactly one job:

| Token | Face | Used for |
| --- | --- | --- |
| `--serif` | Newsreader | Display: screen titles, collection and activity names, stat numerals, sheet titles, and long-form completion notes (`.ad-note.prose`). Chosen for its large x-height and even stroke weight — a display Garamond was here first and turned to spidery grey below ~24px, which is most of the app. **If you swap the face, rebalance the sizes**: they are tuned to Newsreader's x-height, not to a nominal point size. |
| `--sans` | System stack (SF Pro) | All UI: controls, fields, body copy, anything that should feel like the OS. |
| `--mono` | IBM Plex Mono | The signature small-caps labels: eyebrows, section headers, badges, tags, buttons, tab labels, counts. Always uppercase with wide tracking. |

The serif is what makes a list of activities read as a curated collection
rather than a to-do list, and the mono eyebrow above each large title is what
stops a big heading looking bare. **Don't set UI chrome in the serif, and
don't set content in the mono** — the contrast between the three is the design.

Other rules:

- **Warm parchment grounds, never neutral grey.** Dark mode is a warm
  near-black (`#16140f`), not `#000` — pure black makes the olive and
  terracotta look muddy.
- **`--tint` (terracotta) means "tappable"**; `--green` (olive) means
  completed; `--red` is destructive only. The token is named for its role, so
  the component CSS reads correctly whatever hue it holds.
- **Priority has its own three-colour scale, and red is not on it.**
  `--tint` (high), `--violet` (medium) and `--slate` (low). Medium has its own
  token rather than reusing `--purple`, which the You tab uses at icon size and
  wants darker. Red, orange and yellow belong to the deadline badge sitting
  right beside it — an overdue activity and an important one are different
  claims on your attention, and sharing a colour made them argue. The two
  lower steps are cool in a warm palette, which is deliberate: they have to
  read as the bottom of a scale whose top is terracotta, and warm greys just
  looked disabled. See **Showing priority** below.
- **Nothing outside `:root` in `base.css` should contain a raw hex value.**
  Re-theming the entire app is meant to be one file. The `--shadow-*` tokens
  are warm-tinted for the same reason: neutral black shadows grey the
  parchment.
- Cover photos are filtered (`brightness(.82) saturate(.92)`) and carry a warm
  gradient wash, so a set of unrelated stock images still reads as one palette.
- Standard iOS control sizes are kept even where they fall under the 44px
  guideline: segmented controls are 32px and search fields 38px, as in Apple's
  own apps. Primary targets are still 44px+.
- **The icons are the app's own, not SF Symbols lookalikes.** `icons.js` draws
  them at a heavier 2px stroke with a recurring solid-dot accent, and the four
  tab glyphs use metaphors from the app's subject — a sun over a horizon, a
  stack of cards, a compass rose, a flagged summit. Add new glyphs there rather
  than inlining SVG in a template string.
- **Icon bar-buttons are round tinted discs** (`.navbtn.disc`), matching the
  floating buttons on the map, so every control in the app reads as one family.
  Text bar-buttons (Cancel/Save) stay plain.

**On the web fonts.** Two faces are loaded from Google Fonts. This is a
deliberate reversal of an earlier build that used the system stack only: that
version had nothing to look at. `display=swap` plus a `ui-serif` fallback
(New York on Apple platforms) means text paints immediately in a serif and is
swapped in place, so the cost is a small reflow, not blank text. The service
worker caches both faces, so it is a first-visit cost only.

### CSS file map

Loaded in this order; **order matters**.

| File | Domain |
| --- | --- |
| `base.css` | The design system: `color-scheme`, the three type tokens (`--serif`/`--sans`/`--mono`), the warm palette with a full `prefers-color-scheme: dark` variant, the `--shadow-*` depth scale, the priority scale (`--tint`/`--violet`/`--slate` and their `-soft` fills), layout metrics (`--gutter`, `--nav-h`, `--tab-h`), the iOS safe-area tokens (`--safe-*`, plus the `--gx-l`/`--gx-r` gutter+inset shorthands every screen uses for horizontal padding), the type scale (`.t-*`, including `.t-eyebrow` for the mono small-caps label), the reset, and the shared keyframes. Everything depends on it. |
| `layout.css` | The app shell: the translucent `.navbar` and its `.condensed` state, `.large-title`, the `.tabbar`, and the `.page` show/hide system with its push/fade animations. |
| `components.css` | The reusable iOS primitives every screen builds from: `.group`/`.row` inset grouped lists, `.seg` segmented controls, `.btn` styles, `.searchfield`, `.badge`/`.tag`, **`.list-chip`** (a collection's name on any row that could have come from any list — Home's Up Next, the Up Next screen, search results, the duplicate sheet; sized to match `.tag` so the capsules on one row line up), the `.pri-*` priority marks, `.seg-pri`/`.pri-swatch` (the priority chooser), `.media-tile`/`.media-play` (one tile for a photo or a video, used by three screens), `.empty`, `.progress`, `.spinner`. Look here before inventing a new component. |
| `auth.css` | The signed-out screen — no nav bar, no tab bar, its own centring. Plus `.auth-invite`, the tinted note shown when an invite link was opened while signed out; `.auth-notice`, the same shape for a confirmation link that could not be honoured, but carrying its own way out (a resend button) because "that link expired" with no way to get another is the same dead end the link was; and `.auth-check`, the quieter waiting-for-confirmation panel — nothing has gone wrong there, and the title above is already carrying the message. |
| `home.css` | The dashboard: the greeting, the SVG progress ring, the context-free quick-add composer, the Up Next list, and the two `.shelf` grids (recently accomplished, your lists). |
| `collections.css` | The Lists tab: `.coll-card` photo cards and the "New List" tile. |
| `detail.css` | A collection's screen: `.det-banner`, `.det-ctl-row`/`.det-sort` (the filter and sort controls sharing a line — the row owns the gutters so `.seg` can give up its own margins), `.act-row` list rows, `.composer` quick-add, `.act-card` grid cards, and the `.ad-*` activity detail sheet including `.ad-lists`/`.ad-list-chip`. |
| `me.css` | The Me tab: the stats card, the progress card, the identity row. |
| `modals.css` | The three presentation styles — `.modal`/`.sheet-*` bottom sheets, `.action-sheet`, `.lightbox` — plus the form controls that live inside a sheet: `.fg` and its `.fg-hero` (the field a sheet is *about* — only the activity name) and `.fg-pair` (two short choices on one line), `.picker-btn` (a value that opens a picker, sized to match a `<select>` beside it), `.chip-field`, `.photo-*`, the list picker's `.lp-*` (including `.lp-home`, the badge naming which of several chosen lists is the home one), and `.toast`. There are no disclosure styles here any more — `.more-toggle`/`.more-fields` went with the completion sheet's last collapsed section. |
| `map.css` | Map containers (the full-bleed `.page-map` and the inset detail map), the CSS sky gradient behind the globe, the floating `.map-filter`/`.map-count`/`.map-fab` chrome, `.map-pin`/`.map-cluster` markers, MapLibre's own controls restyled, the `.loc-*` autocomplete dropdown, `.loc-suggest-*` — the "from your photo" chip, deliberately a tinted *offer* rather than a filled control, since it must not read as though the field is already answered — and `.loc-guess-*`, which is the opposite case and therefore shaped differently: a quiet caption marking a field the app has already filled in from the activity's name, with an ✕ that takes it back out. |
| `bulk.css` | `.bulk-*` — the "add many at once" sheet, one card per row. |
| `import.css` | `.imp-*` — the sheet a shared link or screenshot opens into (its result checklist, the screenshot preview, the duplicate mark, the waiting and caption-fallback states) — plus `.shr-*`, the iOS Shortcut setup sheet, which `sharing.css` also borrows. |
| `search.css` | `.srch-*` — the pinned search field over the results, the section headings, and the `<mark>` wash. The rows themselves are `.act-row` from `detail.css`. |
| `dupes.css` | `.dupe-*` — the "you may already have this" sheet. Deliberately quiet: no red, no alert iconography, an ordinary tinted confirm. It interrupts the fastest path in the app, so it has to read as a question. |
| `sharing.css` | `.shr-people-*`/`.shr-avatar`/`.shr-role` and `.join-*` — the invite sheet's roster and the accept-an-invite card — plus `.shr-code-head`/`.shr-code` (the invite as something that can be read off one screen and typed into another) and `.join-code-input`. Reuses `.shr-lead`/`.shr-url`/`.shr-note` from `import.css` on purpose: both are "here is a link, here is what to do with it". |
| `pwa.css` | The offline banner, install bar, iOS Add-to-Home-Screen sheet. |
| `responsive.css` | Only the two directions away from phone-first: <375px, and ≥700px where the app centres in a column instead of stretching. **Must load last.** |


### JS file map (where to look for what)

**Foundation**

| File | Domain |
| --- | --- |
| `config.js` | `SUPABASE_URL`/`SUPABASE_KEY`, the `sb` client (auth options spelled out rather than defaulted — note `detectSessionInUrl:false`, the one that is *not* a default: `auth.js` handles the email-confirmation landing itself), the `COVERS` array of default Unsplash covers, and `randCover(existingCovers)` (picks a cover the user isn't already using). |
| `state.js` | Every shared mutable global: `currentUser`, the navigation triple (`curTab`, `curPage`, `backTab`), `curListId`, `editingListId`, `editingActId`, `completingId`, `curFilter`, **`curSort`** (see **Sorting a collection**), `curView`, `upMedia`, `coverPhoto`, `userProfile`, `pendingShare` (a link shared in, held from boot until there is a signed-in user to file it for), and the map handles. Other files declare their own feature-local globals next to their code (`aLinks`, `bulkEntries`, `actMap`, `lbPhotos`, `locTimer`). |
| `utils.js` | `$` (getElementById), `esc` (HTML-escape — **use it on every interpolated value**, all rendering is template strings), **`uuidv4`/`isUuid`** (client-minted row ids — read the warning under **Working offline** before touching them), `cap`, `todayISO`, `fmtDate(s, withYear)` (omits the year when it's the current one, unless `withYear` — a completed date is a record you look back on, so it always carries its year), `dateInfo(a)` (turns a target date like "This Year" into a `{label, cls}` urgency badge), `shakeEl`, `compress`, `confetti`, the priority pair `priClass`/`priTagHTML` (see **Showing priority**), **`ACT_SORTS`/`DEFAULT_ACT_SORT`/`sortActivities`** (see **Sorting a collection**), **`activityListLabel(a, lists)`** — what the `.list-chip` on a row says, now that an activity can be in several lists — and **`bootKeep`/`bootRead`/`bootDrop`**, the sessionStorage shelf that keeps `?join=`/`?share=` alive across a reload (see **Shared lists**; reading deliberately does not remove), plus **`bootKeepLong`/`bootReadLong`/`bootDropLong`** — the same shelf on localStorage with a 7-day TTL, so an invite survives the tab being closed while the recipient goes to find their password. |
| `exif.js` | `exifReadLocation(file)` — the GPS fix out of a photo's EXIF, or null. Handles **JPEG and HEIC/HEIF/AVIF**, dispatching on magic bytes rather than `file.type`. Underneath: the JPEG walk (`exifFindTiff`), the HEIC box walk (`isoBoxes`, `isoType`, `heicReadLocation`, `heicExifExtent`, `heicExifItemId`, `heicItemExtent`, `heicTiffStart`, `isTiffAt`), and the shared TIFF reader both land on (`exifGpsFrom`, `exifTagValue`, `exifDMS`). Pure, no dependencies, every failure path returns null rather than throwing. **Must be called against the original `File`**: a canvas re-encode strips every tag. See **Where the photo was taken**. |
| `fuzzy.js` | Approximate string matching, shared by duplicate detection and search. `similarity(a,b)` (symmetric — are these the same thing?) and `matchScore(q,text)` (asymmetric — does this row answer what is being typed?), plus `scoreFields()` and the primitives underneath: `fuzzyNorm`, `fuzzyTokens`, `fuzzyStem`, `fuzzyTokenSim`, `fuzzySoftDice`, `fuzzyTrigrams`, `fuzzyDice`, `fuzzyEditRatio`. Pure and synchronous. **See How the fuzzy matching works** — the constants are tuned, not derived. |
| `icons.js` | `ICON_PATHS`, the app's own inline-SVG glyph set (`sort` is the newest), plus `ICON_FILLED` (glyphs already solid, which must not be stroked) and `icon(name, cls)`. Icons inherit `currentColor`. **Add new glyphs here**, not inline in a template string. |
| `offline.js` | **Reading from disk, queueing writes, syncing on reconnect.** The IndexedDB wrapper (`idbOpen`/`idbGet`/`idbAll`/`idbPut`/`idbDelete`/`idbClear`), the row snapshot (`snapshotSave`/`snapshotLoad`/`snapshotAge`/`snapshotClear`), the write queue (`queueWrite`/`queueLoadCount`/`pendingWrites`/`flushQueue`), **`dbInsert`/`dbUpdate`/`dbDelete` — which every mutation site calls instead of `sb.from(...)`** — the per-user `uid` stamp on every queued op — plus `applyOp`, `stampRow`, `isNetworkError`, `updateSyncUI` (the offline banner's text), `offlineSignOut` and `offlineInit`. Loads before `api.js`. See **Working offline**. |
| `api.js` | **Every Supabase read, and the cache in front of them.** `mapCollection`/`mapActivity` translate snake_case columns into the camelCase shapes the UI uses; `normMedia`/`denormMedia` do the same for the two shapes the `photos` column holds; **`activityListIds`/`splitListIds`/`rowInAnyList`** assemble and take apart the home-list-plus-array pair (see **One activity, several lists**), and **`probeMultiList`/`multiListReady`** decide whether that column exists at all. Then `readRows` (network or disk — the one place that chooses), `fetchCollections`, `fetchActivitiesFor`, `fetchAllActivities`, `fetchActivity`, `fetchCollection`, and the cache: **`cacheOwnerCheck`** (the cache refuses to answer a user it was not filled for — see **One account at a time**), `invalidateCollections`/`invalidateActivities`/`invalidateAll`, **`primeActivities`/`primeCollections`** (patch it from a computed row set instead of dropping it — called by `applyOp`), **`primeFromSnapshot`** (paint before the network; called once, by `showApp`), `collectionsScope`, `cacheWarm`, `cachedActivities`/`cachedCollections` (synchronous reads, for the duplicate check), `revalidate`. Plus `updateCollectionStats`/`recountCollection`/`cancelPendingStats` — deliberately **off** the critical path, see the cache section. New queries belong here, not inline in a screen file. **Writes go through `offline.js`.** |

**Shell and shared UI**

| File | Domain |
| --- | --- |
| `auth.js` | **`resetAccountState()`** — everything belonging to one account, cleared on every auth transition (see **One account at a time**) — **`ensureSessionLive`/`verifyLiveUser`/`authAnswerIsDefinitive`/`signOutStaleSession`/`resetSessionLiveCheck`/`recheckSessionSoon`/`startSessionWatch`/`stopSessionWatch`**, which is how a session belonging to a deleted account stops being trusted, on every device (see **Being signed into an account that no longer exists**) — **`inviteSweepDue()`/`authJustAuthenticated`**, which decide when to ask the server whether an invite is waiting for this address (see **An invite that survives creating an account**) — plus `showAuth`/`showApp` (swap `#authPage` against `#appWrap`; `showApp` boots into Home, loads the profile, triggers the iOS install hint, picks up any link shared in via `handleSharedInput()`, and starts the token auto-refresh). Also the `visibilitychange` handler that stops/starts auto-refresh — browsers suspend timers in a backgrounded PWA, and without restarting on resume the access token goes stale and the next request 401s, which reads to the user as being logged out — and the `onAuthStateChange` listener that keeps `currentUser` in step and only shows the login screen on a real `SIGNED_OUT`, `toggleAuthMode`/`applyAuthMode` (tracked by the `authIsSignUp` flag, not by reading the heading text), `setAuthError`, `handleAuth`, `handleSignOut`. Sign-up also inserts the `Users` profile row. Plus **the confirmation-email landing** — `readEmailConfirmation` (boot; reads `token_hash`/`code`/implicit tokens/`error`, and strips only its own keys), `consumeEmailConfirmation`, `confirmFailureHTML`, `confirmRedirectUrl`, `setAuthNotice`, `setAuthView`/`showCheckEmail`/`authBackToForm`, and the resend pair `sendConfirmationEmail`/`resendConfirmation`/`resendFromNotice`. See **Coming back through the confirmation email**. |
| `nav.js` | `nav(page, listId)` — the single entry point for changing screens (see **Screens and navigation**). Plus `PAGE_TAB`, `TAB_ROOT`, `selectTab`, `goBack`, `dismissOverlays`, **`refreshAfterChange(src)`** (the single answer to "something was written, what redraws?" — see **Refreshing after a change**), `updateNavbar` (**where each screen's bar buttons are defined**), `applyNavCondense`, a debounced `resize` handler, **`setBodyScrollLock(lock)`** — the single place that touches body overflow — and **`syncTabbarToKeyboard()`**, which keeps the tab bar behind the software keyboard instead of riding up on top of it (see **Mobile layout rules**). |
| `gestures.js` | The two touch gestures, both delegated from `document`: **swipe a sheet down to dismiss it** (`.modal` and the action sheet) and **swipe sideways to change screen**. `overlayOpen`, `ownsHorizontal`/`ownsVertical` (surfaces with their own gesture), `SHEET_DISMISS_PX`/`SHEET_FLICK_PX`, `SWIPE_MIN`/`SWIPE_EDGE`, `TAB_ORDER` (in `nav.js`). See **Gestures** below. |
| `modals.js` | `openModal` (**resets `.sheet-body` scrollTop** — see the note under *Sheets* below) / `closeModal` (they call `setBodyScrollLock`, so use them rather than toggling `.open` yourself), the scrim-click and Escape handlers, **`showActionSheet(opts)`** and `showConfirm` (iOS confirms destructive actions with an action sheet, not a dialog — `confirmDeleteCollection`/`confirmDeleteActivity` wrap it), the photo lightbox (swipe sideways to page, down to close), the list picker (`openListPicker`/`renderListPickerRows`/`listPickerPick`/`listPickerDone` — single- *and* multi-select, see **The list picker**), `ensurePickerRoom`/`releasePickerRoom` (see **Gestures**), and `showToast`. |

**Reusable form widgets**

| File | Domain |
| --- | --- |
| `links.js` | The URL chip input: `aLinks`, `handleTagKey`, `removeTag`, `renderTagChips`. ⚠️ `getChipArr(which)` ignores its argument and always returns `aLinks` — vestigial from when there were two chip fields. Adding a second means fixing this first. |
| `location.js` | Everything that resolves a place. `locSearch(input, resultsId)` — debounced (350ms) place search against the public **OpenStreetMap Nominatim** API — plus `geocodeOnce(q)` (one-shot, no debounce, no DOM: resolves a place name we already have — an imported link's location — to `{display, lat, lng}` or null), `reverseGeocode(lat, lng)` (the other direction, for a photo's EXIF fix — `zoom=14`, so a place rather than a postal address), `positionLocBox` (the bulk sheet's dropdown is `position:fixed` so it can escape the sheet's scroll container, and therefore has to be placed by hand) and `locPick`. Plus the **guess from the activity's name**: `maybeGuessLocation`, `guessMatchesName`, `resetLocationGuess`, `onActLocInput`, `undoLocationGuess`, `clearLocationGuessMark` — see **Guessing the location from the name**. |
| `media.js` | Photos **and video**. `probeStorage()`/`storageReady()`, `uploadPhoto`/`uploadVideo` (→ the `media` Supabase Storage bucket), `videoPoster` (grabs a still so thumbnails and map pins have an image), `handleMedia`, `rmMedia`, `mediaTileHTML`, `renderThumbs`, and the ordering set — `coverIndex`, `moveMedia`, `makeCover`, `openMediaMenu`. Also the photo→location offer: `needsLocationSuggestion`, `suggestLocationFromPhoto`, `acceptPhotoLocation`, `dismissPhotoLocation`, `resetLocationSuggestion` (see **Where the photo was taken**). Working list is the `upMedia` global. Replaced `photos.js`; see **Media** below. |

**Screens and features**

| File | Domain |
| --- | --- |
| `dupes.js` | **Fuzzy duplicate detection.** `dupeGuard(opts, proceed)` — the single gate every add path goes through — plus `dupeGuardBatch()` (returns a promise for the subset to keep), `findDupes`, `dupeScore`, `dupeHintFor` (the mark in the import sheet), the sheet's handlers (`dupeAddAnyway`/`dupeSkipDuplicates`/`dupeOpenExisting`/`dupeCancel`/`dupeCancelBatch`), and the `DUPE_LIKELY`/`DUPE_POSSIBLE` thresholds. Loads before every screen that adds an activity. See **Catching duplicates**. |
| `sharing.js` | **Shared lists.** `probeSharing`/`sharingReady`/`resetSharingProbe`, `ownsCollection`/`isSharedWithMe` (which buttons to draw), the invite sheet (`openShareList`/`renderShareList`/`createInvite`/`revokeInvite`/`copyInviteLink`/`copyInviteCode`/`sendInviteLink`/`removeMember`), leaving (`confirmLeaveList`/`leaveList`), and accepting (`readPendingJoin` at boot, `handlePendingJoin`/`acceptJoin`/`declineJoin`, `updateAuthInviteNotice`/`authInviteWaitingNotice` for the signed-out case, and the link-free path `openJoinByCode`/`submitJoinCode`/`parseInviteCode`), plus **`claimInviteForEmail`/`claimInvitesForMe`** — the server-side copy of the code, which is the only one that survives a sign-up confirmed on another device — and `makeInviteCode`/`inviteUrl`. See **Shared lists**, **Accepting an invite** for why that link-free group exists, and **An invite that survives creating an account** for the last pair. |
| `search.js` | The Search screen pushed from Home: one fuzzy field over every activity and collection. `openSearch`, `renderSearch` (the screen) / `renderSearchResults` (**only the results** — rebuilding the field would drop focus), `searchActivities`/`searchCollections`, `searchRowHTML`, and `searchMark` — **the one place a rendered string is not `esc()`'d wholesale**; it splits on raw text and escapes each piece. See **Finding things again**. |
| `upnext.js` | The Up Next screen pushed from Home: every unfinished activity, bucketed by `targetBand()`. Borrows its rows and sort from `home.js`. |
| `done.js` | The Accomplished screen pushed from Home: everything completed, grouped by the month it was finished. Reuses Home's photo tiles. |
| `home.js` | The Home tab. `renderHome()` plus one function per section, the shared `upNextRowHTML()`/`sortUpNext()` the Up Next screen also uses, the context-free composer (`homeQuickAdd`, which opens the full activity sheet — or routes to `importFromComposer()` when what was typed is a URL, see **Sharing a link in**), and `toggleCompleteFrom()` — Home's copy of the completion toggle, which cannot rely on `curListId`. |
| `collections.js` | `renderCollections()` (the Lists tab) plus the collection CRUD: `openNewList`, `openEditList`, `renderCoverPreview`, `clearCover`, `handleCoverUpload`, `saveList`, `delList`. `delList` deletes the collection's activities first — there is no DB cascade — and, once an activity can be in several lists, deletes only the ones with nowhere else to go and unlinks the rest. |
| `detail.js` | One collection. Rendering is **deliberately split in two**: `renderDetail()` builds the banner and the controls, `renderActivitiesList()` rebuilds only the list. Search and filter call the second, so the search field never loses focus mid-typing. Also `activityRowHTML`/`activityCardHTML`, `sortButtonHTML()` (the sort control beside the filter), and the quick-add composer helpers (`composerHTML`, `onComposerKey`, `focusComposer`). |
| `activities.js` | The whole activity flow. **Creating always goes through the sheet** — `quickAddActivity()` only takes the composer's text and opens `openNewActivity(name)` with it; nothing here inserts an activity directly except `commitSaveActivity()`, which is the sheet's own Save. `toggleComplete(id, isDone)` is the one-tap completion (see the note below). Then `openNewActivity`, `openEditAct`, `saveActivity`, `delActivity`, plus `renderActListPicker()`/`renderActListValue()`/`setTargetLists()` and the `targetListIds` global (with `targetListId` as a read-only alias for the home list) — the Lists row that lets an activity be filed from outside any collection, and which is hidden when there is no choice to make. Also `listFieldsFor()` and `removeActivityFromList()` — see **One activity, several lists**. Also `setPriorityChoice` (**the only way to set priority** — it keeps the swatched buttons and the hidden `#aPri` value in step), `openComp`/`openCompletedDate`/`confirmComplete` — the one completion sheet, every field on it (see **The two-speed activity flow**) — and `openActDetail` which builds the activity sheet. Plus `openCollectionMenu` (the ⋯ action sheet, which holds the view switcher and everything the old five-button hero row spelled out), `setFilter`, `setView`, and `openSortMenu`/`setSort`. |
| `me.js` | `renderMe()` (stats), `renderMeIdentity()`, `openDeleteAccount`/`onDeleteAccountInput`/`deleteAccount` (see **Deleting an account**), `loadUserProfile()` (reads the `Users` row once per session into `userProfile` — **and creates it when missing**, via `createUserProfile`/`profileSeed`/`USERNAME_RE`; see **Signing up**), `confirmSignOut()`. The tab's three App rows are wired elsewhere: Add to Home Screen to `pwaShowInstallHelp()` in `pwa.js`, Share links into the app to `openShareSetup()` in `share.js`, and Join a shared list to `openJoinByCode()` in `sharing.js`. |
| `bulk.js` | The "add many at once" sheet, one card per row. Row values live in `bulkEntries[]` and the DOM is re-rendered from it wholesale, so **`saveBulkFieldValues()` must flush the inputs back into the array before any redraw** — every mutation helper does this. `_skipSaveBulk` suppresses that flush in `bulkApplyDown` (the "copy row 1" pills), which has already updated the array itself. `openBulkAdd(listId)` takes an explicit destination in `bulkListId`, defaulting to `curListId`: the sheet normally opens from a collection, but an import from Home has no collection context and passes the chosen list. |
| `share.js` | **Turning a shared link or a screenshot into an activity.** `readSharedInput()` (boot; parses and strips the query param), `handleSharedInput()` (called from `showApp()`), `openImportSheet`/`runUnfurl`/`renderImportState`/`IMPORT_FAIL_STATE`, `pickScreenshot`/`handleScreenshot` (downscale and send to the vision path), `handOffSingle`/`handOffMany`/`shareSourceLinks`, `looksLikeUrl`/`importFromComposer`, and `openShareSetup`/`shareTargetUrl`/`copyShareTargetUrl` for the iOS Shortcut. Loads after `activities.js` and `bulk.js` because it hands drafts to both. See **Sharing a link in** below. |
| `map.js` | All MapLibre GL. **`ensureMapLibre()`** — the library is loaded on demand here, not from `<head>`; at ~900KB it was the biggest single cost of a cold launch, blocking the parser on the way to a Home screen with no map on it. Both entry points await it and fall back to the "map unavailable" state if it cannot be fetched. Then `mapStyle()` (raster CARTO basemap + globe projection + sky), `webglOK()`, `actsToGeoJSON()`, and `attachActivityLayer()` — which adds the clustered GeoJSON source and syncs DOM markers (`makePinEl`, `makeClusterEl`) to the viewport. Then the two instances: the Map tab (`renderGlobalMap`, `fitGlobal`, `zoomGlobe`, `globeFillZoom`, `setGlobalMapFilter`) and the per-collection map (`renderMap`, `updateMapMarkers`). Plus `mapLoaded(map)` and `hasGeo`. Teardown is explicit — `destroyGlobalMap()`/`destroyDetailMap()` — because each map holds a WebGL context, but **only the detail map is torn down on navigation**. See **The immersive map** above for the traps. |
| `pwa.js` | Service-worker registration and the install/offline UI: `isStandalone()`/`isIOS()` (which stamp `.standalone`/`.ios` on `<html>`), the `beforeinstallprompt` capture behind `pwaInstall()`, the iOS Add-to-Home-Screen sheet, `pwaShowInstallHelp()` (the Me tab row), and `pwaUpdateOnlineState()`. Dismissals persist in `localStorage` under `bl_*` keys. **It also calls `reg.update()` on foreground and on reconnect** — an installed PWA is rarely killed, and registration is the only moment the browser looks for a new `sw.js`, so without it a shipped fix can sit undelivered on the home-screen copy for days and look like it was never made. **`pwaHadController` gates the `controllerchange` reload** so it fires on an update and not on a first install — see **Shared lists**, where getting that wrong silently destroyed every invite link. |
| `main.js` | Boot: `paintStaticIcons()` fills the empty icon placeholders left in `index.html` from the sprite map, then the three query-string readers run in a **fixed order** — `readEmailConfirmation()`, `readSharedInput()`, `readPendingJoin()` — all **before** the session restore, because a link can be shared in, an invite opened, or an address confirmed while signed out. Then `consumeEmailConfirmation()` is tried ahead of `restoreSession()`, and `showApp()`/`showAuth()` follows. **Loads last.** See **Staying signed in** (why `restoreSession()` is more than one `getSession()` call) and **Coming back through the confirmation email** (why the reader order is not arbitrary). |

### The two-speed activity flow

The most important interaction decision in the app, and the reason several
functions look redundant:

- **Adding. ⚠️ NOTHING EVER INSERTS AN ACTIVITY WITHOUT SHOWING THE SHEET
  FIRST.** This is a hard rule, not a default — if you add a new way to create
  an activity, it routes through `openNewActivity(prefillName)` too.

  Both composers — the one on Home and the one at the end of a collection's
  list — are a way to *start* an activity, not a way to file one. They take a
  name, clear themselves, and open the sheet with it prefilled.

  This is a deliberate reversal of the original design, in which the composers
  inserted on Return with only a name. That was the fastest path in the app and
  also the one that produced its worst rows: no priority, no real target date,
  no location — so the activity never surfaced in Up Next and never appeared on
  the map. An idea captured into a hole is not captured. Nothing on the sheet is
  required beyond the name, so the cost is one extra tap rather than any actual
  filling-in, and the fields are in front of the user at the one moment they are
  thinking about the thing.

  The bulk sheet (`js/bulk.js`) already satisfies this: its rows *are* the form,
  carrying name, notes, location, target and priority before anything is
  written. So does an import, which hands off to the activity sheet for one
  result or the bulk sheet for several.

  The composer's old "Details" button is gone — once Return opened the sheet,
  the two did the same thing. A go arrow (`.composer-go`) replaces it, matching
  Home's.

  **The activity sheet's shape.** Everything is on one screen: name, then
  target date and list side by side, then priority, location, reminder,
  notes and links. Three things hold it together and none of them is
  decoration:

  - **The name uses `.fg-hero`** — serif, 22px, its own tinted ring, and
    the only focus ring in the app. As a plain `.fg` input it was the
    first of six identical boxes and the sheet had no visible subject.
    The serif is doing the same job it does in every list: this is a
    name, not a setting.
  - **Target date and list share a line** (`.fg-pair`). Two one-tap
    choices with short values; a full row each is what made the sheet
    long enough to need hiding half of it. It is a **flex** row, not a
    two-column grid, because `renderActListPicker()` hides the List half
    when the user has no lists and the date must then span the line.
    The List half is a `.picker-btn` rather than a `<select>` — it opens
    `openListPicker()`, which is the one way to assign a collection.
  - **There is no "More options" disclosure.** Notes and links are shown
    outright. Location was pulled out of it first, for the reason above;
    the rest followed once the paired line made room, because a
    collapsed field is one most people never open. Don't put it back —
    the whole sheet fits a 320px screen without scrolling.
- **Completing.** Tapping the check opens `openComp()` — **one sheet**, with
  every field on it: the name, the date, the place, the photos and video, and
  how it went. **Nothing is written until Save**, so an accidental tap costs a
  Cancel rather than a wrong date to find later.

  It used to be two sheets: a date-only one that completed the activity, and a
  separate details one you had to go and find afterwards, three taps down
  inside the activity sheet. The moment you tick something off is the moment
  you have the photos, so they belong in the same place.

  The photos and notes then spent a while behind an "Add photos, video &
  notes" disclosure *on* this sheet, which was the same mistake one level in —
  the collapsed half held the single thing people most want to attach. **There
  is no disclosure left anywhere in the app**; don't reintroduce one here. It
  costs the fast path nothing: press the check, press Done, without touching
  anything in between.

  Un-completing is still immediate: there is nothing to ask. It writes **only
  `date_completed`**, so un-completing never destroys the notes and photos on
  a past completion.

  **The activity sheet reads name → badges → photos → "How it went".** The
  title leads because it is what the sheet is about, and the state/date pair
  reads as the caption beneath it while still sitting directly above the media
  it names. The name is centred on a completed activity, to sit over the
  symmetric full-width pair of badges below it; a pending activity's badges are
  small left-aligned chips, so its title stays left. Spacing runs downward from
  the title — `.ad-title` has no top margin and `.ad-badges` carries the gap.

  **The media grid is capped at six tiles** (`AD_GRID_MAX` in
  `activities.js`) — two rows. Past that it shows five and folds the rest
  behind a `+N` tile (`.ad-photo-more`) that opens the lightbox at the first
  item it is hiding; the lightbox walks the whole list, so nothing is
  unreachable. Uncapped, a dozen photos pushed the notes and every action
  button off the bottom of the sheet.

  **"How it went" is capped in height and scrolls inside itself**
  (`.ad-note.prose`, 240px). It is the one field the user can write without
  limit, and an uncapped block made the sheet read as if it held nothing but
  notes. It is listed in `ownsVertical()` in `gestures.js` and sets
  `overscroll-behavior: contain`, so scrolling it neither dismisses the sheet
  nor chains into the sheet body.

  Its actions differ by state too. Completed: **Edit** takes a full-width row
  because it is what you came for, and *Mark as not done* pairs with *Delete*
  on the last row (`.sheet-actions-row`) — both are corrections, undoing a
  record rather than adding to one. Pending: *Mark accomplished* is the
  primary and keeps a full-width row of its own.

  **Once something is done, this sheet is the only way to edit it.** The
  activity sheet's "Edit details" is hidden for a completed activity and the
  remaining button is just "Edit" — everything `openEditAct()` offers (target
  date, priority, reminder) is about what to do next, and a finished thing has
  no next. So the name and the location live here too, not only the photos and
  notes.

  It is opened by `openCompFrom()`, which registers a return *before* opening —
  so Save, Cancel, the scrim, Escape and a swipe down all land back on the
  activity sheet rather than dropping you on the bare page behind it. See
  `onSheetClose()` in `modals.js`: registering the return there rather than on
  the Save button is what makes all five paths agree, and **any new dismissal
  route must go through `closeModal()` or call `afterSheetClosed()` itself.**

## Back end

Supabase project `xxdmendegyxlkikejvps`. Three core tables plus two
optional ones for sharing, one storage bucket (`media`, optional — see
**Media**), two Edge Functions — `send-reminders` and `unfurl` (see
**Sharing a link in**), both optional — and two RPCs that exist only
once `sharing.sql` has been run. Reads are direct PostgREST via
`supabase-js` from `js/api.js`; **writes go through `js/offline.js`** so
they can be queued when there is no network.

| Table | Columns |
| --- | --- |
| `Collections` | `id`, `created_at`, `name`, `description`, `cover_image`, `user_id`, `number_activities`, `activites_completed`, `category_tag` |
| `Activities` | `id`, `created_at`, `collection_id`, `extra_collection_ids` *(optional — added by `multilist.sql`; see **One activity, several lists**)*, `name`, `description`, `target_date`, `priority`, `date_completed`, `experience_notes`, `photos`, `links`, `location`, `location_lat`, `location_lng`, `category_tag`, `remind_at` (see below) |
| `Users` | `id` (= `auth.users.id`), `created_at`, `display_name`, `username`, `icon` |
| `collection_members` *(optional)* | `collection_id`, `user_id`, `role`, `display_name`, `created_at` — added by `sharing.sql` |
| `collection_invites` *(optional)* | `code` (PK), `collection_id`, `created_by`, `role`, `revoked`, `expires_at`, `created_at` |
| `invite_claims` *(optional)* | `email`, `code` (composite PK), `created_at`, `claimed_at`, `claimed_by` — added by `sharing.sql` section 5. An invite waiting for an account that does not exist yet. **RLS on with no policies**, so only the two `SECURITY DEFINER` RPCs can see it. |
| `push_subscriptions` | `id`, `user_id`, `endpoint` (unique), `p256dh`, `auth`, `user_agent`, `created_at` — added by `schema.sql` |
| `reminder_deliveries` | `activity_id`, `user_id`, `remind_at` (composite PK), `sent_at` — added by `schema.sql`. Who has already been told about which reminder, per person. See **Reminders**. |

RPCs, from `sharing.sql`: `peek_invite(code)` reads an invite without
accepting it, and `join_collection(code)` is **the only way a member row
is ever created** — there is deliberately no INSERT policy on
`collection_members`. Section 5 adds two more: `claim_invite(code, email)`
(callable by `anon`, because it runs before the account exists) records an
invite against an address, and `claim_invites_for_me()` redeems whatever is
waiting for the signed-in one and returns what it joined. See **An invite
that survives creating an account**. The `SECURITY DEFINER` helpers `owns_collection`,
`is_collection_member` and `can_use_collection` exist to break RLS
policy recursion; read that file's header before touching them.

**`Collections.id` and `Activities.id` are `uuid`**, and the client now
mints them itself (`stampRow()` in `offline.js`) rather than letting the
database default fill them in. That single fact is what makes the
offline write queue tractable — see **Working offline**.

Schema notes and traps:

- **`Collections.activites_completed` is misspelled in the database** (missing
  the second `i`). `api.js` matches the real column name. Don't "fix" it in code
  without renaming the column.
- **`number_activities` / `activites_completed` are written but never read.**
  `updateCollectionStats()` keeps them roughly current, but all displayed
  counts are computed client-side from the fetched activities. They're
  denormalized columns waiting for a use — and because nothing reads them,
  that write is **debounced and detached** rather than awaited. Don't put it
  back on the critical path; see the cache section. They also count on
  `collection_id` alone, so they undercount an activity that is in several
  lists. Anything that starts *reading* them has to fix that first.
- **`collection_id` is the home list, not the only list.** Once
  `multilist.sql` has been run, `extra_collection_ids` holds the rest and
  membership means "either end". `fetchActivitiesFor()` and the RLS policies
  both match on the set; a query written against `collection_id` alone
  silently misses anything filed in from another list.
- **`Users` needs `supabase/profiles.sql` run against it.** Nothing else
  manages its RLS, and without an INSERT policy the profile row cannot be
  created. See **Signing up**.
- **`category_tag` (both tables) and `Users.icon` are unused** by the front end.
- **The CSVs in `Supabase Setup/` are stale.** `Activities.csv` predates
  `location_lat`/`location_lng`, which the live table has and the code depends
  on. Treat the table above as the reference, not the CSVs.
- `target_date` is **not a date** — it's one of a fixed set of strings
  (`"Before I Die"`, `"This Month"`, `"This Year"`, `"Next Year"`,
  `"In 2-3 Years"`, `"In 5+ Years"`, or empty). `dateInfo()` in `utils.js` maps
  those to a real deadline and an urgency badge. `date_completed` *is* a real
  date; completion is inferred from it being non-null.
- `photos` and `links` are JSON array columns. `mapActivity` tolerates them
  arriving as either arrays or JSON strings. **`photos` holds two shapes** — a
  bare string for a photo, an object for a video — see **Media** above.
- **Storage:** a `media` bucket holds completion photos and video, one folder
  per user, created by `supabase/storage.sql`. Optional; the app falls back to
  inline base64 photos without it.

**Security:** `SUPABASE_KEY` in `config.js` is the publishable/anon key and is
meant to be public, but it only protects data if **Row Level Security is enabled
on all three tables *and* no permissive policy undoes it**. This project shipped
for a while with a policy literally named `ALL` on each table —
`to authenticated`, `cmd ALL`, `using (true)` — which OR'd over every correct
policy and gave every signed-in user full access to everyone's rows.
`supabase/rls-lockdown.sql` removes them and carries the audit query.
**Checking this from the client is not possible**: those policies grant nothing
to an anonymous request, so an unauthenticated probe returns `[]` and the
project looks locked down. `fetchActivitiesFor`/`fetchAllActivities` query by
`collection_id` with no user check and rely entirely on RLS to scope results;
`fetchCollections` filters on `user_id` client-side, which is not a security
boundary. Confirm RLS policies before treating any of this as private.

Running `sharing.sql` **enables RLS on `Collections` and `Activities`** and
adds `bl_*`-named policies covering owner-or-member access. It leaves any
pre-existing policies alone, and multiple permissive policies are OR'd
together — so check the Policies tab afterwards and drop anything now
superseded, or an older broader policy will keep granting what it granted.

Note that with sharing on, `fetchCollections()` **drops its client-side
`user_id` filter** and leans entirely on RLS, because a joined list is not
one you own. With sharing off the filter stays, since without RLS removing
it would return every user's rows.

## PWA / installability

The app installs to an iPhone home screen and runs chrome-less and offline.
Four pieces make that work, and all four must stay in sync:

1. **`manifest.webmanifest`** — `display: standalone`, `start_url: ./index.html`,
   a `share_target` (GET, into `./index.html`) that makes the app a share
   destination on Android and desktop Chrome — iOS ignores it, which is why
   **Sharing a link in** has three tiers —
   `theme_color`/`background_color` both `#efece6` (matching `--bg`, so the
   splash and status bar don't flash a different color), and three icons.
2. **The `<head>` meta block in `index.html`.** iOS ignores the manifest's
   display mode and icons, so `apple-mobile-web-app-capable`,
   `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title` and
   `<link rel="apple-touch-icon">` are what actually drive the iOS install.
   The status-bar style is `default` (an opaque light bar with dark text);
   switching it to `black-translucent` would put white status text over the
   cream background and make it unreadable.
3. **`viewport-fit=cover`** on the viewport meta, which is what makes the
   `env(safe-area-inset-*)` values in `base.css` non-zero once installed. Any
   fixed or full-bleed element must add the relevant inset — see `.navbar`,
   `.tabbar`, `.lightbox`, and the `pwa.css` overlays for the pattern.
4. **`sw.js`** — pre-caches the shell listed in `SHELL_ASSETS` on install,
   then serves same-origin files stale-while-revalidate, vendor bundles/fonts/
   map tiles/Unsplash covers cache-first, and navigations network-first with
   the cached `index.html` as the offline fallback. **Supabase and Nominatim
   are on `NEVER_CACHE_HOSTS`** — caching auth or live rows would serve a
   signed-out user stale data.

The icons are committed PNGs, not build output. `icons/generate.py` redraws the
whole set (`python3 icons/generate.py`, needs Pillow) — edit `draw_art()` there
rather than hand-editing the PNGs. Note the maskable variant deliberately draws
the artwork smaller so Android's adaptive-icon mask cannot crop the peaks.

Offline means *the shell*, not the data: activities come from Supabase, so a
cold offline launch shows the UI with empty lists plus the `.offline-bar`.

## Mobile layout rules

Worth knowing before touching any stylesheet. The layout is **phone-first** —
these are the defaults, not overrides.

- **Horizontal padding comes from `--gutter`**, via `var(--gx-l)`/`var(--gx-r)`
  (gutter + the matching safe-area inset). Don't hardcode a screen inset — set
  `--gutter` at the breakpoint and everything follows.
- **Inputs must never compute below 16px.** Safari zooms the whole page when a
  focused field's text is smaller, and it stays zoomed. Every field in the app
  uses `font-size: max(16px, 17px)`.
- **A `width: 100%` element must never also carry horizontal margins.**
  Together they make it wider than its parent, and the resulting horizontal
  scroll drags `position: fixed` elements sideways on iOS — so the tab bar and
  any open sheet end up visibly offset. That happened with `#mapContainer`
  (`.map-box` sets `width: 100%`, the detail map adds gutters) and presented as
  three unrelated-looking bugs: a map that ran off screen, a clipped "Add Many"
  sheet, and a drifting tab bar. `width: auto` is the fix and is load-bearing.
- **The tab bar is `translateZ(0)`** so iOS gives it its own layer; without it
  fixed elements repaint late during momentum scrolling and appear to drift.
  `--tab-inset` is floored at 6px for the same reason `--nav-inset` is.
- **The tab bar must stay behind the keyboard, not ride up on it.** It is
  `position: fixed; bottom: 0`, and on iOS the software keyboard shrinks the
  *visual* viewport while leaving the layout viewport alone — Safari then
  re-anchors fixed elements to the visual one, so the bar climbs and parks
  on top of the keyboard, under the predictive-text row. Script cannot opt
  out of that, but `syncTabbarToKeyboard()` in `nav.js` measures it: the gap
  between the bottom of `visualViewport` and the bottom of the layout
  viewport is exactly how far Safari lifted it, so translating back down by
  that much returns it to where it belongs. Three things to keep:
  - **iOS only.** Chrome on Android already pins fixed elements to the
    layout viewport, which is the behaviour being reproduced; applying the
    correction there too would push the bar a whole keyboard *below* the
    screen.
  - **The tab bar and nothing else.** Bottom-anchored sheets *should* rise
    with the keyboard — that is the entire reason they are bottom-anchored.
    Do not generalise this to them.
  - **`translate3d`, not `translateY`.** An inline transform overrides the
    CSS `translateZ(0)`, so it has to carry the layer promotion itself.
- **The nav bar has its own inset, `--nav-inset`,** floored at 14px. In an
  installed PWA the notch inset already provides room; in a browser tab
  `safe-area-inset-top` is 0 and the back button ended up pinned against the
  viewport edge. Only pushed screens (`.page-pushed`) pad down to match — root
  tabs keep the tighter offset, since their bar is empty until you scroll and
  padding it out just puts dead space above the title.
- **One column, and the cap is on `.page`, not on its children.** Every
  screen-level container insets itself by a gutter, but they use two different
  mechanisms — `margin: 0 var(--gx-r) 0 var(--gx-l)` (the detail banner, the Up
  Next card, `.act-group`) or the matching `padding` (`.searchbar`, `.shelf`,
  `.home-sec-head`). On a phone the two are indistinguishable, and **either is
  fine**.

  They stop being equivalent the moment something caps the *children*. That is
  what `responsive.css` used to do (`.page > * { max-width: 640px;
  margin-inline: auto }`), and `margin-inline: auto` overrides a margin gutter
  while leaving a padding one untouched — so margin-based containers ran a full
  gutter wider on each side than padding-based ones. It shipped twice: Home's
  photo shelf sat narrower than the cards above it, and on a collection screen
  the banner visibly bled past the search field and list beneath it.

  Capping `.page:not(.page-map)` instead keeps both mechanisms honest: every
  child measures from the same edge and applies the same gutter to it, so they
  line up by construction. `--content-max` is the single token (640px, 720px at
  ≥1000px); the page cap and both nav-bar paddings derive from it.
- **Fixed chrome has to re-derive the column.** `.navbar` is `position: fixed`,
  so it spans the viewport and inherits nothing from `.page`. It takes
  `var(--gx-l)`/`var(--gx-r)` on a phone and, at ≥700px, is padded to
  `(100% - var(--content-max)) / 2` — the content's own left edge — so the back
  button sits directly above the first card's corner rather than floating
  inboard of it. The tab bar deliberately stays centred and compact instead:
  four tabs stretched across 720px drift away from the thumb.
- **A component's container and one of its inner spans must not share a class
  name.** This bit twice, in the same way. `.up-list` was the card wrapping
  Home's Up Next rows *and* the span naming a row's collection; `.dupe-list`
  was the card holding duplicate matches *and* the span naming a match's
  collection. Both spans silently inherited their card's ring and radius with
  no padding, so the list name rendered inside a stray outlined box with the
  text flush against it. Both now use **`.list-chip`** (see below). If you find
  yourself writing `.foo .foo`, rename one of them.
- **A label belongs to the field below it.** Keep the gap under a label
  smaller than the gap above it (currently 6px vs 22px), or it reads as a
  caption for whatever precedes it. This was a real bug: the first label in a
  disclosure sat flush against the toggle button.
- **Fixed chrome must account for the safe areas.** `--chrome-top` and
  `--chrome-bottom` already fold the nav/tab bar heights together with the
  notch and home-indicator insets; use them rather than re-deriving.
- **Never abbreviate a unit in a glanceable label.** `dateInfo()` spells out
  "5 months left", not "5 mos left" — an abbreviation saves a few pixels and
  makes the reader decode instead of read. Give the label a fixed slot and
  truncate something else around it.
- **A hidden `<input>` inside a `.fg` needs `.fg [hidden] { display: none }`.**
  `.fg input { display: block }` outranks the browser's own `[hidden]`
  rule, so a hidden file input paints as a full-width native "Choose
  File" control — a second, unstyled button beside the real one. Both
  file pickers in the app (cover photo, and photos/video) sit in a `.fg`
  and both showed it.
- **Put the tap target on the row, not on the text inside it.**
  `.act-row`, `.up-row` and `.rem-row` carry the `onclick`; the inner
  `.act-main`/`.up-main` button is layout only, and the check button
  calls `stopPropagation()` so it still toggles rather than opening.
  With the handler on the inner button instead, the thumbnail and the
  trailing chevron — the part that most looks like "tap to open" — were
  dead space.
- **Tap targets are 44px** for anything primary. Deliberate exceptions, matching
  Apple's own control sizes: segmented controls (32px) and search fields (36px).
- **Viewport heights use `svh`/`dvh` with a `vh` fallback.** Plain `100vh` is
  wrong on iOS, where it counts the collapsed-URL-bar height.
- **A sheet must be reset to the top when it opens.** `.sheet-body` keeps its
  `scrollTop` between openings, so once one has been scrolled — to reach the
  buttons at the bottom of the activity sheet, say — every later opening starts
  there and whatever is at the top is silently missing. It does not *look*
  scrolled, because `.sheet-grabber` is `position: absolute` on the `.modal`
  and stays put. This cost real time twice: it presented as "the activity sheet
  has no title" when the title was there all along. `openModal()` resets it.
- **Sheets are the only modal style below 700px** — bottom-anchored, full width,
  rounded top. Anchoring to the bottom edge keeps a focused field in a stable
  place when the keyboard resizes the viewport. At ≥700px `responsive.css`
  re-centres them as dialogs and drops the grab handle.
- **Nothing may be hover-only.** There is no hover on a phone. `responsive.css`
  confines every hover affordance to `@media (hover: hover)`.
- **Nothing may sit within 14px of the window edge.** Every screen is audited
  for this (see below); the gutter is 16px even on a 320px phone, and the fixed
  bars, sheet bars and action sheet all inset their contents to match. When
  adding a full-bleed element, pad its *contents* rather than letting text or
  icons run to the glass. The only deliberate exception is the map, which is
  meant to bleed.

  This is also why Home's two shelves are **grids, not horizontal
  scrollers**. A scroller necessarily runs its content off the edge — at rest
  the last card sits clipped flush against the glass — so `.shelf` lays them
  out in an inset grid instead. Resist re-introducing a carousel here.

### A note on verifying layout in headless Chrome

Four traps cost real time when this was built, all worth knowing before
trusting a screenshot:

1. **Chrome clamps its window to a 500px minimum width**, so `--window-size=390`
   silently renders at 500 and crops. Render the app inside a fixed-width
   `<iframe>` instead — media queries and `dvh` resolve against the iframe.
2. **CSS animations don't advance under `--virtual-time-budget`.** A screen
   that enters with `anim-push` will be measured at its `translateX(28px)`
   start offset and look like a 28px horizontal overflow that does not exist.
   Neutralise the animation before measuring; `--force-prefers-reduced-motion`
   does *not* reach into an iframe.
3. **WebGL is off under `--disable-gpu`**, which the map needs. Run Chrome with
   `--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader`, and
   expect it to be slow: the map's tiles and markers need ~10s of *real* time,
   which `--virtual-time-budget` does not provide. Keep the browser alive with
   `--remote-debugging-port` and have the page report its own state if you need
   to check the map actually loaded.
4. **Measure the content box, not the border box,** when auditing edge insets.
   A full-width block whose text is padded inwards is fine; comparing
   `getBoundingClientRect()` alone reports it as touching the edge.

## Adding a screen

1. Add `<div class="page" id="page-yourpage">` in `index.html`.
2. Decide whether it is a **root tab** or a **pushed screen**:
   - root tab → add a `<button class="tab" data-tab="yourtab">` to `.tabbar`,
     a `PAGE_TAB` entry in `nav.js`, a case in `selectTab()`, and a line/solid
     glyph pair in `paintStaticIcons()` (`main.js`). Five tabs is the practical
     ceiling on a phone;
   - pushed screen → add a `PAGE_TAB` entry pointing at the tab that owns it,
     and give it a back button in `updateNavbar()`.
3. Add its bar buttons to `updateNavbar()` in `js/nav.js`.
4. Create `css/yourpage.css`; `<link>` it *before* `responsive.css`. Use
   `var(--gx-l)`/`var(--gx-r)` for horizontal padding, and reach for the
   primitives in `components.css` before writing new ones.
5. Create `js/yourpage.js` with `renderYourPage()`; add its `<script>` tag
   *before* `pwa.js`.
6. Add `if(page==='yourpage') renderYourPage();` to `nav()`, and a line to
   `refreshAfterChange()` if a mutation can happen while it is showing.
7. If it is a pushed screen, add it to the `PUSHED` array in `nav()` so it
   animates in from the right and swipes back.
8. Add both new files to `SHELL_ASSETS` in `sw.js` and bump `CACHE_VERSION`.
9. **Update this file** — File structure, the CSS/JS file maps, and the
   Screens table.

Two things that will bite:

- **Refer to files as `foo.js`, never `js/foo.js`, in `index.html`
  comments.** The shared-scope check greps the whole file, so a path in a
  comment concatenates that file twice and reports every top-level
  declaration in it as a duplicate. This cost real time on the search
  screen.
- **`--dump-dom` produces nothing in Chrome 151.** The headless recipes in
  the layout note below need driving over CDP (`--remote-debugging-port`
  plus `Runtime.evaluate`) rather than dumping to stdout.

## Known issues / cleanup backlog

- **Rows written before the `media` bucket existed still carry base64
  photos.** They render fine, and are converted only if that activity's media
  happens to be edited. A one-off backfill that uploads them and rewrites the
  column would shrink the table considerably; nothing does it automatically.
- **Reordering media is drag-only.** There is no keyboard or
  assistive-technology path to it, and the tiles are not focusable. The button
  menu it replaced was reachable; this is not. A long-press menu as a fallback
  would fix it without giving the gesture up.
- **EXIF location is unverified on a real iPhone.** JPEG and HEIC are both
  handled and mime-type mislabelling no longer matters, so the known ways
  it could silently fail are closed — but it has only been tested against
  constructed fixtures and headless Chrome, never a real camera roll. It
  degrades to silence, which is correct and also means a failure is
  invisible; `handleMedia()` logs one `[media] photo location:` line to
  the console naming which gate it fell through. The same parser could
  read `DateTimeOriginal` to suggest the completion date too; it does not.
- **Deleted media is not removed from Storage** — only its URL is dropped from
  the row. See the sweeper query at the bottom of `supabase/storage.sql`.
- **Mutations re-render from the cache, but there are no optimistic updates.**
  A quick-add still waits for the insert itself before the row appears — one
  round trip now, down from five, but not instant. (Offline it *is* instant,
  because the write is applied to the snapshot and queued — which is a good
  hint at how the online path should eventually work.)
- **Legacy base64 photos are still on the list query's critical path.**
  `select('*')` pulls `photos`, and any row written before the storage bucket
  existed has image data inline, so a handful of them can be megabytes on
  every fetch. Painting from the snapshot hides this on launch but not on
  `revalidate()`. The one-off backfill below would fix it properly; dropping
  the column from the query cannot, because `a.photos[0]` is the cover every
  thumbnail, grid card and map pin draws.
- **Media created offline stays base64 forever.** A photo attached with no
  connection is embedded in the row and syncs that way; nothing later uploads
  it to the bucket and rewrites the column. Same gap as the pre-bucket rows
  above, and the same one-off backfill would fix both.
- **The write queue has no cap and no age-out.** Someone offline for a very
  long time accumulates ops indefinitely, and a queued write against a row
  another device has since deleted is dropped on replay with only a console
  warning — the user is told "1 change couldn't be synced" but not which.
- **Shared lists are last-write-wins with no presence.** Two people editing the
  same activity in the same minute silently clobber each other, and there is no
  indication that anyone else is in a list or has changed something. Realtime
  subscriptions would be the natural fix; `revalidate()` on foreground is what
  there is today.
- **A shared list has one reminder, not one per person.** `remind_at` is a
  column on the activity, so the last person to save a reminder overwrites
  whatever the previous one set, and nobody can keep a private nudge about a
  shared activity. The delivery side is per-user now
  (`reminder_deliveries`); the *setting* side is not. Making it per-person
  means moving `remind_at` out to its own table, which is a real schema
  change and a real UI change — the sheet would have to say whose reminder
  it is showing.
- **Background push is not actually switched on.** `VAPID_PUBLIC_KEY` is
  empty in `config.js`, so `pushConfigured()` is false and tier 3 is dead for
  everyone, owners included — reminders currently run on the Home banner and
  the on-open local notification only. Generate a pair
  (`npx web-push generate-vapid-keys`), paste the public half into
  `config.js`, set the private half as a function secret, and deploy
  `send-reminders`.
- **A member can rename a shared list.** The RLS update policy on `Collections`
  allows owner-or-member; narrowing it to the owner is a one-line change in
  `sharing.sql` if that turns out to be wrong.
- **`peek_invite` is granted to `anon`.** It exposes a list's name, its owner's
  display name and an activity count to anyone holding a valid code. That is
  intentional — the join sheet has to say what is being joined — but it is a
  real, if small, disclosure.
- **Duplicate detection only compares against the cache.** With a cold cache it
  silently does nothing, and it never sees activities in lists that failed to
  load. It also cannot catch a duplicate of something a *different* device
  added moments ago.
- **Screenshot import costs an LLM call per screenshot**, like a link import,
  and nothing dedupes by image hash.
- **Search has no result-count cap on the underlying scan.** Every activity is
  scored on every keystroke. Fine at hundreds; it would need an index at tens
  of thousands.
- **`getChipArr(which)` ignores its parameter** (see `links.js` above).
- **No URL/route state.** Reloading always returns to the Lists tab; a
  collection can't be linked to, and there is no browser-back integration —
  the `goBack()` chevron is the only way out of a pushed screen.
- **Instagram links still cannot be read**, but a screenshot of one can — see
  **Sharing a link in**. The link path itself is unfixable without a Meta app
  and `oembed_read` App Review.
- **`sw.js` duplicates the asset list in `index.html`.** `SHELL_ASSETS` must be
  updated by hand; nothing enforces it. The pre-cache loop tolerates a missing
  path (it warns and continues), so the failure mode is a silently non-offline
  file rather than a broken install.
- **`CACHE_VERSION` is bumped by hand.** Forgetting it means returning installs
  keep serving the previous build until stale-while-revalidate catches up on a
  second load.
- **No swipe-to-delete on activity rows.** Delete lives in the activity sheet
  and the ⋯ menu. A swipe action would be the native touch, but it was left out
  rather than shipped untested — touch gestures can't be verified headlessly.
- **Instagram *links* still cannot be read.** No unauthenticated path exists —
  Instagram serves a login wall with no OG tags — and fixing the link path
  properly means a Meta app with `oembed_read` App Review, a
  business-verification process rather than a code change. In practice this
  is now worked around rather than open: the import sheet leads with "read a
  screenshot instead", which goes through the vision path and does not care
  what platform the picture came from.
- **The iOS Shortcut is set up by hand.** There is no way to install one
  programmatically, so tier 2 of **Sharing a link in** depends on the user
  following five steps in the You tab. A downloadable `.shortcut` file
  hosted alongside the app would cut that to one tap.
- **An import costs an LLM call.** `unfurl` calls Claude per shared link
  (~1–2¢). Nothing caches by URL, so sharing the same link twice pays
  twice. A small `url → result` table would fix it.
- **So does creating an activity, now.** The location guess is a model call
  per new activity whose name is at least three characters, whether or not
  it turns out to name a place — and the great majority do not, so most of
  those calls buy nothing. A cheap client-side pre-filter (does the name
  contain a capitalised word that is not the first?) would skip most of
  them; a `name → place` cache would fix the repeats. Neither is written.
- **The location guess is unverified against a real model.** The gates, the
  rejection rule and the fill/undo path are all tested, but the prompt in
  `predictPlace()` has never been run against Claude from this app — the
  function has to be redeployed first. Expect to tune `PLACE_SYSTEM`
  against real activity names; it errs strict by design, so the failure to
  watch for is it refusing things it should catch, not inventing places.
- **Multi-list has no per-membership data.** No "who added it to this list",
  no ordering within a list, no added-at. That is the point at which the
  array column stops being enough and `activity_collections` becomes the
  migration — see the header of `supabase/multilist.sql`.
- **Deleting a collection is a round trip per activity** once multi-list is
  on, because each one has to be either unlinked or deleted individually.
  A single RPC doing both in one statement would fix it.
- **Account deletion is not transactional.** `delete-account` runs a
  sequence of deletes; a failure part-way leaves the auth user in place
  (deliberately, so it can be re-run) but some rows already gone. A
  single `SECURITY DEFINER` RPC doing the lot in one statement would
  fix it, leaving the function to do nothing but `deleteUser`.
- **Nothing reaps a deleted account's Storage objects beyond its own
  folder listing**, which is capped at 1000 files. Someone with more
  than that leaves the remainder orphaned. Same sweeper problem as the
  one at the bottom of `storage.sql`.
- **An invite that survives sign-up needs section 5 of `sharing.sql` to
  have been run.** It is new, so a project that ran an earlier version
  of that file does not have `invite_claims` and the two RPCs. Both
  client halves fail soft — one `console.info` naming the fix — and the
  app behaves exactly as it did before, which means the failure is
  invisible unless you read the console. Re-run the file.
- **A claimed invite is redeemed against the address, not the person.**
  Someone who signs up with a different address from the one they were
  invited at — a work address on the laptop, a personal one on the
  phone — gets nothing, and there is no way for the app to notice. They
  fall back to **You → Join a shared list** with the code, which is why
  `sendInviteLink()` puts the code in the message body.
- **There is no password reset.** The confirmation landing already redeems
  a `type=recovery` link — it goes through the same `verifyOtp()` — so
  someone following one is signed in, but there is no "forgot password"
  link on the auth screen to request one and no screen to set a new
  password once they arrive. `sb.auth.resetPasswordForEmail()` plus a
  sheet calling `sb.auth.updateUser({password})` is the whole of it.
- **The confirmation email template is configured by hand.** Three
  dashboard settings decide whether a signup link works at all (see
  **Coming back through the confirmation email**), nothing in the repo
  asserts them, and getting any of them wrong looks identical from the
  outside. The app now says which failure it hit, which is the closest
  thing to a check there is.
- **`Users.icon` and `category_tag` (both tables) remain unused.**
- **The map needs WebGL.** There is no 2D fallback — `webglOK()` shows a
  message instead. In practice every browser that can run the rest of the app
  has it, but it is a hard dependency where Leaflet was not.
- **`GLOBE_PX_AT_Z0` in `map.js` is an empirical constant** (measured, not
  derived from MapLibre's projection maths). If a future MapLibre changes how
  the globe is sized, `globeFillZoom()` will be slightly off and the globe will
  open a little too large or too small.
- **Home and the detail screen still duplicate the completion toggle.**
  `toggleCompleteFrom()` / `toggleComplete()` do the same work against
  different assumptions about `curListId`. Folding them into one that always
  takes an explicit collection id would be a good tidy-up. (The add half of
  this is gone: Home's composer now routes through the activity sheet, so
  `addActivityToList()` was deleted.)
- **Home still re-renders in full after a quick add or a completion toggle.**
  It reads from the cache rather than the network now, so the cost is a
  re-render rather than two round trips, but it is still more work than
  patching the single row that changed.
