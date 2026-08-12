# Bucket List

A single-page web app for curating and tracking bucket-list collections, backed
by Supabase. It installs to a phone home screen as a PWA and is laid out for
screens from 320px up.

## Running it

There is no build step. Serve the folder with any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk mostly works, but a real server is
recommended so Supabase auth and the map tiles behave normally. The service
worker only registers over `https://` or `localhost` — everything else still
works without it, just with no offline support.

## Installing it on an iPhone

The app has to be served over HTTPS from a real domain for iOS to offer the
install (localhost works for testing on the Mac, but not from the phone).
Once it is:

1. Open the site in **Safari** — Chrome and Firefox on iOS cannot install PWAs.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Launch it from the home screen. It opens full screen with no browser chrome.

Signing in inside the app pops a one-time hint walking through those steps.
On Android/desktop Chrome an **Install** bar appears instead, driven by the
`beforeinstallprompt` event.

Once installed, the app shell (HTML/CSS/JS/icons/fonts/MapLibre) is cached and
launches offline. Your collections come from Supabase, so they need a
connection — an offline launch shows the UI with an "Offline" banner.

## Project structure

```
index.html            markup only — screens, sheets, and the <link>/<script> manifest
manifest.webmanifest  PWA metadata (name, icons, standalone display, theme color)
sw.js                 service worker — offline app shell + runtime caching
css/                  one stylesheet per concern
js/                   one script per concern
icons/                app icon PNGs, plus generate.py which draws them
Supabase Setup/       CSV exports of the Collections / Activities / Users tables
_backup/              previous versions, kept for reference
```

## How it's put together

The interface has **iOS bones and its own voice** — UIKit structure (bottom tab
bar, collapsing large titles, bottom sheets, action sheets) wearing a warm
parchment/olive/terracotta palette with full dark mode. Three typefaces, each
with one job: Cormorant Garamond for display, the system stack for UI chrome,
IBM Plex Mono for the small-caps labels.

Four tabs, plus one screen that pushes on top of the second:

| Tab | Screen | What's there |
| --- | --- | --- |
| **Home** | `page-home` | Dashboard: progress ring, quick add, Up Next, recently accomplished, your lists. |
| **Lists** | `page-lists` | Every collection as a photo card. Tapping one pushes `page-detail`. |
| **Map** | `page-globalmap` | A full-screen map of everywhere you're going. |
| **You** | `page-me` | Profile, install, sign out. |

Three things are deliberately quick:

- **Adding, from anywhere.** Home has a composer that needs no list: type a
  name, press return, and pick which list it belongs to (skipped entirely if
  you only have one). Inside a list, the composer at the end of the activities
  files it straight away and keeps the caret for the next one.
- **Completing.** Tap the circle beside an activity. That's it — no dialog.
  Tapping again un-completes it, and *doesn't* discard the photos and notes
  from the earlier completion. Attaching those is a separate, optional step.
- **Finding.** The Map tab is a WebGL globe. Zoomed out you get the Earth as a
  sphere; it eases into a flat map as you zoom in. The map fills the screen and
  its controls float on top, rather than sitting in a box on a page.

The primary **add** button floats at the bottom right, above the tab bar, on
every screen where adding makes sense — within thumb reach rather than in the
top corner.

### Stylesheets

Loaded in the order below; **order matters**.

