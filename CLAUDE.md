# Bucket List — Codebase Guide

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
supabase/             Backend — schema.sql (reminders), storage.sql (the media bucket), cron.sql, and the send-reminders Edge Function. All optional; each piece probes for itself and the UI that needs it hides when it is absent.
css/                  One stylesheet per concern (see CSS file map)
js/                   One script per concern (see JS file map)
icons/                App icon PNGs + generate.py, the script that draws them
Supabase Setup/       CSV exports of the Collections / Activities / Users tables (schema reference; STALE, see Back end)
_backup/              The original single-file version, kept as a safety net
```

There is no build step. Serve statically: `python3 -m http.server 8000`.

Service workers only run on `https://` or `localhost`, so the PWA half of the
app is inert when opened as a `file://` URL or over plain http on a LAN IP. The
rest of the app still works — registration failure is caught and logged.

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

Because Home has no collection context, it has its own copies of two flows:
`addActivityToList()` (rather than `quickAddActivity()`, which assumes
`curListId`) and `toggleCompleteFrom()` (which reads the activity's own
`listId` before updating that collection's stats). Keep those in step with
their `activities.js` counterparts.

#### The cache

Two queries back the whole app — every collection, and every activity in
them — and both are held in memory for the session by `js/api.js`.
Switching tabs re-renders from that cache. It is why moving between
screens no longer feels like a page load.

Four rules, and the first one is the one that bites:

1. **Every write must invalidate.** `invalidateActivities()` /
   `invalidateCollections()` are called at each mutation site. Miss one
   and the screen renders stale rows until something else happens to
   refetch. `updateCollectionStats()` invalidates collections itself and
   deliberately reads *past* the cache, since it runs against rows that
   have just changed.
2. **In-flight requests are shared.** Home renders four sections from the
   same two fetches; without this they raced into duplicate round trips.
3. **A failed request is never cached** — it returns `[]` as before but
   leaves the cache empty, so the next call retries instead of pinning an
   empty list for the session.
4. **`fetchActivitiesFor()` filters the shared cache** rather than
   issuing its own query. Entering a collection used to fetch the same
   rows twice, because `renderDetail()` and `renderActivitiesList()` each
   called it.

`cacheWarm()` is what lets a screen skip its spinner: blanking a screen
that is about to paint from memory turns an instant redraw into a visible
flash of nothing. `renderCollections`, `renderUpNext`, `renderDone` and
the list picker all check it.

The app is single-user and writes only from this client, so a
session-length cache is safe. `revalidate()` covers the case where it is
not — the same account on another device — and is called from `auth.js`
when the app is foregrounded and when the network returns. Sign-out
clears it, or the next person to sign in on the device inherits the
previous one's lists.

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

Supporting pieces: `config.js` spells out the auth options rather than relying
on defaults (and pins `storageKey`, so a supabase-js upgrade cannot silently
sign everyone out by changing it), and `body.booting` shows a splash until the
restore resolves, so a slow connection never flashes the login screen at
someone who is already signed in.

Worth knowing: **an installed PWA has its own storage partition on iOS**, so
signing in inside Safari and then installing to the home screen means signing
in once more. That is the platform, not a bug.

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

#### The list picker

`openListPicker({subtitle, currentId, onPick})` in `modals.js` is the one way
to assign an activity to a collection, used by both the Home composer and the
activity sheet's List row. Both previously called `showActionSheet()`, which
lays out a 57px full-width button per list — fine at three, an unusable tower
at twenty. The picker is a normal sheet with a compact scrollable list, a cover
thumbnail per row, and a search field that appears only past seven lists.
**Don't route this back through an action sheet.**

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
`push_subscriptions` table with RLS, and a trigger that re-arms a reminder when
its date moves), `functions/send-reminders/` (the daily sweep, which groups by
user so five due reminders are one notification, and prunes endpoints that
return 404/410), and `cron.sql`. `supabase/README.md` has the deploy steps.
The function requires an `x-cron-secret` header — without it, anyone could
trigger a send to every user's devices.

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

