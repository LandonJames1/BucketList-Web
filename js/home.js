/* ==============================================================
   HOME TAB — the dashboard.

   The app's answer to "what should I do next?". Everything here is
   derived from data the other screens already fetch; Home owns no
   state of its own.

   Sections, in order of usefulness:
     1. Progress ring — the whole list, at a glance
     2. Quick add    — file an idea without picking a list first
     3. Up Next      — the most urgent unfinished activities
     4. Recently done

   The lists shelf that used to close the page is gone: it duplicated
   the Lists tab sitting right there in the tab bar.
   ============================================================== */

async function renderHome(){
  /* The composer is static markup, so its dropdown survives navigation
     away and back. Whatever was typed stays; the list of answers to it
     does not reopen unprompted. */
  closeHomeSuggest();
  const lists=await fetchCollections();
  const acts=await fetchAllActivities(lists);

  renderHomeGreeting();
  renderHomeReminders(acts,lists);
  renderHomeProgress(lists,acts);
  renderHomeUpNext(acts,lists);
  renderHomeRecent(acts,lists);
}

/* ---- Header ----
   A fixed title rather than a time-of-day greeting: it is the app's
   name, so it should be the same every time you open it. The date still
   sits above it as the eyebrow. */
function renderHomeGreeting(){
  $('homeEyebrow').textContent=new Date().toLocaleDateString('en-US',
    {weekday:'long',month:'long',day:'numeric'});
  $('homeGreeting').innerHTML='Someday We&rsquo;ll <em>Die</em>';
}

/* ---- Progress ring ----
   An SVG ring rather than a bar: it is the one number worth showing
   large, and a ring reads at a glance from across the room. */
function renderHomeProgress(lists,acts){
  const total=acts.length;
  const done=acts.filter(a=>a.completed).length;
  const pct=total?Math.round(done/total*100):0;
  const R=52, C=2*Math.PI*R;
  const offset=C*(1-pct/100);

  setHTML($('homeProgress'),`
    <div class="hp-ring">
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <circle class="hp-track" cx="64" cy="64" r="${R}"/>
        <circle class="hp-fill"  cx="64" cy="64" r="${R}"
                stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
      </svg>
      <div class="hp-ring-label">
        <div class="hp-pct">${pct}<span>%</span></div>
        <div class="hp-cap">Complete</div>
      </div>
    </div>
    <div class="hp-stats">
      <div class="hp-stat"><div class="hp-num">${done}</div><div class="hp-lab">Accomplished</div></div>
      <div class="hp-stat"><div class="hp-num">${total-done}</div><div class="hp-lab">To go</div></div>
      <div class="hp-stat"><div class="hp-num">${lists.length}</div><div class="hp-lab">${lists.length===1?'List':'Lists'}</div></div>
    </div>`);
}

/* ---- Up Next ----
   The four most pressing unfinished activities.

   Ordered by deadline first and priority second, not the other way
   round: something due this month outranks a high-priority "someday",
   because the deadline is the part you cannot move. Priority breaks ties
   within the same urgency band, which is where it actually helps. */
function renderHomeUpNext(acts,lists){
  const pending=sortUpNext(acts.filter(a=>!a.completed));
  const next=pending.slice(0,4);

  /* Always offered, for the same reason as the Accomplished shelf: a
     control that appears only past a threshold is one people never find. */
  const all=$('homeUpNextAll');
  if(all) all.style.display=pending.length?'':'none';

  if(!next.length){
    setHTML($('homeUpNext'),`<div class="home-empty">${icon('sparkle')}
      <div class="home-empty-text">Nothing pending. Add something you want to do.</div></div>`);
    return;
  }
  setHTML($('homeUpNext'),next.map(a=>upNextRowHTML(a,lists,'home')).join(''));
}

/* Shared by Home and the Up Next screen so the two cannot drift.
   `source` tells toggleCompleteFrom which screen to re-render. */
