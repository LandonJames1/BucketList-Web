/* ==============================================================
   LOCATION AUTOCOMPLETE

   Two engines behind one shape. HERE's Autosuggest — reached through
   supabase/functions/geo, never directly, so the key stays off the
   browser — and OpenStreetMap Nominatim when that cannot answer, which
   is what the app used before and still works.

   Everything downstream of placeSearch() sees the same
   {name, sub, lat, lng} regardless of which one answered, so the
   dropdown, the shortcuts and the save-time resolve are written once.
   ============================================================== */

/* No HERE endpoint or key appears in this file, and that is the point:
   the browser only ever talks to our own function. See THE geo
   FUNCTION below. */
const NOMINATIM='https://nominatim.openstreetmap.org';

/* ---- Where "near me" comes from ----

   The bias point is what turns "coffee" into the cafés on your street
   rather than Coffee County, Georgia. Two sources, in order:

     1. a real geolocation fix, if we have one;
     2. the user's Home address, which costs no permission at all.

   Note what does NOT happen here: focusing the location field never
   triggers a permission prompt. A browser dialog appearing because you
   tapped a text box is startling and, answered "no" in that moment,
   permanently. So the fix is only ever fetched when the user has
   ALREADY granted permission (primeBias, which asks the Permissions
   API and never the user) or when they explicitly tap "Current
   location" in the dropdown. Everyone else is biased by Home. */
let _biasPos=null,_biasTried=false;

function biasPoint(){
  if(_biasPos) return _biasPos;
  const home=homePlace();
  if(home&&home.lat!=null&&home.lng!=null) return {lat:home.lat,lng:home.lng};
  return null;
}

function requestBiasPoint(){
  _biasTried=true;
  return new Promise(res=>{
    if(!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p=>{_biasPos={lat:p.coords.latitude,lng:p.coords.longitude};res(_biasPos);},
      ()=>res(null),
      /* High accuracy is pointless for a search bias and costs a GPS
         warm-up; a ten-minute-old fix is fine. */
      {enableHighAccuracy:false,timeout:10000,maximumAge:600000});
  });
}

/* Fetch a fix ONLY if permission is already granted — never prompt.
   Called when a location field is focused. Browsers without the
   Permissions API simply go without, biased by Home instead. */
async function primeBias(){
  if(_biasTried||_biasPos) return;
  if(!navigator.permissions||!navigator.permissions.query) return;
  try{
    const st=await navigator.permissions.query({name:'geolocation'});
    if(st.state==='granted') requestBiasPoint();
  }catch(e){/* Safari has thrown on unsupported names; going without is fine. */}
}

/* ==============================================================
   THE geo FUNCTION — HERE, without the key ever reaching a browser

   A domain-restricted client key is the normal answer here and it was
   deliberately rejected: nothing usable ships. So search goes
   browser → supabase/functions/geo → HERE, and the extra hop is real.
   Four things claw it back, and between them a typical search is
   faster than the single-hop version was, because most searches never
   leave the device at all:

   1. **A session cache, including the misses.** Typing is not a
      sequence of distinct queries — it is one query typed and
      re-typed. Backspacing a character, correcting a typo, opening a
      second activity in the same place: all free. This is the biggest
      win by a distance and it is why the debounce could stay where it
      is rather than being lengthened to compensate.
   2. **Prefix reuse on an empty answer.** If "jamba jui" returned
      nothing, "jamba juic" cannot return anything either — HERE's
      matching only narrows. So a longer query whose prefix came back
      empty is answered instantly, without a request.
   3. **A warm isolate.** warmGeo() at sign-in spins the function up
      and opens the TLS connection, so the first search of a session
      finds both already there. Cold, that is the slowest request the
      feature ever makes; warm, it is one of the fastest.
   4. **GET with Cache-Control**, so the browser's own HTTP cache
      absorbs anything the session cache misses — across reloads, and
      across the three sheets that each have their own field.

   And an AbortController, so a superseded request stops competing for
   the connection instead of racing to be ignored.
   ============================================================== */
