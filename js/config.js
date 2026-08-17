/* ==============================================================
   CONFIG — Supabase client + default cover images
   Loaded first. Everything else assumes `sb` already exists.
   ============================================================== */

/* The app's name, for anywhere it is spoken rather than laid out — the
   OS share sheet, a toast. The marks in index.html (title, manifest,
   the auth eyebrow, the nav title) are written out there.

   Note what is deliberately NOT renamed with it: the auth storageKey
   below, the IndexedDB name in offline.js, the sw.js cache prefix and
   the bl_* localStorage keys. Those are storage identities — changing
   one signs everyone out or orphans their cached data. */
const APP_NAME='Someday We’ll Die';

const SUPABASE_URL='https://xxdmendegyxlkikejvps.supabase.co';
const SUPABASE_KEY='sb_publishable_45ETmiEMgvWn3QAd58ck5Q_opy0TWnX';

/* Auth options are spelled out rather than left to the defaults. Most of
   these *are* the defaults, but staying signed in is the thing users
   notice when it breaks, so it should be obvious here what the app is
   relying on rather than implied.

   storageKey is pinned so the stored session survives a supabase-js
   upgrade that might otherwise change the key and silently sign
   everyone out.

   detectSessionInUrl is OFF, which is the one setting here that is not
   the default. supabase-js reads the URL inside createClient() — before
   any of the app's own code has run — so a confirmation link would be
   consumed by a background promise nothing can await, racing the boot
   sequence in main.js and reporting its failures only to the console.
   consumeEmailConfirmation() in auth.js does it explicitly instead, in
   a known order and with somewhere to show the answer. Nothing else
   relies on it: this project has no OAuth providers, only email and
   password. See CONFIRMING AN EMAIL ADDRESS in js/auth.js. */
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
  auth:{
    persistSession:true,        /* keep the session in localStorage */
    autoRefreshToken:true,      /* renew the access token before it lapses */
    detectSessionInUrl:false,   /* auth.js handles the landing itself */
    storageKey:'bucketlist-auth',
    flowType:'pkce',
  },
});

/* ==============================================================
   WEB PUSH

   The public half of a VAPID key pair. It is a public key by design —
   it identifies the sender to the push service and is safe to ship.
   The private half lives only in the Edge Function's secrets.

   Generate a pair with:  npx web-push generate-vapid-keys
   Then paste the public key here and set the private one with:
     supabase secrets set VAPID_PRIVATE_KEY=...

   Left empty, everything still works except background push: reminders
   fall back to the Home banner and a notification on next open.
   ============================================================== */
const VAPID_PUBLIC_KEY='BGkQr3oXiXD5Cs1iyVT6YI5lagtApiNOkFXOk6KPXVnZrnOgWMt-ikNCa_XiHne4GWfjjcE73LlcqMPonu_RpkI';

/* ==============================================================
   PLACE SEARCH — HERE

   ⚠️ THERE IS NO KEY IN THIS FILE, AND ONE MUST NOT BE ADDED.

   The location field searches HERE, but the browser never talks to
   HERE. It talks to supabase/functions/geo, which holds the key as a
   function secret:

     supabase secrets set HERE_API_KEY=...
     supabase functions deploy geo

   A domain-restricted client key is the industry-normal answer to this
   and it was considered and rejected: an origin check is a header a
   determined caller sets themselves, so a key in this file is a
   working credential in every visitor's devtools, billable to your
   account. The proxy costs one extra hop and js/location.js is written
   around making that hop close to free — read THE geo FUNCTION there
   before changing any of it.

   Free tier is 250k requests/month, far past what this app will use.
   Get a key at https://platform.here.com.

   Without the function deployed, or without the secret set, place
   search falls back to Nominatim — what the app used before. You lose
   typo tolerance and near-me ranking, not the feature.

   ---- Why HERE rather than the OpenStreetMap geocoders ----

   The field has to answer two different questions, and the free OSM
   options each answer only one. Measured, same bias point:

     "Jamab Juice"   Nominatim: 0 results.   Photon: the nearby Jamba
                     locations, typo and all.
     "eiffel tower"  Photon: a mountain in Alberta.  Nominatim: Paris.

   Photon is a prefix/POI matcher with no sense of global prominence;
   Nominatim ranks prominence well and has no typo tolerance at all.
   Running both and merging was the keyless option. HERE returns the
   nearby Jamba Juices AND puts Paris first, in one request.
   ============================================================== */

/* Default cover images */
const COVERS=[
  'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1600&q=90',
  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=1600&q=90',
  'https://images.unsplash.com/photo-1612278675615-7b093b07772d?w=1600&q=90',
  'https://images.unsplash.com/photo-1505832018823-50331d70d237?w=1600&q=90',
  'https://images.unsplash.com/photo-1498307833015-e7b400441eb8?w=1600&q=90',
  'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=1600&q=90',
  'https://images.unsplash.com/photo-1519451241324-20b4ea2c4220?w=1600&q=90',
  'https://images.unsplash.com/photo-1461237439866-5a557710c921?w=1600&q=90',
  'https://images.unsplash.com/photo-1483729558449-99ef09a8c325?w=1600&q=90',
  'https://images.unsplash.com/photo-1528164344705-47542687000d?w=1600&q=90',
];
let usedCovers=[];
function randCover(existingCovers){
  /* Pick a cover not already used by the user's other collections.
     existingCovers = array of cover URLs already in use.
     Falls back to cycling through COVERS once all 9 are used. */
  const inUse=existingCovers||usedCovers;
  const available=COVERS.filter(c=>!inUse.includes(c));
  if(available.length) return available[Math.floor(Math.random()*available.length)];
  return COVERS[Math.floor(Math.random()*COVERS.length)];
}
