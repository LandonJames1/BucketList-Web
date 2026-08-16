/* ==============================================================
   unfurl — turn a shared link OR a screenshot into draft activities.

   Two ways in, one response shape:

     {url, text?}          a link. The browser cannot read any of the
                           platforms below itself — CORS blocks every
                           one — so the fetch happens here.
     {image, mediaType}    a screenshot. Read by Claude's vision.

   ---- Why the screenshot path exists ----

   It is the answer to Instagram, and to everything else like it.
   Instagram serves a login wall with zero OpenGraph tags to any
   unauthenticated fetch; the old public oEmbed died in 2020 and the
   official one needs a Meta app with oembed_read App Review. The
   alternatives are a paid scraper that violates their terms and
   breaks periodically, or a native iOS Share Extension, which a PWA
   cannot register.

   A screenshot sidesteps all of it. The user already has the post on
   screen; the phone already has a screenshot button. Nothing is
   scraped, no terms are violated, and it works on any source at all —
   a Reel, a Safari page, a Google Maps pin, a friend's text message,
   a printed page photographed. That generality is the point: the link
   path knows five platforms, the screenshot path knows none and
   therefore handles everything.

   ---- The link path ----

   Three stages, and each one degrades rather than failing:

     1. metadata  — oEmbed where a public endpoint exists, OpenGraph
                    tags otherwise. Instagram has neither (see below).
     2. structure — Claude turns a caption into {name, location}, and
                    fans a listicle out into many. Without
                    ANTHROPIC_API_KEY it falls back to the raw title.
     3. geocode   — the place name becomes lat/lng via Nominatim, the
                    same service js/location.js already uses, so an
                    imported activity lands on the map.

   Deploy:
     supabase functions deploy unfurl

   Secret it needs (see supabase/README.md):
     ANTHROPIC_API_KEY

   Auth: this runs with Supabase's default JWT verification, so only a
   signed-in user can call it. Do NOT deploy with --no-verify-jwt —
   without a caller check this is an open fetch proxy for the internet.
   ============================================================== */

import Anthropic from 'npm:@anthropic-ai/sdk@0.70.0';

/* The app is served from a different origin than the function, so every
   response needs CORS headers and OPTIONS has to be answered. */
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

/* A browser UA. Several sites serve a stripped page or a 403 to
   anything that looks automated, and OpenGraph tags are the first
   thing they drop. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ==============================================================
   SSRF GUARD

   The caller controls the URL and we fetch it from inside Supabase's
   network, so an unguarded fetch would happily read cloud metadata
   endpoints and anything else reachable from there. Only http(s), and
   never an address that resolves inside a private range.
   ============================================================== */
function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||              /* link-local: cloud metadata */
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)       /* carrier-grade NAT */
  );
}

function safeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (privateHost(u.hostname)) return null;
  return u;
}

/* ==============================================================
   STAGE 1 — METADATA

   Verified by hand against each platform:
     TikTok   public oEmbed, no auth, caption arrives as `title`
     X        publish.twitter.com/oembed, 301 → must follow redirects
     YouTube  public oEmbed
     Instagram   login wall, zero OG tags to an unauthenticated fetch.
                 Official access needs a Meta app with oembed_read App
                 Review. Reported as degraded so the client can ask the
                 user to paste the caption instead.
   ============================================================== */
type Meta = {
  title: string;
  description: string;
  image: string;
  author: string;
  site: string;
  degraded?: string;
};

const EMPTY: Meta = { title: '', description: '', image: '', author: '', site: '' };