const GEO_URL=`${SUPABASE_URL}/functions/v1/geo`;
const GEO_CACHE_MAX=300;          /* plenty for a session; bounded so it cannot grow forever */
const _geoCache=new Map();
/* Per mode, not one shared controller. A save-time geocode and a
   type-ahead search are different questions asked at the same moment —
   the user presses Save while a search is still in flight — and a
   single controller made whichever started second kill the first. A
   cancelled geocode reads as "we couldn't find that place" and blocks
   a save that should have gone through. */
const _geoAbort={suggest:null,geocode:null};

/* Memoised so a keystroke does not await the auth layer. getSession()
   reads from memory when the token is live, but it is still a promise
   and this is the one path where that is worth avoiding. */
let _geoTok=null,_geoTokAt=0;
async function geoToken(){
  if(_geoTok&&Date.now()-_geoTokAt<60000) return _geoTok;
  try{
    const{data}=await sb.auth.getSession();
    _geoTok=data&&data.session?data.session.access_token:null;
  }catch(e){ _geoTok=null; }
  _geoTokAt=Date.now();
  return _geoTok;
}

/* Rounded to ~1km. The bias point only decides ranking, so a fix that
   wobbles by a few metres between keystrokes must not miss the cache. */
function geoCacheKey(mode,q,at){
  const p=at?`${at.lat.toFixed(2)},${at.lng.toFixed(2)}`:'';
  return `${mode}|${q.toLowerCase()}|${p}`;
}

/* "jamba jui" found nothing, so "jamba juic" cannot either. */
function geoEmptyByPrefix(mode,q,at){
  const key=geoCacheKey(mode,q,at);
  const head=key.slice(0,key.indexOf('|')+1);
  const text=q.toLowerCase();
  for(const [k,v] of _geoCache){
    if(v.length||!k.startsWith(head)) continue;
    const cachedQ=k.slice(head.length,k.lastIndexOf('|'));
    if(cachedQ&&text.startsWith(cachedQ)) return true;
  }
  return false;
}

function geoRemember(key,items){
  if(_geoCache.size>=GEO_CACHE_MAX) _geoCache.delete(_geoCache.keys().next().value);
  _geoCache.set(key,items);
}

/* Called once at sign-in. Starts the isolate and the TLS handshake so
   the first real search pays for neither. Deliberately un-awaited and
   silent — it is an optimisation, and a failed one changes nothing. */
function warmGeo(){
  if(!SUPABASE_URL) return;
  geoToken().then(tok=>{
    fetch(`${GEO_URL}?warm=1`,{headers:tok?{Authorization:`Bearer ${tok}`}:{}}).catch(()=>{});
  }).catch(()=>{});
}

/* Resolves to an array, or null when the function could not answer at
   all — which is the signal to fall back to Nominatim. An empty array
   means "asked, and there is nothing", which is a real answer. */
async function geoQuery(mode,q,limit){
  const at=biasPoint();
  const key=geoCacheKey(mode,q,at);
  if(_geoCache.has(key)) return _geoCache.get(key);
  if(geoEmptyByPrefix(mode,q,at)){ geoRemember(key,[]); return []; }

  /* A superseded request of the SAME kind should stop, not finish and
     be discarded. Across kinds they never cancel each other. */
  if(_geoAbort[mode]) _geoAbort[mode].abort();
  const ctl=new AbortController();
  _geoAbort[mode]=ctl;

  const params=new URLSearchParams({q,mode,limit:String(limit||8)});
  if(at) params.set('at',`${at.lat},${at.lng}`);

  try{
    const tok=await geoToken();
    const res=await fetch(`${GEO_URL}?${params}`,{
      signal:ctl.signal,
      headers:tok?{Authorization:`Bearer ${tok}`}:{},
    });
    if(!res.ok) return null;
    const data=await res.json();
    /* no_key / here_5xx / fetch_failed all mean "ask Nominatim". */
    if(data.error) return null;
    const items=data.items||[];
    geoRemember(key,items);
    return items;
  }catch(e){
    if(e&&e.name==='AbortError') return [];   /* superseded; the newer call owns the box */
    return null;
  }finally{
    if(_geoAbort[mode]===ctl) _geoAbort[mode]=null;
  }
}