function upNextRowHTML(a,lists,source){
  const chip=activityListLabel(a,lists);
  const di=dateInfo(a);
  /* Row-level handler, so the chevron and the whole row open the activity
     — see the note in activityRowHTML(). */
  return `<div class="up-row${priClass(a)}" onclick="openActDetail('${a.id}')">
    <button class="act-check" onclick="event.stopPropagation();toggleCompleteFrom('${source}','${a.id}')"
            aria-label="Mark as done">${icon('circle')}</button>
    <button class="up-main">
      <span class="up-name">${esc(a.name)}</span>
      <span class="up-meta">
        ${priTagHTML(a)}
        <span class="list-chip">${esc(chip)}</span>
        ${di.label?`<span class="badge b-${di.cls}">${esc(di.label)}</span>`:''}
      </span>
    </button>
    <span class="act-chevron">${icon('chevron-right')}</span>
  </div>`;
}

/* Deadline first, priority second, newest last. Shared so Home's four
   and the full screen agree on what "next" means.

   Sorted on actual days remaining, not the urgency band: the band is
   what colours the badge, but it is too coarse to order by — a flight
   tomorrow and something three weeks out are both "urgent", and ranking
   by band would let priority push the flight below it. */
function sortUpNext(acts){
  return acts.slice().sort((a,b)=>
    daysToTarget(a)-daysToTarget(b) ||
    priorityRank(a)-priorityRank(b) ||
    new Date(b.createdAt)-new Date(a.createdAt));
}

/* ---- Recently accomplished ---- */
function renderHomeRecent(acts,lists){
  /* Two rows of three at most: the shelf is a taster, the full record
     lives behind "See all". */
  const done=acts.filter(a=>a.completed&&a.completedDate)
    .sort((a,b)=>new Date(b.completedDate)-new Date(a.completedDate))
    .slice(0,6);
  const sec=$('homeRecentSection');
  if(!done.length){sec.style.display='none';return;}
  sec.style.display='';

  /* Always offered, not only once there is more than the shelf shows.
     Hiding it below the cut made the whole Accomplished screen
     undiscoverable for anyone with a short history — which is exactly
     who is still learning where things are. A predictable affordance
     beats a clever one. */
  const all=$('homeRecentAll');
  if(all) all.style.display='';
  setHTML($('homeRecent'),done.map(a=>{
    const photo=a.photos&&a.photos.length?a.photos[0]:null;
    return `<button class="rec-card" onclick="openActDetail('${a.id}')">
      <span class="rec-photo">${photo
        ? `<img src="${photo}" alt="" loading="lazy"/>`
        : `<span class="rec-photo-empty">${icon('check')}</span>`}</span>
      <span class="rec-name">${esc(a.name)}</span>
      <span class="rec-date">${esc(fmtDate(a.completedDate))}</span>
    </button>`;
  }).join(''));
}

/* ==============================================================
   HOME QUICK ADD
   The composer here has no collection context, so on submit it asks
   which list the idea belongs to — unless there is only one, in
   which case it just files it.
   ============================================================== */
function onHomeComposerKey(e){
  if(e.key==='Enter'){ e.preventDefault(); homeQuickAdd(); }
  /* Escape closes the suggestions without clearing what was typed —
     the field is still an add field and the text is still wanted. */
  if(e.key==='Escape') closeHomeSuggest();
}
function onHomeComposerInput(){
  const c=$('homeComposer');
  if(!c)return;
  const v=$('homeComposerInput').value.trim();
  c.classList.toggle('has-text',!!v);
  updateHomeSuggest();
}

/* ==============================================================
   FINDING WHAT YOU ALREADY HAVE, FROM THE SAME FIELD

   People arrive at Home with one of two things in mind — "put this
   somewhere" and "where did I put that" — and the composer was only
   ever an answer to the first. Typing "kayak" into it was a way to
   create a second kayaking activity beside the one already there.

   So it answers both. **It never blocks the add**: this only draws a
   dropdown, Return still opens the plan-or-record chooser, and a query
   matching nothing shows nothing. That is the whole contract, and it is
   what lets the field keep its old job unchanged.

   Deliberately synchronous, against the in-memory cache — the same
   thing dupeGuard() reads. Scoring every activity on a keystroke is
   cheap; a network round trip per keystroke is not, and a spinner under
   a field you are typing into would be worse than no feature. A cold
   cache means nothing to search, and the dropdown simply stays shut.

   It is not a replacement for the Search screen (the bar button is
   still there): five rows under a composer, activities only, no
   collections and no filters.
   ============================================================== */
