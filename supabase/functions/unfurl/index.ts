/* ==============================================================
   unfurl — read an activity's name.

   One way in, one response shape:

     {activity:{name, home, profile, examples}}
                               ->  {location, lat, lng, difficulty}

   Two independent answers about one short string, sharing one round
   trip because neither is worth a call of its own:

     WHERE is it    — a strict, usually-silent guess, so an activity can
                      land on the map without the user opening the
                      location picker.
     HOW HARD is it — easy / medium / hard, judged against the user's
                      own home address, the paragraph they wrote about
                      themselves, and a tier-balanced sample of the
                      activities they have already had rated. This is
                      also what files the activity into one of the
                      three smart lists; see "Three lists nobody
                      edits" in CLAUDE.md.

   ---- It used to do more ----

   This function was the link-and-screenshot importer: share a TikTok
   or photograph anything, get a filled-in draft activity. That whole
   feature is gone from the app — along with js/share.js, js/bulk.js
   and their sheets — and everything it needed went with it: the SSRF
   guard, the oEmbed and OpenGraph readers, the listicle fan-out and
   the vision path.

   **The name is deliberately unchanged.** It is what js/location.js
   invokes and what is already deployed; renaming it would mean a
   deploy under a new name plus a delete of the old, to fix a word.

   Deploy:
     supabase functions deploy unfurl

   Secret it needs (see supabase/README.md):
     ANTHROPIC_API_KEY

   Auth: this runs with Supabase's default JWT verification, so only a
   signed-in user can call it. Do NOT deploy with --no-verify-jwt — it
   spends model calls and a geocoder quota on whoever asks.
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
/* ==============================================================
   READING AN ACTIVITY NAME

   The third way in, and the smallest: `{activity:{name,home}}` comes
   back as `{location,lat,lng,difficulty}`.

   Two independent jobs share one round trip, because both are read off
   the same short string and neither is worth a call of its own:

     1. **Where is it?** — the strict, usually-silent guess below.
     2. **How hard is it?** — easy / medium / hard, judged against the
        user's own home address. See HOW HARD IS IT.

   They are scored separately and neither gates the other: a name that
   identifies no place still gets a difficulty, which is the common
   case.

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
const PLACE_MODEL = 'claude-opus-5';

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
    difficulty: {
      type: 'string',
      enum: ['easy', 'medium', 'hard'],
      description:
        'How much of the user\'s time, money and travel this would take, relative to their home. ' +
        'Judged for every activity, independently of the place fields.',
    },
  },
  required: ['place', 'certain', 'difficulty'],
  additionalProperties: false,
} as const;

const PLACE_SYSTEM = `You are given the name of an item on someone's bucket list, and often the
address they call home. Answer two independent questions about it:
WHERE is it, and HOW HARD is it.

# PART ONE — WHERE

Decide whether the name identifies ONE specific, real, findable place — and if
it does, name it.

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
city or region, then the country. Never a street address.

# PART TWO — HOW HARD

Always answer this one. It is not gated on Part One and there is no "unsure"
option: every activity gets easy, medium or hard. Where Part One refuses on any
doubt, here you commit — a rough answer is useful and a missing one is not.

Judge the whole cost of actually doing it, from where the user lives. Three
things decide it, and they trade against each other:

- **Distance from home.** The home address is given when it is known. Near home
  is easy; a drive is medium; a flight, a passport or a different continent is
  hard. With no home address given, judge distance as an average person would.
- **Time.** Not the duration of the thing itself — the time it takes to become
  able to do it. An evening is easy. A weekend, a booking or a bit of training
  is medium. Months of practice, saving or planning is hard.
- **Money.** Pocket money is easy. A few hundred is medium. Thousands, or gear
  you would have to buy, is hard.

Any one of the three being hard makes it hard. Something is easy only when all
three are small.

## Worked examples, for a user whose home is Denver, Colorado

  "Try the new ramen place downtown"    → easy    (minutes away, one meal)
  "Go to a Rockies game"                → easy    (in town, one evening)
  "Learn Japanese"                      → hard    (at home, and years of it)
  "Learn to play the piano"             → hard    (no travel, enormous time)
  "Hike a fourteener"                   → medium  (a few hours' drive, one day)
  "Bike the Katy Trail"                 → medium  (a drive and a weekend)
  "Get scuba certified"                 → medium  (a course, a few hundred dollars)
  "Hike across Norway"                  → hard    (a flight, weeks, real money)
  "See the pyramids"                    → hard    (long haul, real money)
  "Run a marathon"                       → hard    (months of training)
  "Read Ulysses"                        → medium  (free, but weeks of evenings)

Note what the first two and the third have in common: all three happen where the
user already is. Distance is only one of the three, and time alone is enough to
make something hard.

## When the user tells you about themselves, they outrank the examples above

The message may carry two extra things. Both are about the difficulty half only
and neither has anything to say about Part One.

**About the user** — a sentence or two they wrote about their own life: no car,
a tight budget, hikes every weekend, will not fly. Read it as fact and let it
move a rating in either direction. Someone who hikes every weekend finds a
fourteener easy; someone with no car finds a two-hour drive hard.

**Their own rated activities** — a handful of items already on their list with
the tier each one carries, deliberately drawn from all three tiers so you can
see where this person's lines actually fall. These are the calibration. When
one of them disagrees with the Denver examples above, follow theirs: those are
generic and these are the user's.

Do not simply copy a tier from the nearest-looking example, and do not assume
the new activity must be a tier that is under-represented in the sample. Judge
the activity on the three costs, with their lines rather than an average
person's.`;

type DiffExample = { name: string; difficulty: string };

/* The user's own calibration, rendered for the model. Balanced across
   the three tiers by the client (see TEACHING THE RATING in
   js/location.js) — this end only formats what it is handed, and
   drops anything malformed rather than trusting the caller. */