/* ---- Nominatim (the no-key fallback) ---- */
async function nominatimSearch(q,limit){
  const res=await fetch(
    `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=${limit}`,
    {headers:{'Accept-Language':'en'}});
  if(!res.ok) throw new Error('nominatim '+res.status);
  const data=await res.json();
  return data.map(r=>({
    name:r.display_name.split(',').slice(0,3).join(',').trim(),
    sub:r.display_name.split(',').slice(1,4).join(',').trim(),
    lat:parseFloat(r.lat),lng:parseFloat(r.lon),
  }));
}

/* The one entry point. Always resolves to an array — a failing engine
   returns nothing rather than throwing into the caller's UI.

   HERE via the geo function first; Nominatim when it cannot answer,
   which covers the function not being deployed, HERE_API_KEY not being
   set as a secret, and HERE itself failing. A null from geoQuery() is
   that signal; an empty array is a real "nothing matches" and is NOT
   retried against Nominatim, because asking a worse geocoder the same
   question wastes a round trip on the answer we already have. */
async function placeSearch(q,limit){
  const query=(q||'').trim();
  if(query.length<2) return [];
  try{
    const viaHere=await geoQuery('suggest',query,limit||8);
    if(viaHere) return viaHere;
    return await nominatimSearch(query,limit||6);
  }catch(e){
    console.warn('placeSearch:',e&&e.message||e);
    return [];
  }
}

/* ==============================================================
   THE DROPDOWN

   Results are held here and referenced by index rather than being
   interpolated into an inline onmousedown. The old code escaped the
   display name twice (a backslash pass, then esc()) to survive being
   written into an HTML attribute that is then parsed as JavaScript,
   which worked for apostrophes and would not have survived a
   backslash. An index cannot be mis-escaped.
   ============================================================== */
let locTimer=null;
let _locSeq=0;                 /* drops a slow response that a newer one has overtaken */
const _locResults=Object.create(null);   /* resultsId → the array currently drawn */

function locItemHTML(resultsId,r,i){
  return `<button class="loc-item" onmousedown="locPickIdx('${resultsId}',${i})">
      ${icon('pin')}
      <span class="loc-item-body">
        <span class="loc-item-main">${esc(r.name)}</span>
        ${r.sub?`<span class="loc-item-sub">${esc(r.sub)}</span>`:''}
      </span>
    </button>`;
}

/* Home and Current location, above the results. They are the two
   answers that need no typing, so they show while the field is empty —
   which is exactly when the user has not yet decided what to type. */
function locShortcutsHTML(resultsId){
  const out=[];
  const home=homePlace();
  if(home&&home.location){
    out.push(`<button class="loc-item loc-item-shortcut" onmousedown="locUseHome('${resultsId}')">
        ${icon('home')}
        <span class="loc-item-body">
          <span class="loc-item-main">Home</span>
          <span class="loc-item-sub">${esc(home.location)}</span>
        </span>
      </button>`);
  }
  out.push(`<button class="loc-item loc-item-shortcut" onmousedown="locUseCurrent('${resultsId}')">
      ${icon('locate')}
      <span class="loc-item-body"><span class="loc-item-main">Current location</span></span>
    </button>`);
  return out.join('');
}

/* How many location dropdowns are open right now.

   The document-level scroll listener at the bottom of this file runs in
   the CAPTURE phase, so it fires for every scroll of every scroller in
   the app - the page, a sheet body, the conversation. It was running a
   querySelectorAll() over the whole document on each one, to reposition
   a dropdown that is almost never open. This counter turns the common
   case into a single integer compare.

   Everything that opens or closes one goes through locOpen/locClose so
   the count cannot drift - including the outside-tap handler at the
   bottom of this file, which used to strip the class by hand. */
let _locOpenCount=0;

function locOpen(box,input,html){
  if(!box.classList.contains('open')) _locOpenCount++;
  box.innerHTML=html;
  box.classList.add('open');
  positionLocBox(box,input);
}

function locClose(box){
  if(!box)return;
  if(box.classList.contains('open')) _locOpenCount=Math.max(0,_locOpenCount-1);
  box.classList.remove('open');
  box.innerHTML='';
}

