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
   everyone out. */
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
  auth:{
    persistSession:true,        /* keep the session in localStorage */
    autoRefreshToken:true,      /* renew the access token before it lapses */
    detectSessionInUrl:true,    /* handle magic-link / OAuth redirects */
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
const VAPID_PUBLIC_KEY='';

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
