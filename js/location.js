/* ==============================================================
   LOCATION AUTOCOMPLETE — place search via OpenStreetMap Nominatim.
   Debounced so typing does not hammer the public API.
   ============================================================== */

let locTimer=null;

function locSearch(input,resultsId){
  const q=input.value.trim();
  const box=$(resultsId);
  if(!box)return;
  if(q.length<2){box.classList.remove('open');box.innerHTML='';return;}
  clearTimeout(locTimer);
  locTimer=setTimeout(async()=>{
    try{
      const res=await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6`,
        {headers:{'Accept-Language':'en'}});
      const data=await res.json();
      if(!data.length){
        box.innerHTML='<div class="loc-empty">No places found</div>';
        box.classList.add('open');positionLocBox(box,input);return;
      }
      box.innerHTML=data.map(r=>{
        const main=r.display_name.split(',')[0];
        const sub=r.display_name.split(',').slice(1,3).join(',').trim();
        const safe=r.display_name.replace(/'/g,"\\'");
        return `<button class="loc-item" onmousedown="locPick(this,'${resultsId}','${esc(safe)}',${r.lat},${r.lon})">
          ${icon('pin')}
          <span class="loc-item-body">
            <span class="loc-item-main">${esc(main)}</span>
            ${sub?`<span class="loc-item-sub">${esc(sub)}</span>`:''}
          </span>
        </button>`;
      }).join('');
      box.classList.add('open');
      positionLocBox(box,input);
    }catch(e){console.error('locSearch:',e);}
  },350);
}

/* One-shot lookup for a place name we already have — an imported link's
   location, say. Unlike locSearch this is not debounced and does not
   touch the DOM: it just resolves a string to coordinates, or null.
   The unfurl function geocodes server-side too; this is the fallback
   for when it could not, and for a place the user edits by hand. */
async function geocodeOnce(q){
  const query=(q||'').trim();
  if(query.length<2) return null;
  try{
    const res=await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
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

function locPick(el,resultsId,display,lat,lng){
  const box=$(resultsId);
  const wrap=box.parentElement;
  const input=wrap.querySelector('input:not([type="hidden"])');
  const latInput=wrap.querySelector('input[id*="Lat"]');
  const lngInput=wrap.querySelector('input[id*="Lng"]');
  if(input) input.value=display;
  if(latInput) latInput.value=lat;
  if(lngInput) lngInput.value=lng;
  box.classList.remove('open');box.innerHTML='';
}

/* Dismiss any open dropdown on an outside tap. */
document.addEventListener('click',e=>{
  document.querySelectorAll('.loc-results.open').forEach(b=>{
    if(!b.parentElement.contains(e.target)) b.classList.remove('open');
  });
});