async function oembed(endpoint: string, target: string): Promise<Meta | null> {
  try {
    const res = await fetch(`${endpoint}${encodeURIComponent(target)}`, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      ...EMPTY,
      title: stripTags(d.title || ''),
      /* X returns the tweet body as HTML inside `html` rather than as a
         title, so that is where the actual text lives. */
      description: stripTags(d.html || ''),
      image: d.thumbnail_url || '',
      author: d.author_name || '',
      site: d.provider_name || '',
    };
  } catch { return null; }
}

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ogTag(html: string, prop: string): string {
  /* property= and name= both appear in the wild, in either attribute
     order, so match the pair rather than assuming a layout. */
  const pat = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(pat)?.[0];
  if (!tag) return '';
  /* Match the opening quote and back-reference it. A character class
     excluding both quote styles truncates at the first apostrophe in a
     double-quoted value — "World's largest salt flat" came back as
     "World" — and apostrophes are extremely common in descriptions. */
  return stripTags(tag.match(/content=(["'])([\s\S]*?)\1/i)?.[2] || '');
}

async function fetchMeta(u: URL): Promise<Meta> {
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  if (host.endsWith('tiktok.com')) {
    return (await oembed('https://www.tiktok.com/oembed?url=', u.href)) ??
      { ...EMPTY, degraded: 'tiktok' };
  }
  if (host === 'x.com' || host.endsWith('.x.com') || host.endsWith('twitter.com')) {
    return (await oembed('https://publish.twitter.com/oembed?url=', u.href)) ??
      { ...EMPTY, degraded: 'x' };
  }
  if (host.endsWith('youtube.com') || host === 'youtu.be') {
    return (await oembed('https://www.youtube.com/oembed?format=json&url=', u.href)) ??
      { ...EMPTY, degraded: 'youtube' };
  }
  if (host.endsWith('instagram.com')) {
    /* Not a bug to fix here — there is no unauthenticated path. */
    return { ...EMPTY, degraded: 'instagram' };
  }

  try {
    const res = await fetch(u.href, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      redirect: 'follow',
    });
    if (!res.ok) return { ...EMPTY, degraded: `http_${res.status}` };
    /* Read a bounded prefix: the tags are in <head>, and some pages are
       tens of megabytes of app payload after it. */
    const html = (await res.text()).slice(0, 400_000);
    return {
      ...EMPTY,
      title: ogTag(html, 'og:title') || stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
      description: ogTag(html, 'og:description') || ogTag(html, 'description'),
      image: ogTag(html, 'og:image'),
      site: ogTag(html, 'og:site_name') || host,
    };
  } catch {
    return { ...EMPTY, degraded: 'fetch_failed' };
  }
}

/* ==============================================================
   STAGE 2 — STRUCTURE

   A caption is not an activity name. "📍Hidden gem in Kyoto — go to
   Fushimi Inari at 6am to beat the crowds #japan" should become
   "Visit Fushimi Inari at sunrise", not land verbatim in the name
   field. A post listing ten places should become ten activities.

   Structured outputs (output_config.format) guarantee the response
   parses, so there is no repair path to write here.
   ============================================================== */
const SCHEMA = {
  type: 'object',
  properties: {
    activities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The general activity, as a short imperative of 3-8 words, e.g. "Buy and learn to fly a used paraglider". ' +
              'Generalise away from the specific instance in the source: no prices, brands, marketplaces or handles.',
          },
          location: {
            type: 'string',
            description:
              'Geocodable place name, e.g. "Fushimi Inari Taisha, Kyoto, Japan". Empty string if the source names no place. ' +
              'Only when the activity is tied to that place; leave empty for something doable anywhere. ' +
              'Read it from the source — never infer one from an association, and never a whole country.',
          },
        },
        required: ['name', 'location'],
        additionalProperties: false,
      },
    },
  },
  required: ['activities'],
  additionalProperties: false,
} as const;

/* One model constant rather than a literal at each call site, so the
   cost/latency of an import is changed in one place. Both paths use
   the same model: a screenshot is the higher-volume route and the one
   where a misread costs the user the most to correct. */
const MODEL = 'claude-opus-5';

/* The location guess is a different job from an import and gets its own
   constant. An import reads a page or a screenshot and writes a row the
   user reviews; this answers one closed question ("does this name identify
   one specific place?") against a two-field schema, behind three more
   gates — the `certain` flag, Nominatim finding it, and guessMatchesName()
   on the client. It is also the latency the user actually feels, because
   it runs while they are still filling in the sheet.
   ⚠️ If the guess is still too slow, THIS is the lever: 'claude-haiku-4-5'
   is a fraction of the latency and cost for a constrained classification
   like this one. It is left on the same model as the imports because
   swapping it trades some strictness for speed, and strictness is the
   whole feature — see the four gates in CLAUDE.md. Change it here, in one
   place, and re-run the worked examples in PLACE_SYSTEM. */
const PLACE_MODEL = 'claude-opus-5';