| File | Contains |
| --- | --- |
| `base.css` | Design tokens: the three type faces, the warm palette (light + dark), the shadow scale, layout metrics, safe-area insets, the type scale, reset, keyframes. Re-theming the app is this one file. |
| `layout.css` | The app shell: navigation bar, collapsing large title, bottom tab bar, the page show/hide system. |
| `components.css` | Reusable iOS primitives: grouped lists, segmented controls, buttons, search field, badges, empty states. Check here before writing a new component. |
| `auth.css` | The signed-out sign-in / create-account screen. |
| `home.css` | The Home dashboard: progress ring, quick add, Up Next, the recently-accomplished and lists shelves. |
| `collections.css` | The Lists tab — collection photo cards. |
| `detail.css` | One collection: banner, activity rows, quick-add composer, grid cards, activity sheet. |
| `me.css` | The Me tab. |
| `modals.css` | Bottom sheets, action sheets, form controls, photo lightbox, toast. |
| `map.css` | Map containers, the sky gradient behind the globe, floating controls, pins, clusters, location autocomplete. |
| `bulk.css` | The "add many at once" sheet. |
| `pwa.css` | Install prompts, iOS Add-to-Home-Screen sheet, offline banner. |
| `responsive.css` | Small phones, and ≥700px where the app centres in a column. **Must load last.** |

### Scripts

These are plain (non-module) scripts, so they all share one global scope.
That is deliberate: the markup uses inline `onclick="..."` handlers, and those
can only reach functions that are global. Load order follows the dependency
chain below.

**Foundation**

| File | Contains |
| --- | --- |
| `config.js` | Supabase URL/key, the `sb` client, default cover images. |
| `state.js` | Mutable globals: current user, current tab/screen, filters, view mode, live map handles. |
| `utils.js` | `$`, `esc`, `fmtDate`, `dateInfo` (target-date urgency), image `compress`, `confetti`. |
| `icons.js` | The app's own inline-SVG icon set, and the `icon()` helper. |
| `api.js` | Every Supabase read/write. Row mappers translate snake_case columns to the camelCase shapes the UI uses. |

**Shell and shared UI**

| File | Contains |
| --- | --- |
| `auth.js` | Sign in / sign up / sign out and the auth screen. |
| `nav.js` | `nav()` — the single entry point for changing screens. Also the tab bar, the nav bar contents, the scroll-collapse behaviour, and the body scroll lock. |
| `modals.js` | Sheet open/close, action sheets (used for menus and destructive confirms), photo lightbox, toast. |

**Reusable form widgets**

| File | Contains |
| --- | --- |
| `links.js` | The URL chip input. |
| `location.js` | Debounced place search against OpenStreetMap Nominatim. |
| `photos.js` | Completion photo upload, compression, previews. |

**Screens and features**

| File | Contains |
| --- | --- |
| `home.js` | The Home dashboard, and the quick-add that files an activity into a chosen list. |
| `collections.js` | The Lists tab plus create/edit/delete a collection. |
| `detail.js` | One collection: banner, filter, the activity list/grid/map switch, the composer. |
| `activities.js` | Quick add, one-tap complete, the full activity sheet, completion details, the ⋯ menu. |
| `me.js` | The Me tab. |
| `bulk.js` | The "add many at once" sheet. |
| `map.js` | MapLibre GL: the globe on the Map tab, the flat per-collection map, clustering and pins. |
| `pwa.js` | Registers the service worker; drives install prompts, offline banner, update toast. |
| `main.js` | Boot: paints the static icons, restores the session, shows the app or the auth screen. **Loads last.** |

`sw.js` is the exception to all of the above: it is a service worker, runs in
its own scope, shares none of these globals, and must stay at the project root.

## Adding a new screen

1. Add the markup as `<div class="page" id="page-yourpage">` in `index.html`.
2. Either add a tab button to `.tabbar` (and a `PAGE_TAB` entry plus a
   `selectTab()` case in `js/nav.js`), or make it a pushed screen with a back
   button in `updateNavbar()`.
3. Create `css/yourpage.css` and link it *before* `responsive.css`.
4. Create `js/yourpage.js` with a `renderYourPage()` function and add a
   `if(page==='yourpage') renderYourPage();` line to `nav()` in `js/nav.js`.
5. Add both new files to `SHELL_ASSETS` in `sw.js` and bump `CACHE_VERSION`,
   or they will not be available offline.

See `CLAUDE.md` for the detailed layout rules and the design-language notes.