const HOME_SUGGEST_MAX=5;
const HOME_SUGGEST_MIN_CHARS=2;

/* Below this a hit is noise. Tuned against matchScore's bands: a whole-
   word prefix scores ~.62 and up, the trigram fallback tops out at .55,
   so this keeps the weakest character-overlap hits out while letting
   every structural match through. */
const SEARCH_MIN=.34;

/* Weights per field. The name is what people mean nearly every time; a
   stray hit deep in a notes field must never outrank it. */
const SEARCH_ACT_WEIGHTS=[['name',1],['location',.8],['collection',.62],['completionNotes',.45]];

/* Returns scored hits rather than a filtered array, because the ranking
   is the useful part — with fuzzy matching a query returns a long tail
   of weak hits, and the order is what makes the top of the list the
   answer.

   This and searchMark() below are all that survives of the Search
   screen, which this composer replaced. They live here because the
   composer is now their only caller; the tuning notes above are the
   reason not to "simplify" the constants. */
function searchActivities(q,acts,lists){
  const byId={};
  lists.forEach(l=>{byId[l.id]=l.name;});
  /* Every list an activity is in, not just its home one — searching
     "Japan" has to find something filed into the Japan list from
     somewhere else, or the list name stops being a reliable way to find
     things the moment an activity is in two. */
  const listNames=a=>(a.listIds||[a.listId]).map(id=>byId[id]||'').filter(Boolean).join(' ');
  const out=[];
  for(const a of acts){
    const fields=SEARCH_ACT_WEIGHTS.map(([k,w])=>
      [k==='collection'?listNames(a):a[k],w]);
    /* Links are searched as a group: people do remember "that tiktok
       one", and the URL is the only place that shows up. */
    if(a.links&&a.links.length) fields.push([a.links.join(' '),.4]);
    const score=scoreFields(q,fields);
    if(score>=SEARCH_MIN) out.push({a,score});
  }
  return out.sort((x,y)=>y.score-x.score||
    /* Ties break toward what is still to do — a finished thing is a
       record, an unfinished one is an answer you can act on. */
    (x.a.completed-y.a.completed)||
    new Date(y.a.createdAt)-new Date(x.a.createdAt));
}

/* Only the literal query substring is marked, never the fuzzy match. A
   fuzzy hit has no single span to point at — "kayakking" matching
   "kayaking" would need per-character marks that read as corruption
   rather than emphasis. So when there is an exact run to show we show
   it, and otherwise the row is simply unmarked.

   Escaping happens here, not at the call site: this is the one place in
   the app where a rendered string is deliberately not esc()'d wholesale,
   so the split has to be on the raw text and the escaping applied to
   each piece. Don't "simplify" it. */
function searchMark(text,q){
  const s=text||'';
  const term=(q||'').trim();
  if(!term) return esc(s);
  const at=s.toLowerCase().indexOf(term.toLowerCase());
  if(at<0) return esc(s);
  return esc(s.slice(0,at))+
    '<mark>'+esc(s.slice(at,at+term.length))+'</mark>'+
    esc(s.slice(at+term.length));
}

function closeHomeSuggest(){
  const box=$('homeSuggest');
  if(box){ box.classList.remove('open'); box.innerHTML=''; }
}

function updateHomeSuggest(){
  const box=$('homeSuggest'),input=$('homeComposerInput');
  if(!box||!input)return;
  const q=input.value.trim();

  if(q.length<HOME_SUGGEST_MIN_CHARS) return closeHomeSuggest();

  /* Nothing to compare against, so nothing is claimed. Same failure
     shape as duplicate detection, which reads the same cache — both
     return [] rather than null when it has never been filled. */
  const acts=cachedActivities(),lists=cachedCollections();
  if(!acts.length) return closeHomeSuggest();

  const hits=searchActivities(q,acts,lists).slice(0,HOME_SUGGEST_MAX);
  if(!hits.length) return closeHomeSuggest();

  box.innerHTML=`<div class="home-suggest-head">Already on your lists</div>`+
    hits.map(({a})=>homeSuggestRowHTML(a,lists,q)).join('');
  box.classList.add('open');
}