const SYSTEM = `You turn a shared social post or web page into bucket-list activities.

Return one activity when the source is about a single place or experience, and
one per place when it lists several.

Write it as the user's own plan, in their voice — never as a report on the
source. They already know where they found it, so never open with "The video…",
"This post…", "A photo of…" or the creator's handle.

BE GENERAL AND BE SHORT. Capture the IDEA, not the specific instance someone
happened to post. Strip prices, brands, marketplaces, handles, and the creator's
particular circumstances — those belong to their story, not the user's plan.

  SOURCE  "POV: you & the boys bought a $600 paraglider off Facebook Marketplace"
  GOOD    "Buy and learn to fly a used paraglider"
  BAD     "Buy a $600 secondhand paraglider on Facebook Marketplace"

- name: what the user would DO, as a short imperative of 3–8 words. No hashtags,
  emoji, handles, prices, brands or clickbait.
- location: a specific, geocodable place. Use "" if the source names no place,
  or if the activity could be done anywhere. Never invent one.
There is nowhere else to put anything. The name and the location are the whole
of an activity, so a detail that fits neither is dropped rather than squeezed
into the name — prices, gear, technique, weather, time of day, and anything you
inferred. When in doubt, leave it out.

If the source is not about a place or experience at all, return an empty list.`;

type Draft = { name: string; location: string };

async function structure(meta: Meta, url: string, extra: string): Promise<Draft[]> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  const raw = [meta.title, meta.description, extra].filter(Boolean).join('\n\n').trim();

  /* No key, or nothing to read: fall back to the bare title rather than
     returning nothing. The user gets a prefilled sheet either way. */
  if (!key || !raw) {
    return meta.title ? [{ name: meta.title.slice(0, 120), location: '' }] : [];
  }

  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM,
      /* Extraction is not a hard reasoning task; medium keeps the cost
         and latency of an import down. */
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content:
          `Source URL: ${url}\n` +
          (meta.site ? `Site: ${meta.site}\n` : '') +
          (meta.author ? `Author: ${meta.author}\n` : '') +
          `\n${raw}`,
      }],
    });

    /* Structured outputs guarantee the first text block is valid JSON
       matching SCHEMA — but a refusal stops before any content, so
       check before indexing. */
    if (res.stop_reason === 'refusal') return [];
    const text = res.content.find((b: any) => b.type === 'text');
    if (!text) return [];
    const parsed = JSON.parse((text as any).text);
    return Array.isArray(parsed.activities) ? parsed.activities.slice(0, 20) : [];
  } catch (e) {
    console.error('structure:', e);
    return meta.title ? [{ name: meta.title.slice(0, 120), location: '' }] : [];
  }
}

/* ==============================================================
   THE SCREENSHOT PATH

   Same schema out, so the client renders the result with the code it
   already has. What differs is the instruction: a screenshot has no
   title or summary text to lean on, and a lot of what is on
   screen is chrome — like counts, comment threads, tab bars, the
   status bar — that must not end up in an activity name.

   The prompt names the sources it will actually be handed, because
   the failure mode without that is a model dutifully describing the
   screenshot ("A photo of a waterfall posted by @user") instead of
   extracting the plan inside it ("Swim at Havasu Falls").
   ============================================================== */