**Location is a top-level field, not a disclosure one**, in both the activity
sheet (under Priority) and the edit sheet (under the date). It decides whether
an activity ever appears on the map, so hiding it behind "More options" meant
most activities silently never did. What is left behind the disclosure is
notes and links on one, photos and "How it went" on the other.

**Setting one is a row, not a field.** The activity sheet carries a
`Remind me` row directly under Priority, reading `None` or `Scheduled`,
which opens `remindSheet` (`openRemindSheet`/`saveRemindSheet`/
`clearRemindSheet` in `reminders.js`). It was a date input plus a
textarea at the bottom of "More options": two controls for one optional
idea, which made the disclosure look like the sheet's main event, and
neither said whether a reminder was actually set without reading the
date off it.

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
| `components.css` | The reusable iOS primitives every screen builds from: `.group`/`.row` inset grouped lists, `.seg` segmented controls, `.btn` styles, `.searchfield`, `.badge`/`.tag`, the `.pri-*` priority marks, `.seg-pri`/`.pri-swatch` (the priority chooser), `.media-tile`/`.media-play` (one tile for a photo or a video, used by three screens), `.empty`, `.progress`, `.spinner`. Look here before inventing a new component. |
| `auth.css` | The signed-out screen — no nav bar, no tab bar, its own centring. |
| `home.css` | The dashboard: the greeting, the SVG progress ring, the context-free quick-add composer, the Up Next list, and the two `.shelf` grids (recently accomplished, your lists). |
| `collections.css` | The Lists tab: `.coll-card` photo cards and the "New List" tile. |
| `detail.css` | A collection's screen: `.det-banner`, `.act-row` list rows, `.composer` quick-add, `.act-card` grid cards, and the `.ad-*` activity detail sheet. |
| `me.css` | The Me tab: the stats card, the progress card, the identity row. |
| `modals.css` | The three presentation styles — `.modal`/`.sheet-*` bottom sheets, `.action-sheet`, `.lightbox` — plus the form controls that live inside a sheet, `.chip-field`, `.photo-*`, and `.toast`. |
| `map.css` | Map containers (the full-bleed `.page-map` and the inset detail map), the CSS sky gradient behind the globe, the floating `.map-filter`/`.map-count`/`.map-fab` chrome, `.map-pin`/`.map-cluster` markers, MapLibre's own controls restyled, and the `.loc-*` autocomplete dropdown. |
| `bulk.css` | `.bulk-*` — the "add many at once" sheet, one card per row. |
| `pwa.css` | The offline banner, install bar, iOS Add-to-Home-Screen sheet. |
| `responsive.css` | Only the two directions away from phone-first: <375px, and ≥700px where the app centres in a column instead of stretching. **Must load last.** |


### JS file map (where to look for what)

**Foundation**

