/* ==============================================================
   DUPLICATE DETECTION

   The problem this app exists to solve is ideas scattered across
   Instagram saves, Notes and paper. Pulling all of that into one
   place necessarily drags the same idea in more than once — so the
   moment capture gets easy, duplicates become the next failure.

   Three rules shape everything here:

   1. **Nothing is ever deleted or merged automatically.** A match is
      a question, not a verdict. The user is shown what already
      exists and decides; "Add anyway" is the primary button, because
      the app being wrong must never cost more than one tap.
   2. **It must not slow capture down.** The check is synchronous
      against the in-memory row cache (api.js), so it costs nothing
      and works offline. If the cache is cold there is simply nothing
      to compare against and the add proceeds as before.
   3. **Matching is fuzzy, not exact.** "Skydive in Interlaken" and
      "Go skydiving in Interlaken" are the same plan written twice,
      and an exact-text check — which is what most apps ship — would
      catch neither that nor a typo. See js/fuzzy.js.

   ---- The thresholds ----

   Two bands, because the sheet should not make the same claim about
   a near-certain match and a faint one:

     DUPE_LIKELY    almost certainly the same thing
     DUPE_POSSIBLE  worth a look

   DUPE_POSSIBLE is set loose on purpose. There is a class of pair —
   one distinctive word shared inside a longer phrase — where no
   threshold can separate a true duplicate ("Eat at Noma" /
   "Dinner at Noma Copenhagen") from a false one ("Visit Paris" /
   "Paris Hilton documentary"); they score within a hundredth of each
   other. Given that, the tie goes to catching it: a false positive
   costs one tap, a missed duplicate is the exact problem the user
   came here to fix.
   ============================================================== */

const DUPE_LIKELY=.78;
const DUPE_POSSIBLE=.58;

/* How many to show. Past a handful the sheet stops being a question
   and becomes a list to read. */
const DUPE_MAX=4;

/* ==============================================================
   SCORING

   The name carries it, with the location used only to adjust: two
   activities called "Watch the sunrise" in different countries are
   not duplicates, and the place is the only thing that says so.
   ============================================================== */
function dupeScore(name,location,other){
  const s=similarity(name,other.name);
  /* Cheap exit — most rows are nowhere close, and there is no point
     scoring a location for them. */
  if(s<DUPE_POSSIBLE*.8) return s;

  if(location&&other.location){
    const ls=similarity(location,other.location);
    if(ls>=.6)      return Math.min(1,s+.08);
    if(ls<.25)      return s*.82;
  }
  return s;
}

/* Every activity that might be the same as this one, best first.
   `excludeId` keeps an activity from matching itself on edit. */
function findDupes(name,opts){
  const o=opts||{};
  const n=(name||'').trim();
  if(n.length<3) return [];
  const hits=[];
  for(const a of cachedActivities()){
    if(o.excludeId&&a.id===o.excludeId) continue;
    const score=dupeScore(n,o.location||'',a);
    if(score>=DUPE_POSSIBLE) hits.push({a,score});
  }
  return hits.sort((x,y)=>y.score-x.score).slice(0,DUPE_MAX);
}

/* ==============================================================
   THE GUARD

   The single entry point every add path goes through:

     dupeGuard({name, location, excludeId}, proceed)

   With no match it calls `proceed` synchronously — the fast path is
   genuinely unchanged, not merely quick. With a match it opens the
   sheet and `proceed` becomes what "Add anyway" does.
   ============================================================== */
let _dupeProceed=null,_dupeHits=[];

function dupeGuard(opts,proceed){
  const hits=findDupes(opts.name,opts);
  if(!hits.length){ proceed(); return; }
  _dupeProceed=proceed;
  _dupeHits=hits;
  renderDupeSheet(opts.name,hits);
  /* The scrim, Escape and a swipe down all reach closeModal() without
     passing through any button here, so the pending add is dropped
     there rather than in each of the three. Without it a dismissed
     sheet leaves a live callback that the *next* guard would inherit. */
  onSheetClose('dupeSheet',()=>{ _dupeProceed=null;_dupeHits=[]; });
  openModal('dupeSheet');
}

function renderDupeSheet(name,hits){
  const likely=hits[0].score>=DUPE_LIKELY;
  const lists=cachedCollections();

  $('dupeTitle').textContent=likely?'Already on your list':'Looks familiar';
  $('dupeLead').innerHTML=likely
    ? `You already have <strong>${esc(hits[0].a.name)}</strong>. Add
       &ldquo;${esc(name)}&rdquo; as well?`
    : `&ldquo;${esc(name)}&rdquo; looks close to ${hits.length===1
        ?'something you already have'
        :`${hits.length} things you already have`}. Have a look before adding it.`;

  $('dupeList').innerHTML=hits.map(({a,score})=>{
    const chip=activityListLabel(a,lists);
    const di=dateInfo(a);
    const thumb=a.photos&&a.photos.length
      ? `<img class="act-thumb" src="${a.photos[0]}" alt="" loading="lazy"/>` : '';
    return `<div class="dupe-row" onclick="dupeOpenExisting('${a.id}')">
      <span class="dupe-score${score>=DUPE_LIKELY?' strong':''}">${Math.round(score*100)}%</span>
      <span class="dupe-main">
        <span class="dupe-name">${esc(a.name)}</span>
        <span class="dupe-meta">
          ${chip?`<span class="list-chip">${esc(chip)}</span>`:''}
          ${a.completed?'<span class="badge b-done">Done</span>'
            :di.label?`<span class="badge b-${di.cls}">${esc(di.label)}</span>`:''}
        </span>
      </span>
      ${thumb}
      <span class="act-chevron">${icon('chevron-right')}</span>
    </div>`;
  }).join('');

  /* "Add anyway" is the primary and stays that way whichever band the
     match fell in. The app is guessing; the user is not. */
  $('dupeAddLabel').textContent=likely?'Add it anyway':'Add it';
}

/* Tapping a match abandons the add and opens what already exists —
   which is nearly always what someone wants once they see it. The
   pending add is dropped rather than held, so nothing can write
   later from a sheet the user has moved on from. */
function dupeOpenExisting(id){
  _dupeProceed=null;_dupeHits=[];
  closeModal('dupeSheet');
  /* Not onSheetClose(): closeModal has already fired this sheet's
     return by the time we get here, so a handler registered now would
     never run. The delay is the sheet's dismissal animation. */
  setTimeout(()=>openActDetail(id),240);
}

function dupeAddAnyway(){
  const fn=_dupeProceed;
  _dupeProceed=null;_dupeHits=[];
  closeModal('dupeSheet');
  if(fn) setTimeout(fn,180);
}

function dupeCancel(){
  _dupeProceed=null;_dupeHits=[];
  closeModal('dupeSheet');
}