const IMAGE_SYSTEM = `You read a screenshot and turn what it shows into bucket-list activities.

The screenshot is usually one of: an Instagram/TikTok post or Reel, a web page or
article, a Google Maps pin, a restaurant or hotel listing, a note or message, or
a photo of printed text.

## Write it as the user's own plan, not as a report on the image

You are writing an entry in someone's own bucket list, in their voice. Never
describe the screenshot, the video, the poster or the platform. The reader
already knows where they found it. Never open with "The video…", "This post…",
"A photo of…", "Learn about…", "Discover…", or the creator's handle.

## Be general, and be short

This is the rule that matters most, and the one most easily got wrong.

Capture the IDEA, not the particular instance someone happened to post. The
user wants a reminder of a thing they'd like to do — not a transcript of
somebody else's afternoon. Aggressively drop:

- prices and numbers ("$600", "€90 tandem flight")
- brands, shops and marketplaces ("off Facebook Marketplace", "at REI")
- named creators, handles and their friends ("you & the boys")
- specific technique, gear and conditions ("practice ground-handling",
  "calm evening air", "on open rolling hills")
- anything you inferred rather than read. Never elaborate, never advise,
  never add a how-to the source did not contain.

Worked example — this is the exact level of abstraction wanted:

  SOURCE  "POV: You & the boys bought a $600 paraglider off Facebook Marketplace"
  GOOD    "Buy and learn to fly a used paraglider"
  BAD     "Buy a $600 secondhand paraglider on Facebook Marketplace"
  BAD     name + "~$600 secondhand wing · practice ground-handling on open
          rolling hills · calm evening/sunset air"

More:

  SOURCE  a reel of a turquoise cenote captioned with a Tulum geotag
  GOOD    "Swim in a cenote near Tulum"
  BAD     "Swim in the crystal-clear turquoise waters of a hidden cenote"

  SOURCE  a TikTok explaining a sourdough starter over 7 days
  GOOD    "Make sourdough bread from my own starter"
  BAD     "Make sourdough with a 7-day 100% hydration rye starter"

If you are unsure whether a detail belongs, it does not. Shorter and vaguer is
always the safer mistake here.

## Fields

- name: what they would DO, as a short imperative — 3 to 8 words. No hashtags,
  emoji, handles, prices, brands, clickbait or trailing punctuation.
- location: a specific, geocodable place — venue, city, country as available.
  Read it from signage, map labels, geotags, captions or an address block. Use
  "" if nothing on screen names a place, or if the activity could be done
  anywhere. Never invent one.
The name should carry the whole idea on its own, because there is nowhere else
for anything to go: an activity is a name and a place and nothing more. A detail
that fits neither is dropped, not squeezed into the name — prices, gear,
technique, weather, time of day, and anything inferred.

## How many

One activity per distinct place or experience. A listicle or a carousel of
several places becomes several activities; one post about one place becomes one.

## Ignore the interface

Status bars, like/comment/share counts, nav bars, ads, cookie banners,
"suggested for you" rails, and comment threads that are not about the place.

If the screenshot shows nothing that could be an activity — a chat about nothing
in particular, a settings screen, a meme — return an empty list.`;

/* Claude accepts images up to 5MB base64. The client downscales to
   1568px on the long edge before sending, which lands far under it;
   this is the backstop for a caller that did not. */
const MAX_IMAGE_B64 = 4_500_000;

async function structureFromImage(
  b64: string, mediaType: string, extra: string,
): Promise<{ drafts: Draft[]; error?: string }> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  /* Unlike the link path there is no fallback here — without a model
     there is nothing that can read an image, and saying so lets the
     client offer to add it by hand instead of showing an empty sheet. */
  if (!key) return { drafts: [], error: 'no_model' };
  if (b64.length > MAX_IMAGE_B64) return { drafts: [], error: 'too_large' };

  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: IMAGE_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          /* Anything the user typed alongside the screenshot — the
             caption they pasted, or a note about what they meant. */
          { type: 'text', text: extra ? `Extra context from the user:\n${extra}` : 'Extract the activities.' },
        ],
      }],
    });

    if (res.stop_reason === 'refusal') return { drafts: [], error: 'refused' };
    const text = res.content.find((b: any) => b.type === 'text');
    if (!text) return { drafts: [] };
    const parsed = JSON.parse((text as any).text);
    return { drafts: Array.isArray(parsed.activities) ? parsed.activities.slice(0, 20) : [] };
  } catch (e) {
    console.error('structureFromImage:', e);
    return { drafts: [], error: 'failed' };
  }
}

/* Only the formats every phone screenshot actually is. An unchecked
   media_type is passed straight to the model and 400s there instead
   of here, with a worse message. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/* ==============================================================
   PREDICTING A LOCATION FROM A NAME

   The third way in, and the smallest: `{activity:{name}}` comes back
   as `{location,lat,lng}` or as nothing at all.

   It exists because an activity with no location never appears on the
   map, and typing one in is the step everybody skips. But most
   activity names do not name a place, and the failure this has to
   avoid is worse than the gap it fills: a place written into a record
   on a guess is a wrong fact the user will believe later, and they
   will not remember that a model put it there.

   So the bar is not "can you think of somewhere plausible" — a model
   asked that will always answer. It is: **does the name itself
   identify one specific place, such that any reader would agree?**

     "Go on a hike"              → nothing. Anywhere on earth.
     "Go to Arches National Park" → Arches National Park, Utah, USA.

   Three gates, and all three have to pass:

     1. the model says so, under the prompt below;
     2. it sets `certain`, which the prompt defines narrowly;
     3. Nominatim can actually find the place. Somewhere the map
        cannot plot is worthless here — putting the activity on the
        map is the entire reason to guess.

   A fourth gate lives on the client, in js/location.js: the predicted
   place has to share a word with the activity name. That is what
   stops an invented answer, and it is on the client because it is
   cheap, needs no model, and belongs next to the code that writes
   the value into the field.
   ============================================================== */