function locSearch(input,resultsId){
  const q=input.value.trim();
  const box=$(resultsId);
  if(!box)return;
  primeBias();
  /* Typed text and the coordinates last picked have to agree, or a
     renamed place saves against the old pin. See locGeoMark(). */
  locInvalidateIfChanged(input);
  clearTimeout(locTimer);

  if(q.length<2){ locOpen(box,input,locShortcutsHTML(resultsId)); return; }

  const seq=++_locSeq;
  locTimer=setTimeout(async()=>{
    /* The wait is a debounce plus a network round trip. Saying so beats
       a field that looks broken for half a second. */
    locOpen(box,input,'<div class="loc-loading">'+icon('search')+'Searching&hellip;</div>');
    const items=await placeSearch(q,8);
    if(seq!==_locSeq) return;                /* a newer keystroke owns the box now */
    if(!document.body.contains(input)) return;
    _locResults[resultsId]=items;
    locOpen(box,input,items.length
      ? items.map((r,i)=>locItemHTML(resultsId,r,i)).join('')
      : '<div class="loc-empty">No places found</div>');
  },320);
}

function locPickIdx(resultsId,i){
  const r=(_locResults[resultsId]||[])[i];
  if(!r) return;
  locApply(resultsId,r);
}

/* Write a resolved place into whichever trio of inputs this dropdown
   belongs to, and record WHICH text the coordinates are for.

   `isHome` records that this value came from the Home shortcut rather
   than from a search. That is intent, not text — see "THIS ACTIVITY IS
   AT HOME" in api.js for why the difference has to be stored. Anything
   picked from the results clears it, because choosing a place that
   happens to be your home town is not the same as choosing home. */
function locApply(resultsId,r,isHome){
  const box=$(resultsId);
  if(!box) return;
  const wrap=box.parentElement;
  const input=wrap.querySelector('input:not([type="hidden"])');
  const latInput=wrap.querySelector('input[id*="Lat"]');
  const lngInput=wrap.querySelector('input[id*="Lng"]');
  if(input){
    input.value=r.name; locGeoMark(input);
    if(isHome) input.dataset.isHome='1'; else delete input.dataset.isHome;
  }
  if(latInput) latInput.value=r.lat;
  if(lngInput) lngInput.value=r.lng;
  locClose(box);
  /* The activity sheet marks a location it filled in from the name.
     A place the user chose themselves is not that, so take the mark
     off — otherwise the caption claims credit for their answer. */
  if(input&&input.id==='aLoc'&&typeof clearLocationGuessMark==='function') clearLocationGuessMark();
}