function examplesBlock(examples: DiffExample[]): string {
  const tiers = ['easy', 'medium', 'hard'];
  const lines = examples
    .filter((e) => e && typeof e.name === 'string' && tiers.includes(e.difficulty))
    .slice(0, 24)
    .map((e) => `  ${JSON.stringify(e.name.trim().slice(0, 120))} → ${e.difficulty}`);
  return lines.length ? `\nActivities this user has already rated:\n${lines.join('\n')}` : '';
}

async function predictPlace(
  name: string,
  home: string,
  profile: string,
  examples: DiffExample[],
): Promise<{ location: string; lat: number | null; lng: number | null; difficulty: string | null }> {
  const empty = { location: '', lat: null, lng: null, difficulty: null };
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
        /* Home, then who they are, then how they have rated things
           before, then the question. All three of the first are
           optional and absent means the pre-personalisation reading —
           an average person, judged on the generic examples. */
        content: [
          home.trim() ? `Home: ${home.trim()}` : '',
          profile.trim() ? `About the user: ${profile.trim()}` : '',
          examplesBlock(examples),
          `Activity: ${name.trim()}`,
        ].filter(Boolean).join('\n'),
      }],
    });

    if (res.stop_reason === 'refusal') return empty;
    const text = res.content.find((b: any) => b.type === 'text');
    if (!text) return empty;
    const parsed = JSON.parse((text as any).text);
    /* Judged for every activity, and never gated on the place half —
       most names identify no place at all and still have a difficulty.
       Anything outside the three tiers is dropped rather than stored. */
    const difficulty = ['easy', 'medium', 'hard'].includes(parsed.difficulty)
      ? parsed.difficulty
      : null;

    /* `certain` is the gate, not a score to weigh: the prompt defines
       when it is allowed to be true, and anything less than true is a
       no. */
    if (!parsed.certain || !parsed.place) return { ...empty, difficulty };

    /* Gate three. A place the geocoder cannot find cannot go on the
       map, which is the only reason to have guessed it. */
    const geo = await geocode(parsed.place);
    if (!geo) return { ...empty, difficulty };
    return { location: parsed.place, lat: geo.lat, lng: geo.lng, difficulty };
  } catch (e) {
    console.error('predictPlace:', e);
    return empty;
  }
}

/* ==============================================================
   GEOCODE

   Same public Nominatim endpoint js/location.js uses. It is the third
   gate on a predicted place: somewhere the map cannot plot is worthless
   here, because plotting it is the only reason to have guessed.
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

  let body: { activity?: { name?: string; home?: string; profile?: string; examples?: DiffExample[] } };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.activity) return json({ error: 'expected {activity:{name}}' }, 400);

  return json(await predictPlace(
    (body.activity.name || '').slice(0, 200),
    (body.activity.home || '').slice(0, 200),
    (body.activity.profile || '').slice(0, 600),
    Array.isArray(body.activity.examples) ? body.activity.examples : [],
  ));
});