const PLACE_SCHEMA = {
  type: 'object',
  properties: {
    place: {
      type: 'string',
      description:
        'A specific, geocodable place named by the activity itself — "Arches National Park, Utah, USA". ' +
        'Empty string unless the activity plainly identifies one particular place.',
    },
    certain: {
      type: 'boolean',
      description:
        'True only when the activity names one specific place that could not reasonably be anywhere else. ' +
        'False for anything general, anything with several plausible answers, and anything you inferred.',
    },
  },
  required: ['place', 'certain'],
  additionalProperties: false,
} as const;

const PLACE_SYSTEM = `You are given the name of an item on someone's bucket list. Decide whether that
name identifies ONE specific, real, findable place — and if it does, name it.

Almost always the answer is no. Return {"place": "", "certain": false} unless you
are sure. A wrong guess is written silently into someone's records and believed
later; a missing guess costs them one search box. These are not close to equal,
so refuse whenever there is any doubt at all.

## Say yes only when the NAME ITSELF names the place

- A named landmark, park, building, trail, restaurant, museum, mountain, island,
  venue or event with one well-known location.
- A named city, region or country, when the activity is about being there.

## Say no to everything else. In particular:

- Generic activities: "Go on a hike", "Learn to surf", "See the sunrise",
  "Take a hot air balloon ride", "Go skydiving". These happen in a thousand
  places and the user has not said which.
- Categories of place: "Visit a vineyard", "Stay in an overwater bungalow",
  "Eat at a Michelin-starred restaurant".
- Ambiguous names with several real answers: "Visit Springfield",
  "See the cathedral", "Go to Portland".
- Anything where you are reasoning from an association rather than reading a
  name. "See the Northern Lights" is not Tromsø. "Run a marathon" is not
  Boston. "Try authentic ramen" is not Tokyo.
- Activities about a person, an object or a skill rather than a place:
  "Learn Spanish", "Read Ulysses", "Meet my hero".

## Worked examples

  "Go on a hike"                        → {"place": "", "certain": false}
  "Go to Arches National Park"          → {"place": "Arches National Park, Utah, USA", "certain": true}
  "Hike the Inca Trail to Machu Picchu" → {"place": "Machu Picchu, Peru", "certain": true}
  "Eat at Noma"                         → {"place": "Noma, Copenhagen, Denmark", "certain": true}
  "See a Broadway show"                 → {"place": "", "certain": false}
  "Watch the sunset from Santorini"     → {"place": "Santorini, Greece", "certain": true}
  "Swim with sharks"                    → {"place": "", "certain": false}
  "Visit the Louvre"                    → {"place": "Musée du Louvre, Paris, France", "certain": true}
  "Take a cooking class in Italy"       → {"place": "", "certain": false}

That last one is the line worth studying. Italy is named, but "in Italy" is
where the activity happens, not a place to put a pin — a whole country is not a
location. Say no to anything larger than a city unless the activity is about
visiting that country as such.

Write the place as a geocoder would want it: the specific name first, then the
city or region, then the country. Never a street address.`;