| File | Domain |
| --- | --- |
| `config.js` | `SUPABASE_URL`/`SUPABASE_KEY`, the `sb` client, the `COVERS` array of default Unsplash covers, and `randCover(existingCovers)` (picks a cover the user isn't already using). |
| `state.js` | Every shared mutable global: `currentUser`, the navigation triple (`curTab`, `curPage`, `backTab`), `curListId`, `editingListId`, `editingActId`, `completingId`, `curFilter`, `curView`, `upMedia`, `coverPhoto`, `userProfile`, and the map handles. Other files declare their own feature-local globals next to their code (`aLinks`, `bulkEntries`, `actMap`, `lbPhotos`, `locTimer`). |
| `utils.js` | `$` (getElementById), `esc` (HTML-escape — **use it on every interpolated value**, all rendering is template strings), `cap`, `todayISO`, `fmtDate(s, withYear)` (omits the year when it's the current one, unless `withYear` — a completed date is a record you look back on, so it always carries its year), `dateInfo(a)` (turns a target date like "This Year" into a `{label, cls}` urgency badge), `shakeEl`, `compress`, `confetti`, and the priority pair `priClass`/`priTagHTML` (see **Showing priority**). |
| `icons.js` | `ICON_PATHS`, the app's own inline-SVG glyph set, plus `ICON_FILLED` (glyphs already solid, which must not be stroked) and `icon(name, cls)`. Icons inherit `currentColor`. **Add new glyphs here**, not inline in a template string. |
| `api.js` | **Every Supabase read/write, and the cache in front of them.** `mapCollection`/`mapActivity` translate snake_case columns into the camelCase shapes the UI uses; `normMedia`/`denormMedia` do the same for the two shapes the `photos` column holds. Then `fetchCollections`, `fetchActivitiesFor`, `fetchAllActivities`, `fetchActivity`, `fetchCollection`, `updateCollectionStats`, and the cache: `invalidateCollections`/`invalidateActivities`/`invalidateAll`, `cacheWarm`, `revalidate`. New queries belong here, not inline in a screen file. **See The cache below — every write must invalidate.** |

**Shell and shared UI**

| File | Domain |
| --- | --- |
| `auth.js` | `showAuth`/`showApp` (swap `#authPage` against `#appWrap`; `showApp` boots into Home, loads the profile, triggers the iOS install hint, and starts the token auto-refresh). Also the `visibilitychange` handler that stops/starts auto-refresh — browsers suspend timers in a backgrounded PWA, and without restarting on resume the access token goes stale and the next request 401s, which reads to the user as being logged out — and the `onAuthStateChange` listener that keeps `currentUser` in step and only shows the login screen on a real `SIGNED_OUT`, `toggleAuthMode` (tracked by the `authIsSignUp` flag, not by reading the heading text), `setAuthError`, `handleAuth`, `handleSignOut`. Sign-up also inserts the `Users` profile row. |
| `nav.js` | `nav(page, listId)` — the single entry point for changing screens (see **Screens and navigation**). Plus `PAGE_TAB`, `TAB_ROOT`, `selectTab`, `goBack`, `dismissOverlays`, **`refreshAfterChange(src)`** (the single answer to "something was written, what redraws?" — see **Refreshing after a change**), `updateNavbar` (**where each screen's bar buttons are defined**), `applyNavCondense`, a debounced `resize` handler, and **`setBodyScrollLock(lock)`** — the single place that touches body overflow. |
| `gestures.js` | The two touch gestures, both delegated from `document`: **swipe a sheet down to dismiss it** (`.modal` and the action sheet) and **swipe sideways to change screen**. `overlayOpen`, `ownsHorizontal`/`ownsVertical` (surfaces with their own gesture), `SHEET_DISMISS_PX`/`SHEET_FLICK_PX`, `SWIPE_MIN`/`SWIPE_EDGE`, `TAB_ORDER` (in `nav.js`). See **Gestures** below. |
| `modals.js` | `openModal` (**resets `.sheet-body` scrollTop** — see the note under *Sheets* below) / `closeModal` (they call `setBodyScrollLock`, so use them rather than toggling `.open` yourself), the scrim-click and Escape handlers, **`showActionSheet(opts)`** and `showConfirm` (iOS confirms destructive actions with an action sheet, not a dialog — `confirmDeleteCollection`/`confirmDeleteActivity` wrap it), the photo lightbox (swipe sideways to page, down to close), `ensurePickerRoom`/`releasePickerRoom` (see **Gestures**), and `showToast`. |

**Reusable form widgets**

| File | Domain |
| --- | --- |
| `links.js` | The URL chip input: `aLinks`, `handleTagKey`, `removeTag`, `renderTagChips`. ⚠️ `getChipArr(which)` ignores its argument and always returns `aLinks` — vestigial from when there were two chip fields. Adding a second means fixing this first. |
| `location.js` | `locSearch(input, resultsId)` — debounced (350ms) place search against the public **OpenStreetMap Nominatim** API — plus `positionLocBox` (the bulk sheet's dropdown is `position:fixed` so it can escape the sheet's scroll container, and therefore has to be placed by hand) and `locPick`. |
| `media.js` | Photos **and video**. `probeStorage()`/`storageReady()`, `uploadPhoto`/`uploadVideo` (→ the `media` Supabase Storage bucket), `videoPoster` (grabs a still so thumbnails and map pins have an image), `handleMedia`, `rmMedia`, `mediaTileHTML`, `renderThumbs`, and the ordering set — `coverIndex`, `moveMedia`, `makeCover`, `openMediaMenu`. Working list is the `upMedia` global. Replaced `photos.js`; see **Media** below. |

**Screens and features**

| File | Domain |
| --- | --- |
| `upnext.js` | The Up Next screen pushed from Home: every unfinished activity, bucketed by `targetBand()`. Borrows its rows and sort from `home.js`. |
| `done.js` | The Accomplished screen pushed from Home: everything completed, grouped by the month it was finished. Reuses Home's photo tiles. |
| `home.js` | The Home tab. `renderHome()` plus one function per section, the shared `upNextRowHTML()`/`sortUpNext()` the Up Next screen also uses, the context-free composer (`homeQuickAdd` → `addActivityToList`), and `toggleCompleteFrom()` — Home's copy of the completion toggle, which cannot rely on `curListId`. |
| `collections.js` | `renderCollections()` (the Lists tab) plus the collection CRUD: `openNewList`, `openEditList`, `renderCoverPreview`, `clearCover`, `handleCoverUpload`, `saveList`, `delList`. `delList` deletes the collection's activities first — there is no DB cascade. |
| `detail.js` | One collection. Rendering is **deliberately split in two**: `renderDetail()` builds the banner and the controls, `renderActivitiesList()` rebuilds only the list. Search and filter call the second, so the search field never loses focus mid-typing. Also `activityRowHTML`/`activityCardHTML` and the quick-add composer helpers (`composerHTML`, `onComposerKey`, `focusComposer`). |
| `activities.js` | The two speeds of the activity flow. **Quick:** `quickAddActivity()` (composer → insert with just a name, then refocus) and `toggleComplete(id, isDone)` (one tap; see the note below). **Full:** `openNewActivity`, `openEditAct`, `saveActivity`, `delActivity`, plus `renderActListPicker()` and the `targetListId` global — the List row that lets an activity be filed from outside any collection, and which is hidden when there is no choice to make. Also `setPriorityChoice` (**the only way to set priority** — it keeps the swatched buttons and the hidden `#aPri` value in step), `openComp`/`openCompletedDate`/`confirmComplete`/`setCompMore` — the one completion sheet (see **The two-speed activity flow**) — and `openActDetail` which builds the activity sheet. Plus `openCollectionMenu` (the ⋯ action sheet, which holds the view switcher and everything the old five-button hero row spelled out), `setFilter`, `setView`, `toggleMoreFields`. |
| `me.js` | `renderMe()` (stats), `renderMeIdentity()`, `loadUserProfile()` (reads the `Users` row once per session into `userProfile`), `confirmSignOut()`. |
| `bulk.js` | The "add many at once" sheet, one card per row. Row values live in `bulkEntries[]` and the DOM is re-rendered from it wholesale, so **`saveBulkFieldValues()` must flush the inputs back into the array before any redraw** — every mutation helper does this. `_skipSaveBulk` suppresses that flush in `bulkApplyDown` (the "copy row 1" pills), which has already updated the array itself. |
| `map.js` | All MapLibre GL. `mapStyle()` (raster CARTO basemap + globe projection + sky), `webglOK()`, `actsToGeoJSON()`, and `attachActivityLayer()` — which adds the clustered GeoJSON source and syncs DOM markers (`makePinEl`, `makeClusterEl`) to the viewport. Then the two instances: the Map tab (`renderGlobalMap`, `fitGlobal`, `zoomGlobe`, `globeFillZoom`, `setGlobalMapFilter`) and the per-collection map (`renderMap`, `updateMapMarkers`). Plus `mapLoaded(map)` and `hasGeo`. Teardown is explicit — `destroyGlobalMap()`/`destroyDetailMap()` — because each map holds a WebGL context, but **only the detail map is torn down on navigation**. See **The immersive map** above for the traps. |
| `pwa.js` | Service-worker registration and the install/offline UI: `isStandalone()`/`isIOS()` (which stamp `.standalone`/`.ios` on `<html>`), the `beforeinstallprompt` capture behind `pwaInstall()`, the iOS Add-to-Home-Screen sheet, `pwaShowInstallHelp()` (the Me tab row), and `pwaUpdateOnlineState()`. Dismissals persist in `localStorage` under `bl_*` keys. **It also calls `reg.update()` on foreground and on reconnect** — an installed PWA is rarely killed, and registration is the only moment the browser looks for a new `sw.js`, so without it a shipped fix can sit undelivered on the home-screen copy for days and look like it was never made. |
| `main.js` | Boot: `paintStaticIcons()` fills the empty icon placeholders left in `index.html` from the sprite map, then `restoreSession()` runs and `showApp()`/`showAuth()` follows. **Loads last.** See **Staying signed in** below — `restoreSession()` is deliberately more than one `getSession()` call. |

### The two-speed activity flow

The most important interaction decision in the app, and the reason several
functions look redundant:

- **Adding.** The composer at the end of the list inserts on Return with only a
  name, and keeps focus for the next one. `openNewActivity(prefillName)` is the
  full sheet; the composer's "Details" button hands whatever was typed over to
  it rather than making the user retype.
- **Completing.** Tapping the check opens `openComp()` — **one sheet** holding
  the date, and behind a disclosure the place, the notes, and the photos and
  video. **Nothing is written until Save**, so an accidental tap costs a
  Cancel rather than a wrong date to find later.

  It used to be two sheets: a date-only one that completed the activity, and a
  separate details one you had to go and find afterwards, three taps down
  inside the activity sheet. The moment you tick something off is the moment
  you have the photos, so they belong in the same place.

  **The extras stay collapsed on a fresh completion**, which is what keeps the
  one-tap flow one tap — press the check, press Done. They open themselves
  when the sheet is reopened on something that already has a place, notes or
  media, so editing never hides what is there. Keep that asymmetry if you
  touch `setCompMore()`.

  Un-completing is still immediate: there is nothing to ask. It writes **only
  `date_completed`**, so un-completing never destroys the notes and photos on
  a past completion.

  **The activity sheet reads badges → name → photos → "How it went".** The
  state and date pair acts as the mono eyebrow above a large title, the same
  pairing every screen header uses, and it keeps the name directly above the
  media it names rather than separated from it by two chips. The name is
  centred on a completed activity, to sit under the symmetric full-width pair
  of badges above it; a pending activity's badges are small left-aligned
  chips, so its title stays left. Spacing runs downward from the badges —
  `.ad-badges` has no top margin and `.ad-title` carries the gap.

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

Supabase project `xxdmendegyxlkikejvps`. Three tables, one storage bucket
(`media`, optional — see **Media**), the `send-reminders` Edge Function
(optional), no SQL views. All access is direct PostgREST via `supabase-js`
from `js/api.js`.

| Table | Columns |
| --- | --- |
| `Collections` | `id`, `created_at`, `name`, `description`, `cover_image`, `user_id`, `number_activities`, `activites_completed`, `category_tag` |
| `Activities` | `id`, `created_at`, `collection_id`, `name`, `description`, `target_date`, `priority`, `date_completed`, `experience_notes`, `photos`, `links`, `location`, `location_lat`, `location_lng`, `category_tag`, `remind_at` (see below) |
| `Users` | `id` (= `auth.users.id`), `created_at`, `display_name`, `username`, `icon` |

Schema notes and traps:

- **`Collections.activites_completed` is misspelled in the database** (missing
  the second `i`). `api.js` matches the real column name. Don't "fix" it in code
  without renaming the column.
- **`number_activities` / `activites_completed` are written but never read.**
  `updateCollectionStats()` keeps them current after every mutation, but all
  displayed counts are computed client-side from the fetched activities. They're
  denormalized columns waiting for a use.
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
on all three tables**. `fetchActivitiesFor`/`fetchAllActivities` query by
`collection_id` with no user check and rely entirely on RLS to scope results;
`fetchCollections` filters on `user_id` client-side, which is not a security
boundary. Confirm RLS policies before treating any of this as private.

## PWA / installability

The app installs to an iPhone home screen and runs chrome-less and offline.
Four pieces make that work, and all four must stay in sync:

1. **`manifest.webmanifest`** — `display: standalone`, `start_url: ./index.html`,
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
- **The nav bar has its own inset, `--nav-inset`,** floored at 14px. In an
  installed PWA the notch inset already provides room; in a browser tab
  `safe-area-inset-top` is 0 and the back button ended up pinned against the
  viewport edge. Only pushed screens (`.page-pushed`) pad down to match — root
  tabs keep the tighter offset, since their bar is empty until you scroll and
  padding it out just puts dead space above the title.
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
6. Add `if(page==='yourpage') renderYourPage();` to `nav()`.
7. Add both new files to `SHELL_ASSETS` in `sw.js` and bump `CACHE_VERSION`.
8. **Update this file** — File structure, the CSS/JS file maps, and the
   Screens table.

## Known issues / cleanup backlog

- **Rows written before the `media` bucket existed still carry base64
  photos.** They render fine, and are converted only if that activity's media
  happens to be edited. A one-off backfill that uploads them and rewrites the
  column would shrink the table considerably; nothing does it automatically.
- **Reordering media is drag-only.** There is no keyboard or
  assistive-technology path to it, and the tiles are not focusable. The button
  menu it replaced was reachable; this is not. A long-press menu as a fallback
  would fix it without giving the gesture up.
- **Deleted media is not removed from Storage** — only its URL is dropped from
  the row. See the sweeper query at the bottom of `supabase/storage.sql`.
- **The cache is invalidated by hand.** Every mutation site calls
  `invalidateActivities()`/`invalidateCollections()` and nothing enforces it; a
  new write path that forgets will render stale rows. Wrapping the writes so
  invalidation cannot be skipped is the real fix.
- **Mutations re-render from the cache, but there are no optimistic updates.**
  A quick-add still waits for the insert and the stats update before the row
  appears — one round trip now rather than several, but not instant.
- **`getChipArr(which)` ignores its parameter** (see `links.js` above).
- **No URL/route state.** Reloading always returns to the Lists tab; a
  collection can't be linked to, and there is no browser-back integration —
  the `goBack()` chevron is the only way out of a pushed screen.
- **Offline is read-nothing, not read-cached.** The shell loads offline but
  Supabase responses are deliberately never cached, so an offline launch shows
  empty lists plus the offline banner. Caching last-seen rows in IndexedDB and
  queueing writes is the next step if genuine offline use matters.
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
- **`Users.icon` and `category_tag` (both tables) remain unused.**
- **The map needs WebGL.** There is no 2D fallback — `webglOK()` shows a
  message instead. In practice every browser that can run the rest of the app
  has it, but it is a hard dependency where Leaflet was not.
- **`GLOBE_PX_AT_Z0` in `map.js` is an empirical constant** (measured, not
  derived from MapLibre's projection maths). If a future MapLibre changes how
  the globe is sized, `globeFillZoom()` will be slightly off and the globe will
  open a little too large or too small.
- **Home and the detail screen duplicate two flows.** `addActivityToList()` /
  `quickAddActivity()` and `toggleCompleteFrom()` / `toggleComplete()` do the
  same work against different assumptions about `curListId`. Folding them into
  one pair that always takes an explicit collection id would be a good tidy-up.
- **Home still re-renders in full after a quick add or a completion toggle.**
  It reads from the cache rather than the network now, so the cost is a
  re-render rather than two round trips, but it is still more work than
  patching the single row that changed.