async function locUseCurrent(resultsId){
  const box=$(resultsId);
  if(box) box.innerHTML='<div class="loc-loading">'+icon('locate')+'Finding you&hellip;</div>';
  /* This is the one path allowed to raise the permission prompt: the
     user asked for it by name. */
  const p=await requestBiasPoint();
  if(!p){
    if(box) box.innerHTML='<div class="loc-empty">Couldn’t get your location</div>';
    return;
  }
  const named=await reverseGeocode(p.lat,p.lng);
  locApply(resultsId,{name:(named&&named.display)||`${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
                      lat:p.lat,lng:p.lng});
}

function locUseHome(resultsId){
  const home=homePlace();
  if(!home||!home.location) return;
  locApply(resultsId,{name:home.location,lat:home.lat,lng:home.lng},true);
}

/* ==============================================================
   KEEPING THE TEXT AND THE COORDINATES TOGETHER

   Coordinates used to be written by one path only — tapping a
   dropdown row — while the text box was free to say anything. Two
   things went wrong, and the second is the worse one:

     - Type "Kyoto", press Save without tapping a suggestion, and the
       activity stored a location with no coordinates. It then never
       appeared on the map, which is the one thing the field is for.
     - Open an activity that HAS a location, change the text to
       somewhere else, press Save without tapping: the new name was
       stored against the OLD coordinates. A silently wrong pin, which
       is worse than no pin, because nothing about it looks wrong.

   So a text input carries `dataset.geoFor` — the exact string its
   coordinates were resolved for. Anything else is treated as
   unresolved: the coordinates are dropped the moment the text stops
   matching, and resolveLocationField() re-resolves before a save.
   ============================================================== */
function locGeoMark(input){ if(input) input.dataset.geoFor=input.value.trim(); }

/* Whether the field currently holds Home, as chosen rather than as
   typed. Read by every save path; see listFieldsFor()'s neighbour
   homeFieldsFor() in activities.js. */
function locIsHome(inputId){
  const el=$(inputId);
  return !!(el&&el.dataset.isHome==='1');
}

function locSetHome(inputId,on){
  const el=$(inputId);
  if(!el) return;
  if(on) el.dataset.isHome='1'; else delete el.dataset.isHome;
}

function locFieldsFor(input){
  const wrap=input&&input.closest('.loc-wrap');
  if(!wrap) return {};
  return {lat:wrap.querySelector('input[id*="Lat"]'),lng:wrap.querySelector('input[id*="Lng"]')};
}

function locInvalidateIfChanged(input){
  if(!input) return;
  if(input.dataset.geoFor===input.value.trim()) return;
  const {lat,lng}=locFieldsFor(input);
  if(lat) lat.value='';
  if(lng) lng.value='';
  delete input.dataset.geoFor;
  /* Typing over a location that was Home severs the link. The user is
     naming a place now, not deferring to wherever they live. */
  delete input.dataset.isHome;
}

/* Called before a save. Returns:
     {empty:true}            nothing typed
     {ok:true}               coordinates are present and match the text
     {ok:false}              typed a place we could not resolve

   The geocode only happens when the text is unresolved, so someone who
   picked from the dropdown pays nothing. */
async function resolveLocationField(inputId){
  const input=$(inputId);
  if(!input) return {empty:true};
  const text=input.value.trim();
  if(!text) return {empty:true};

  const {lat,lng}=locFieldsFor(input);
  const has=lat&&lng&&lat.value!==''&&lng.value!=='';
  if(has&&input.dataset.geoFor===text) return {ok:true};

  const hit=await geocodeOnce(text);
  if(!hit){
    /* Offline, or a name no geocoder knows. Keeping stale coordinates
       here is what produced the wrong-pin bug, so they stay cleared. */
    if(lat) lat.value='';
    if(lng) lng.value='';
    delete input.dataset.geoFor;
    return {ok:false};
  }
  if(lat) lat.value=hit.lat;
  if(lng) lng.value=hit.lng;
  /* The typed text is kept, not overwritten with the geocoder's label:
     the user wrote "Grandma's cabin" and meant it. Only the coordinates
     were missing. */
  locGeoMark(input);
  return {ok:true};
}

/* ==============================================================
   A LOCATION IS REQUIRED

   Every activity needs one. The reasoning is the same one that pulled
   the field out of the old "More options" disclosure: an activity with
   no location never appears on the map, never appears in a place
   search, and the field was the one people skipped — so most
   activities silently never did.

   TWO THINGS THIS DELIBERATELY DOES NOT DO:

   - **It does not block a save while offline.** Resolving text to
     coordinates needs the network, and refusing to save without it
     would break capture in exactly the place this app is meant to
     work — "ideas arrive on planes and in tunnels" is the whole
     argument for js/offline.js. Offline, typed text is accepted as-is
     and the activity syncs without coordinates.
   - **It does not apply to an activity that is already completed.**
     confirmComplete()'s edit pass is exempt for the same reason the
     media rule is (see updateMediaRequirement): enforcing a new
     requirement on the edit path strands every row created before it,
     whose owner then cannot fix a typo without first satisfying it.

   It DOES block an unresolvable place while online, which is the
   strict reading: a location that cannot be found is a location that
   will not be on the map, and accepting it silently is the failure
   this replaced. If that proves too strict in practice, returning
   `true` instead of `false` in the `!res.ok` branch below relaxes it
   to "any text will do" in one line.
   ============================================================== */
async function requireLocation(inputId,errorId,btn){
  const input=$(inputId);
  const err=errorId?$(errorId):null;
  /* Sheets with somewhere to put a message use it; the completion sheet
     has no room in its inset card, so it says the same thing in a toast
     — which is what its media requirement already does. */
  const setErr=m=>{
    if(err){ err.textContent=m||''; err.style.display=m?'':'none'; }
    else if(m) showToast(m);
  };
  setErr('');

  const text=input?input.value.trim():'';
  if(!text){
    setErr('Add a location so this shows up on your map.');
    if(input){ shakeEl(input); input.focus(); }
    return false;
  }

  if(btn) btn.disabled=true;
  const res=await resolveLocationField(inputId);
  if(btn) btn.disabled=false;
  if(res.ok) return true;

  /* No network to look it up with. Take the text and move on — the
     alternative is refusing to capture the idea at all. */
  if(!navigator.onLine) return true;

  setErr('We couldn’t find that place. Try picking one from the list.');
  if(input){ shakeEl(input); input.focus(); }
  return false;
}

/* One-shot lookup for a place name we already have — an imported link's
   location, a name typed but never picked from the dropdown. Unlike
   locSearch this is not debounced and does not touch the DOM: it just
   resolves a string to coordinates, or null. */
async function geocodeOnce(q){
  const query=(q||'').trim();
  if(query.length<2) return null;
  /* Same two-engine order as placeSearch, and the same cache — a name
     the user typed has very often just been searched for. */
  const viaHere=await geoQuery('geocode',query,1);
  if(viaHere&&viaHere.length){
    const hit=viaHere[0];
    return {display:hit.name,lat:hit.lat,lng:hit.lng};
  }
  /* Null means the function could not answer; an empty array means it
     answered "nothing". Only the first is worth asking Nominatim about
     — but a geocode is a save-blocking answer, so the fallback runs for
     both rather than refusing a save on one geocoder's opinion. */
  try{
    const res=await fetch(
      `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      {headers:{'Accept-Language':'en'}});
    if(!res.ok) return null;
    const data=await res.json();
    if(!data.length) return null;
    return {display:data[0].display_name,lat:parseFloat(data[0].lat),lng:parseFloat(data[0].lon)};
  }catch(e){ console.warn('geocodeOnce:',e); return null; }
}

