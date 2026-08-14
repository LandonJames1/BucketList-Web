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

  $('homeProgress').innerHTML=`
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
    </div>`;
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
    $('homeUpNext').innerHTML=`<div class="home-empty">${icon('sparkle')}
      <div class="home-empty-text">Nothing pending. Add something you want to do.</div></div>`;
    return;
  }
  $('homeUpNext').innerHTML=next.map(a=>upNextRowHTML(a,lists,'home')).join('');
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
  $('homeRecent').innerHTML=done.map(a=>{
    const photo=a.photos&&a.photos.length?a.photos[0]:null;
    return `<button class="rec-card" onclick="openActDetail('${a.id}')">
      <span class="rec-photo">${photo
        ? `<img src="${photo}" alt="" loading="lazy"/>`
        : `<span class="rec-photo-empty">${icon('check')}</span>`}</span>
      <span class="rec-name">${esc(a.name)}</span>
      <span class="rec-date">${esc(fmtDate(a.completedDate))}</span>
    </button>`;
  }).join('');
}

/* ==============================================================
   HOME QUICK ADD
   The composer here has no collection context, so on submit it asks
   which list the idea belongs to — unless there is only one, in
   which case it just files it.
   ============================================================== */
function onHomeComposerKey(e){
  if(e.key==='Enter'){ e.preventDefault(); homeQuickAdd(); }
}
function onHomeComposerInput(){
  const c=$('homeComposer');
  if(!c)return;
  const v=$('homeComposerInput').value.trim();
  c.classList.toggle('has-text',!!v);
  /* Pasting a link is the other way an activity gets created, and the
     composer is already the add control on this screen — so it changes
     what it does rather than Home growing a second button for it.
     See js/share.js. */
  const isLink=looksLikeUrl(v);
  c.classList.toggle('is-link',isLink);
  const go=$('homeComposerGo');
  if(go){
    /* The glyph is the whole tell that this will do something else —
       there is no room for a label beside a 100-character field. */
    go.innerHTML=icon(isLink?'link':'chevron-right');
    go.setAttribute('aria-label',isLink?'Import link':'Add');
  }
}

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
  if(looksLikeUrl(name)){ importFromComposer(); return; }

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
  openNewActivity(name);
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