function homeSuggestRowHTML(a,lists,q){
  const chip=activityListLabel(a,lists);
  const di=a.completed?null:dateInfo(a);
  const bits=[];
  if(chip) bits.push(`<span class="list-chip">${esc(chip)}</span>`);
  if(a.completed) bits.push(`<span class="badge b-done">Accomplished</span>`);
  else if(di&&di.label) bits.push(`<span class="badge b-${di.cls}">${esc(di.label)}</span>`);

  /* searchMark() is the one place a rendered string is not esc()'d
     wholesale — it splits on the raw text and escapes each piece. */
  return `<button class="home-suggest-item${a.completed?' done':''}"
      onclick="openHomeSuggest('${a.id}')">
    ${icon(a.completed?'check-circle':'circle')}
    <span class="home-suggest-body">
      <span class="home-suggest-name">${searchMark(a.name,q)}</span>
      <span class="home-suggest-meta">${bits.join('')}</span>
    </span>
    <span class="home-suggest-chevron">${icon('chevron-right')}</span>
  </button>`;
}

/* Taking the row clears the field. The text was a question, it has been
   answered, and leaving it behind means the next tap on the go arrow
   files a duplicate of the thing just opened. */
function openHomeSuggest(id){
  const input=$('homeComposerInput');
  if(input){ input.value=''; }
  closeHomeSuggest();
  onHomeComposerInput();
  openActDetail(id);
}

/* Same dismissal as the location dropdown: a tap anywhere outside the
   composer closes it. Delegated from the document so nothing that
   renders Home has to bind it. */
document.addEventListener('click',e=>{
  const box=$('homeSuggest');
  if(!box||!box.classList.contains('open'))return;
  if(!box.parentElement.contains(e.target)) closeHomeSuggest();
});

/* Home's composer hands off to the full activity sheet rather than
   filing the activity on the spot.

   It used to insert immediately with nothing but a name, which made it
   the fastest path in the app and also the one that produced the worst
   rows: no list chosen, no priority, and — the real damage — no target
   date, so the thing sank to the bottom of Up Next and was never seen
   again. An idea captured into a hole is not captured.

   The in-list composer still inserts on Return (see quickAddActivity),
   because standing inside a collection has already answered the only
   question this sheet exists to ask. Home has no collection context, so
   it has to ask anyway — and once a sheet is opening, showing the rest
   of the fields costs nothing.

   openNewActivity() seeds the sheet: DEFAULT_TARGET_DATE, medium
   priority, and the List row so the destination is a visible choice
   rather than a guess. saveActivity() runs the duplicate check, so
   there is none here. */
async function homeQuickAdd(){
  const input=$('homeComposerInput');
  const name=input.value.trim();
  if(!name){shakeEl(input);return;}
  const lists=await fetchCollections();
  if(!lists.length){
    /* Nowhere to put it yet — open the list sheet and keep the text. */
    showToast('Create a list first');
    openNewList();
    $('lName').value=name;
    input.value='';onHomeComposerInput();
    return;
  }

  /* Cleared before the sheet opens: the name lives in the sheet now,
     and leaving it behind here means it is sitting in two places and
     can be filed twice. */
  input.value='';onHomeComposerInput();
  /* Asks whether this is a plan or a record before either sheet opens —
     see startNewActivity(). */
  startNewActivity(name);
}

/* Completing from Home has no curListId, so the stats update needs the
   activity's own collection. */
async function toggleCompleteFrom(source,id){
  const a=await fetchActivity(id);
  if(!a)return;
  /* Completing goes through the completion sheet — see toggleComplete. */
  if(!a.completed){ openCompletedDate(id,source); return; }
  const{error}=await dbUpdate('Activities',{date_completed:null},{id});
  if(error){
    console.error('toggleCompleteFrom:',error);
    showToast(error.message||'Couldn’t update that.');
    return;
  }
  await updateCollectionStats(a.listId);
  refreshAfterChange(source);
}