/* Coordinates back to a place name — used for the location a photo
   carries in its EXIF (see js/exif.js), where we have a precise fix
   and need something a person would recognise.

   zoom=14 asks Nominatim for roughly neighbourhood/village level. The
   default returns a full postal address, which is both too precise to
   be useful as a bucket-list location and slightly unnerving to be
   shown back to you. */
async function reverseGeocode(lat,lng){
  if(!isFinite(lat)||!isFinite(lng)) return null;
  try{
    const res=await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}`+
      `&lon=${encodeURIComponent(lng)}&format=json&zoom=14&addressdetails=1`,
      {headers:{'Accept-Language':'en'}});
    if(!res.ok) return null;
    const d=await res.json();
    if(!d||!d.display_name) return null;
    /* The first three parts are about as much as fits a location field
       and reads as a place rather than an address. */
    const short=d.display_name.split(',').slice(0,3).join(',').trim();
    return{display:short||d.display_name,lat,lng};
  }catch(e){ console.warn('reverseGeocode:',e); return null; }
}

/* ==============================================================
   GUESSING THE LOCATION FROM THE NAME

   An activity with no location never appears on the map, and the
   location field is the one people skip. The photo's EXIF answers this
   after the fact (see js/media.js); this answers it at the moment the
   activity is created, from the name alone.

   The model half is `{activity:{name}}` on the unfurl
   function — see the PREDICTING A LOCATION header there for why the
   bar is set where it is, and for the three gates it has to clear.
   This file holds the fourth, and the one that writes.

   Unlike the EXIF suggestion, an accepted answer here is **filled in,
   not offered**. That is a deliberate difference and it rests on the
   strictness: EXIF says "the camera was at these coordinates", which
   is often true of the poster, the screenshot or the drive there
   rather than the thing itself, so it has to be asked about. This says
   "the name of this activity is the name of this place", which is
   either right or the model should not have answered. What is filled
   in is marked, and one tap clears it.

   THE COST: one model call per activity created this way. Nothing
   caches across sessions, so retyping the same name pays again — the
   same gap the import path has.
   ============================================================== */

/* The predicted place has to share a real word with the activity name.

   This is the cheap backstop against an invented answer, and it is
   also the rule the whole feature is built on stated as code: we are
   filling this in because the NAME identifies the place, so if none of
   the name is in the answer, the answer came from an association and
   is exactly what must not be written. It costs some true positives —
   "See the Mona Lisa" will not resolve to the Louvre — and that is the
   right side to miss on. */
const GUESS_STOP=new Set(['the','a','an','of','in','at','to','on','go','visit','see',
  'and','city','town','national','park','usa','uk']);

function guessMatchesName(place,name){
  const words=s=>new Set(fuzzyNorm(s).split(' ').filter(w=>w.length>2&&!GUESS_STOP.has(w)));
  const inName=words(name);
  if(!inName.size) return false;
  for(const w of words(place)) if(inName.has(w)) return true;
  return false;
}

/* One in-flight guess at a time, and answers that arrive after the
   sheet has moved on are dropped. Blurring the name field twice, or
   editing it and blurring again, must not race two fills into the
   field in whichever order the network returns them. */
let _guessSeq=0,_guessFor='',_guessFilled=false,_guessDismissed=false;

/* Called on every open of the activity sheet, so a guess from one
   activity cannot leak into the next one started in the same session.

   `arm` is false from openEditAct(): guessing is for an activity being
   created. Renaming an existing one is not an invitation to rewrite
   the place it happens, and an activity that has been around long
   enough to edit has already had its chance to be guessed at. */
function resetLocationGuess(arm){
  _guessSeq++;
  /* A pause in typing that has not fired yet belongs to the sheet being
     torn down, not the one being opened. */
  clearTimeout(_guessTimer);
  _guessFor='';_guessFilled=false;_guessDismissed=!arm;
  const box=$('aLocGuess');
  if(box){ box.hidden=true; box.innerHTML=''; }
}

/* The user typing in the location field settles it: their value wins,
   and nothing offers again for this activity. */
function onActLocInput(){
  if(_guessFilled||_guessDismissed) clearLocationGuessMark();
  _guessDismissed=true;
}

function clearLocationGuessMark(){
  _guessFilled=false;
  const box=$('aLocGuess');
  if(box){ box.hidden=true; box.innerHTML=''; }
}

/* Tapping the ✕ on the mark: take the guess back out and stop
   offering. The field is emptied because the value in it is not one
   the user typed — leaving it there after they rejected it would be
   the silent write this whole design is avoiding. */
function undoLocationGuess(){
  if(!_guessFilled) return;
  $('aLoc').value='';$('aLocLat').value='';$('aLocLng').value='';
  _guessDismissed=true;
  clearLocationGuessMark();
}

/* ==============================================================
   MAKING THE GUESS ARRIVE SOONER

   Three levers, none of which changes what the feature will answer:

   1. **Ask while they are still typing, not on blur.** The round trip
      is the whole cost, and firing it at a pause in typing overlaps it
      with the rest of the sheet being filled in — the answer is
      frequently already there by the time they would have left the
      field. Still one call per *pause*, never one per keystroke: that
      is what GUESS_IDLE_MS buys, and it is why the original comment
      said "not on input".
   2. **Remember the answers for the session.** Most names are asked
      about once, but the ones that repeat — a name retyped after a
      correction, the same activity added to two lists — return
      instantly and free. Negative answers are cached too, and they are
      the majority.
   3. **Never ask twice for the same name.** `_guessFor` already did
      this within one sheet; the cache extends it across sheets.
   ============================================================== */
const GUESS_IDLE_MS=650;
let _guessTimer=null;

/* Session-lived, name → {location,lat,lng} or null. Deliberately not
   persisted: a place the model would answer differently later is worth
   re-asking, and this exists to kill repeats inside one sitting, not to
   build a gazetteer. */
const _guessCache=new Map();

function queueLocationGuess(){
  clearTimeout(_guessTimer);
  /* Cheap reasons not to bother are checked here as well as in
     maybeGuessLocation(), so a dismissed sheet does not keep arming a
     timer on every keystroke. */
  if(_guessDismissed) return;
  _guessTimer=setTimeout(maybeGuessLocation,GUESS_IDLE_MS);
}

/* Fired by the activity sheet's name field: on blur (`change`), on a
   pause in typing (debounced `input`), and explicitly by
   openNewActivity() for a name that arrived from a composer and was
   therefore never typed into the field at all. */
async function maybeGuessLocation(){
  clearTimeout(_guessTimer);
  const nameEl=$('aName'),locEl=$('aLoc');
  if(!nameEl||!locEl) return;
  const name=nameEl.value.trim();

  /* Every reason not to ask, cheapest first. Editing an existing
     activity is excluded by openEditAct() never arming this. */
  if(_guessDismissed||!navigator.onLine||name.length<3) return;
  if(fuzzyNorm(name)===_guessFor) return;      /* already answered for this name */
  /* A location that is there stays there — except one we filled in
     ourselves, which a renamed activity should be allowed to replace. */
  if(locEl.value.trim()&&!_guessFilled) return;

  const key=fuzzyNorm(name);
  _guessFor=key;
  const seq=++_guessSeq;

  let data;
  if(_guessCache.has(key)){
    /* Instant and free. A cached miss is stored as null and short-circuits
       here too — most names never name a place, so that is the common case. */
    data=_guessCache.get(key);
  } else {
    try{
      const r=await sb.functions.invoke('unfurl',{
        body:{activity:{name}},
      });
      if(r.error) throw r.error;
      data=r.data;
    }catch(e){
      /* The backend is optional here exactly as it is for an import.
         Without it the field is simply left for the user. A failure is
         deliberately NOT cached — it says nothing about the name. */
      console.info('[location] no guess:',e&&e.message||e);
      return;
    }
    _guessCache.set(key,data&&data.location?data:null);
  }

  /* Stale, or the sheet is gone, or the user has since typed
     something. All three are "too late to be useful". */
  if(seq!==_guessSeq||!$('actSheet').classList.contains('open')) return;
  if(_guessDismissed) return;
  if(locEl.value.trim()&&!_guessFilled) return;
  if(!data||!data.location) return;
  if(!guessMatchesName(data.location,name)){
    console.info('[location] rejected a guess that shares no word with the name:',data.location);
    return;
  }

  locEl.value=data.location;
  $('aLocLat').value=data.lat==null?'':data.lat;
  $('aLocLng').value=data.lng==null?'':data.lng;
  /* The guess resolved the name and the coordinates together, so the
     save-time resolve has nothing left to do for this value. */
  if(data.lat!=null) locGeoMark(locEl);
  _guessFilled=true;

  const box=$('aLocGuess');
  if(!box) return;
  box.innerHTML=`<span class="loc-guess-cap">${icon('sparkle','ic-xs')}Filled in from the name</span>
    <button class="loc-guess-x" onclick="undoLocationGuess()" aria-label="Clear location">
      ${icon('x','ic-xs')}</button>`;
  box.hidden=false;
}

/* Inside the bulk sheet the dropdown is position:fixed so it can escape
   the sheet's scroll container; it therefore has to be placed by hand. */
function positionLocBox(box,input){
  if(getComputedStyle(box).position!=='fixed')return;
  const r=input.getBoundingClientRect();
  box.style.top=(r.bottom+4)+'px';
  box.style.left=r.left+'px';
  box.style.width=r.width+'px';
}

/* Dismiss any open dropdown on an outside tap. */
document.addEventListener('click',e=>{
  if(!_locOpenCount) return;
  document.querySelectorAll('.loc-results.open').forEach(b=>{
    if(!b.parentElement.contains(e.target)) locClose(b);
  });
});

/* The bulk sheet's dropdown is position:fixed so it can escape that
   sheet's scroll container, which means it does not travel with the
   field it belongs to. Re-place it while it is open, or it detaches
   and hangs over an unrelated row. */
document.addEventListener('scroll',()=>{
  if(!_locOpenCount) return;
  document.querySelectorAll('.loc-results.open').forEach(b=>{
    const input=b.parentElement&&b.parentElement.querySelector('input:not([type="hidden"])');
    if(input) positionLocBox(b,input);
  });
},true);
