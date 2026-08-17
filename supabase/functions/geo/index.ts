/* ==============================================================
   geo — place search, with the HERE key kept off the browser.

   The app's location field searches on every pause in typing, so this
   sits on a path where latency is the entire user experience. It
   exists because the alternative — shipping HERE_API_KEY in
   config.js — puts a working credential in every visitor's devtools.
   A domain-restricted key is the industry-normal answer to that and it
   was deliberately rejected here: nothing usable goes to the browser.

   ---- THE WHOLE FILE IS ABOUT BEING FAST ----

   Proxying costs one extra hop, browser → edge → HERE, and everything
   below is about making that hop as close to free as it can be:

   1. **No imports.** Not one. This is the single biggest lever,
      because it is what a cold start actually costs — the isolate has
      to fetch, parse and instantiate every module before your first
      line runs. It is also exactly why this is NOT a branch inside
      unfurl/: that function pulls in the Anthropic SDK, so every
      keystroke-pause would pay for a dependency it never calls.

   2. **GET, not POST.** A GET with the query in the URL is cacheable
      by the browser's own HTTP cache, so a repeated search costs zero
      network. A POST is not cacheable by anything, which is what
      sb.functions.invoke() would have given us.

   3. **Cache-Control: private.** Ten minutes on a search, an hour on a
      geocode. `private` matters: these responses are keyed to a
      caller's bias point, which is roughly where they are standing,
      and must never land in a shared cache.

   4. **A trimmed payload.** HERE returns a large object per item —
      full address breakdown, category taxonomies, scoring, mapView
      boxes. The UI draws four fields. Trimming here rather than in the
      browser means the bytes never cross the slower of the two hops.

   5. **A warm ping.** `?warm=1` returns immediately without touching
      HERE, so the app can spin the isolate up at sign-in and the first
      real search finds it already running. See warmGeo() in
      js/location.js.

   ---- Deploy ----

     supabase secrets set HERE_API_KEY=...
     supabase functions deploy geo

   Do NOT pass --no-verify-jwt. Same reasoning as unfurl: without the
   JWT check this is an open, anonymous geocoding endpoint billed to
   your HERE account, and the URL is visible to anyone with devtools.
   The check itself is a local signature verification at the gateway —
   it costs nothing measurable, so there is no speed argument for
   dropping it.
   ============================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const AUTOSUGGEST = 'https://autosuggest.search.hereapi.com/v1/autosuggest';
const GEOCODE = 'https://geocode.search.hereapi.com/v1/geocode';

function json(body: unknown, status = 200, cache = '') {
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': 'application/json',
  };
  if (cache) headers['Cache-Control'] = cache;
  return new Response(JSON.stringify(body), { status, headers });
}

/* The name the app stores and shows. HERE's own `title` is the place
   name alone ("Jamba"), which is ambiguous once it is sitting in a
   list weeks later — so the city and the region are appended, but only
   when they are not already part of the title. Mirrors what the
   Nominatim fallback in js/location.js produces, so a row created
   through either path reads the same. */
function placeName(item: any): string {
  const a = item.address || {};
  const bits: string[] = [item.title];
  const seen = () => bits.join(', ').toLowerCase();
  const city = a.city || a.county || '';
  if (city && !seen().includes(String(city).toLowerCase())) bits.push(city);
  const wide = a.state || a.countryName || '';
  if (wide && !seen().includes(String(wide).toLowerCase())) bits.push(wide);
  return bits.join(', ');
}

/* The second line of a result row: the street and city, with the
   leading repeat of the place name dropped. */
function placeSub(item: any): string {
  const label = (item.address && item.address.label) || '';
  if (!label) return '';
  const parts = String(label).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && item.title &&
      String(item.title).toLowerCase().startsWith(parts[0].toLowerCase())) parts.shift();
  return parts.join(', ');
}

/* Items with no `position` are dropped, and this is not defensive
   tidying — HERE returns `chainQuery` and `categoryQuery` rows
   ("Coffee", meaning *search for coffee places*) that carry no
   coordinates at all. Letting one through would file an activity with
   a name and no pin, which is the exact failure the client-side
   geoFor contract exists to prevent. */
function trim(items: any[]): any[] {
  return (items || [])
    .filter((i) => i && i.position &&
      isFinite(Number(i.position.lat)) && isFinite(Number(i.position.lng)))
    .map((i) => ({
      name: placeName(i),
      sub: placeSub(i),
      lat: Number(i.position.lat),
      lng: Number(i.position.lng),
    }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);

  /* Spin the isolate up without touching HERE. Called once at sign-in
     so the first real search does not pay the cold start. */
  if (url.searchParams.get('warm')) return json({ ok: true });

  const key = Deno.env.get('HERE_API_KEY');
  if (!key) {
    /* The client falls back to Nominatim on this, exactly as it does
       when the function is not deployed at all. */
    return json({ error: 'no_key', items: [] }, 200);
  }

  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ items: [] }, 200, 'private, max-age=600');

  const mode = url.searchParams.get('mode') === 'geocode' ? 'geocode' : 'suggest';
  const at = url.searchParams.get('at') || '';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 8, 1), 20);

  const params = new URLSearchParams({ q, lang: 'en', apiKey: key });
  if (mode === 'suggest') {
    params.set('limit', String(limit));
    /* `at` biases without restricting, so Paris still wins for "eiffel
       tower" searched from San Francisco. HERE requires one of `at` or
       `in`, so a caller with no bias point gets the whole world rather
       than an error. */
    if (at) params.set('at', at);
    else params.set('in', 'bbox:-180,-90,180,90');
  } else {
    params.set('limit', '1');
    if (at) params.set('at', at);
  }

  try {
    const res = await fetch(`${mode === 'suggest' ? AUTOSUGGEST : GEOCODE}?${params}`);
    if (!res.ok) {
      return json({ error: 'here_' + res.status, items: [] }, 200);
    }
    const data = await res.json();
    const items = trim(data.items || []);
    /* A geocode is a far more stable answer than a type-ahead, so it
       is held ten times as long. Both are `private` — see the header. */
    return json({ items }, 200,
      mode === 'geocode' ? 'private, max-age=3600' : 'private, max-age=600');
  } catch (e) {
    console.error('[geo]', e);
    return json({ error: 'fetch_failed', items: [] }, 200);
  }
});