async function predictPlace(
  name: string,
): Promise<{ location: string; lat: number | null; lng: number | null }> {
  const empty = { location: '', lat: null, lng: null };
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  /* No key means no prediction and no error: the client treats an empty
     answer and a missing backend identically, because the user-visible
     result is the same — the field is left for them to fill in. */
  if (!key || name.trim().length < 3) return empty;

  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: PLACE_MODEL,
      /* The answer is a place string and a boolean. 1024 was room this
         call has never needed, and a smaller ceiling is one less thing
         between the user and the field being filled. */
      max_tokens: 256,
      system: PLACE_SYSTEM,
      /* `low` rather than `medium`. The prompt does the work here — the
         rules and the worked examples decide the answer, not depth of
         deliberation — and this is the one model call in the app that
         runs while somebody is watching an empty field. If recall drops
         on names that plainly do identify a place, raise this before
         touching the prompt. */
      output_config: { effort: 'low', format: { type: 'json_schema', schema: PLACE_SCHEMA } },
      messages: [{
        role: 'user',
        content: `Activity: ${name.trim()}`,
      }],
    });

    if (res.stop_reason === 'refusal') return empty;
    const text = res.content.find((b: any) => b.type === 'text');
    if (!text) return empty;
    const parsed = JSON.parse((text as any).text);
    /* `certain` is the gate, not a score to weigh: the prompt defines
       when it is allowed to be true, and anything less than true is a
       no. */
    if (!parsed.certain || !parsed.place) return empty;

    /* Gate three. A place the geocoder cannot find cannot go on the
       map, which is the only reason to have guessed it. */
    const geo = await geocode(parsed.place);
    if (!geo) return empty;
    return { location: parsed.place, lat: geo.lat, lng: geo.lng };
  } catch (e) {
    console.error('predictPlace:', e);
    return empty;
  }
}

/* ==============================================================
   STAGE 3 — GEOCODE

   Same public Nominatim endpoint js/location.js uses, so an imported
   activity gets the location_lat/location_lng the Map tab needs
   without the user opening the location picker.
   ============================================================== */
async function geocode(place: string): Promise<{ lat: number; lng: number } | null> {
  if (!place) return null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'BucketList/1.0', 'Accept-Language': 'en' } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.length) return null;
    return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch { return null; }
}

/* ============================================================== */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: {
    url?: string; text?: string; image?: string; mediaType?: string;
    activity?: { name?: string };
  };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  /* ---- Predict a location from an activity name ----
     Checked first because it is the cheapest branch and shares none of
     the plumbing below: no URL to guard, no image to size, no drafts to
     geocode in bulk. See predictPlace. */
  if (body.activity) {
    return json(await predictPlace((body.activity.name || '').slice(0, 200)));
  }

  /* ---- Screenshot ----
     Checked before the URL, so a caller can send both (an image plus
     the page it came from) and have the image win — it is the richer
     source and the one the user actually looked at. */
  if (body.image) {
    const mediaType = (body.mediaType || 'image/jpeg').toLowerCase();
    if (!IMAGE_TYPES.has(mediaType)) return json({ error: 'unsupported image type' }, 400);
    /* Accept a bare base64 payload or a full data: URL, so the client
       can send whatever its canvas handed it. */
    const b64 = body.image.includes(',') ? body.image.slice(body.image.indexOf(',') + 1) : body.image;

    const { drafts, error } = await structureFromImage(b64, mediaType, (body.text || '').trim());
    const located = await Promise.all(drafts.map(async (d) => {
      const geo = await geocode(d.location);
      return { ...d, lat: geo?.lat ?? null, lng: geo?.lng ?? null };
    }));
    return json({
      activities: located,
      cover: '',
      source: '',
      site: 'screenshot',
      /* Reuses the same field the link path uses for "this worked, but
         not well" — the client already knows how to offer an escape
         hatch when it is set. */
      degraded: error ?? null,
    });
  }

  const url = safeUrl((body.url || '').trim());
  if (!url) return json({ error: 'unsupported or unsafe url' }, 400);

  const meta = await fetchMeta(url);
  /* `text` is the caption the user pasted by hand — the Instagram
     escape hatch, and useful anywhere the page gave us little. */
  const drafts = await structure(meta, url.href, (body.text || '').trim());

  /* Geocode in parallel; a place that cannot be found just arrives
     without coordinates rather than holding up the whole import. */
  const located = await Promise.all(drafts.map(async (d) => {
    const geo = await geocode(d.location);
    return { ...d, lat: geo?.lat ?? null, lng: geo?.lng ?? null };
  }));

  return json({
    activities: located,
    cover: meta.image || '',
    source: url.href,
    site: meta.site,
    degraded: meta.degraded ?? null,
  });
});
