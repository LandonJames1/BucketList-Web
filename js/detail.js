/* ==============================================================
   COLLECTION DETAIL — banner, filter, and the activity list.

   Rendering is split in two on purpose:
     renderDetail()        builds the banner and the controls, and is
                           called on entry and after a mutation.
     renderActivitiesList() rebuilds only the list.
   Search and filter call the second one, so the search field never
   loses focus mid-typing.
   ============================================================== */

async function renderDetail(){
  const list=await fetchCollection(curListId);
  if(!list){nav('lists');return;}

  const acts=await fetchActivitiesFor(curListId);
  const total=acts.length,done=acts.filter(a=>a.completed).length;
  const pct=total?Math.round(done/total*100):0;
  const cover=list.cover||randCover();

  $('detBanner').innerHTML=`
    <img class="det-banner-img" src="${esc(cover)}" alt=""/>
    <div class="det-banner-scrim"></div>
    <div class="det-banner-body">
      <div class="det-banner-eyebrow">${total} ${total===1?'activity':'activities'} &middot; ${pct}% done</div>
      <div class="det-banner-title">${esc(list.name)}</div>
      ${list.description?`<div class="det-banner-desc">${esc(list.description)}</div>`:''}
      <div class="det-progress">
        <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
        <span class="det-progress-label">${done} of ${total}</span>
      </div>
    </div>`;

  /* The compact nav-bar title on this screen is the collection name. */
  $('navTitle').textContent=list.name;

  /* Controls are rebuilt here (not on every keystroke) so the search
     field keeps focus while typing. */
  $('detControls').innerHTML=`
    <div class="searchbar">
      <div class="searchfield" id="detSearchField">
        ${icon('search')}
        <input id="detSearch" type="search" placeholder="Search" autocomplete="off"
               inputmode="search" oninput="onDetailSearch()"/>
        <button class="search-clear" onclick="clearDetailSearch()" aria-label="Clear search">${icon('x','ic-xs')}</button>
      </div>
    </div>
    <div class="det-ctl-row">
      <div class="seg" id="detFilter">
        <button class="${curFilter==='all'?'active':''}" onclick="setFilter('all')">All</button>
        <button class="${curFilter==='pending'?'active':''}" onclick="setFilter('pending')">To Do</button>
        <button class="${curFilter==='completed'?'active':''}" onclick="setFilter('completed')">Done</button>
      </div>
      ${sortButtonHTML()}
    </div>`;

  renderActivitiesList();
}

/* The sort control sits beside the filter rather than becoming a fourth
   segment of it: the segments answer "which subset", sort answers "in
   what order", and four segments across a 320px phone leaves each one
   too narrow to read. It carries its current order as a label so the
   screen says how it is sorted without being opened, and goes tinted on
   anything but the default so a non-obvious order is never silent.
   Below 375px the label drops and the glyph stands alone — the same
   trade responsive.css makes for the collection name on an Up Next
   row. */
function sortButtonHTML(){
  const s=ACT_SORTS[curSort]||ACT_SORTS[DEFAULT_ACT_SORT];
  return `<button class="det-sort${curSort!==DEFAULT_ACT_SORT?' custom':''}"
      id="detSortBtn" onclick="openSortMenu()"
      aria-label="Sort by ${esc(s.label.toLowerCase())}">
    ${icon('sort','ic-sm')}<span class="det-sort-label">${esc(s.short)}</span>
  </button>`;
}

function onDetailSearch(){
  const f=$('detSearchField');
  if(f) f.classList.toggle('has-value',!!$('detSearch').value);
  renderActivitiesList();
}
function clearDetailSearch(){
  $('detSearch').value='';
  $('detSearchField').classList.remove('has-value');
  renderActivitiesList();
  $('detSearch').focus();
}

async function renderActivitiesList(){
  const searchEl=$('detSearch');
  const search=searchEl?searchEl.value.trim().toLowerCase():'';
  let acts=await fetchActivitiesFor(curListId);
  const totalAll=acts.length;

  if(curFilter==='pending')   acts=acts.filter(a=>!a.completed);
  if(curFilter==='completed') acts=acts.filter(a=>a.completed);
  if(search) acts=acts.filter(a=>
    a.name.toLowerCase().includes(search)||
    (a.description||'').toLowerCase().includes(search)||
    (a.location||'').toLowerCase().includes(search));
  acts=sortActivities(acts,curSort);

  const listEl=$('actsWrap'),mapEl=$('mapContainer');

  /* ---- Map view ---- */
  if(curView==='map'){
    listEl.style.display='none';
    mapEl.classList.add('active');
    renderMap(acts);
    return;
  }
  listEl.style.display='';
  mapEl.classList.remove('active');

  /* ---- Nothing to show ---- */
  if(!acts.length){
    if(search){
      listEl.innerHTML=`<div class="empty">${icon('search')}
        <div class="empty-title">No results</div>
        <div class="empty-sub">Nothing in this list matches “${esc(search)}”.</div></div>`;
      return;
    }
    if(curFilter!=='all'){
      listEl.innerHTML=`<div class="empty">${icon(curFilter==='completed'?'check-circle':'circle')}
        <div class="empty-title">${curFilter==='completed'?'Nothing finished yet':'All done'}</div>
        <div class="empty-sub">${curFilter==='completed'
          ? 'Tap the circle beside an activity to mark it accomplished.'
          : 'Every activity in this list is complete.'}</div></div>`;
      return;
    }
    /* Empty list: lead with the composer so the first idea goes
       straight in. */
    listEl.innerHTML=`<div class="empty" style="padding-bottom:24px">${icon('sparkle')}
        <div class="empty-title">Nothing here yet</div>
        <div class="empty-sub">Add your first activity below — the name is the only part you have to fill in.</div>
      </div>
      <div class="act-group">${composerHTML()}</div>`;
    focusComposer();
    return;
  }

  /* ---- Grid view (no composer; it belongs with the list) ---- */
  if(curView==='grid'){
    listEl.innerHTML=`<div class="acts-grid">${acts.map(a=>activityCardHTML(a)).join('')}</div>`;
    return;
  }

  /* ---- List view ---- */
  listEl.innerHTML=`<div class="act-group">
      ${acts.map(a=>activityRowHTML(a)).join('')}
      ${curFilter==='all'&&!search?composerHTML():''}
    </div>`;
  if(totalAll===0) focusComposer();
}

/* ==============================================================
   ROW / CARD MARKUP
   ============================================================== */
function activityRowHTML(a){
  const di=dateInfo(a);
  const thumb=a.photos&&a.photos.length
    ? `<img class="act-thumb" src="${a.photos[0]}" alt="" loading="lazy"/>` : '';
  /* Priority leads the meta line — it is what you are scanning for, and
     the rail down the leading edge points straight at it. It sits
     outside the dot-joined run: a capsule already reads as its own
     object and a separator after it looks like a typo. */
  const tag=priTagHTML(a);
  const bits=[];
  if(di.label) bits.push(`<span class="badge b-${di.cls}">${esc(di.label)}</span>`);
  /* The place name is wrapped in its own span because text-overflow
     does not reach the text of a flex item — without it the name is
     chopped mid-letter instead of ellipsised. */
  if(a.location) bits.push(`<span class="act-loc">${icon('pin','ic-xs')}<span>${esc(a.location)}</span></span>`);
  /* The whole row opens the activity, not just the text. The handler used
     to sit on .act-main, so the thumbnail and the chevron beside it — the
     part that most looks like "tap here to open" — were dead. The check
     button stops propagation, so it still toggles rather than opening. */
  return `<div class="act-row${a.completed?' done':''}${priClass(a)}" onclick="openActDetail('${a.id}')">
    <button class="act-check" onclick="event.stopPropagation();toggleComplete('${a.id}',${a.completed})"
            aria-label="${a.completed?'Mark as not done':'Mark as done'}">
      ${icon(a.completed?'check-circle':'circle')}
    </button>
    <button class="act-main">
      <span class="act-name">${esc(a.name)}</span>
      ${tag||bits.length?`<span class="act-meta">${tag}${bits.join('<span class="dot">·</span>')}</span>`:''}
    </button>
    ${thumb}
    <span class="act-chevron">${icon('chevron-right')}</span>
  </div>`;
}

function activityCardHTML(a){
  const photo=a.photos&&a.photos.length
    ? `<img src="${a.photos[0]}" alt="" loading="lazy"/>`
    : icon('photo');
  const di=dateInfo(a);
  /* The card gets the rail but not the tag: its body is a fixed
     skeleton so every tile in a row lines up, and there is no width
     beside the deadline badge for a second capsule anyway. */
  return `<button class="act-card${a.completed?' done':''}${priClass(a)}" onclick="openActDetail('${a.id}')">
    <span class="act-card-check" onclick="event.stopPropagation();toggleComplete('${a.id}',${a.completed})">
      ${icon('check')}
    </span>
    <span class="act-card-photo">${photo}</span>
    <span class="act-card-body">
      <span class="act-card-name">${esc(a.name)}</span>
      ${di.label?`<span class="badge b-${di.cls}">${esc(di.label)}</span>`:''}
    </span>
  </button>`;
}

/* ==============================================================
   QUICK-ADD COMPOSER
   Always the last row of the list. Return files the activity and
   keeps the caret in place, so a run of ideas goes in without
   opening anything.
   ============================================================== */
/* No "Details" button any more: Return opens the activity sheet, so it
   and the button did exactly the same thing, and two controls doing one
   job on a single row is clutter. The chevron says the field leads
   somewhere rather than filing on the spot. */
function composerHTML(){
  return `<div class="composer" id="composer">
    <span class="composer-icon">${icon('plus')}</span>
    <input id="composerInput" type="text" placeholder="Add an activity" maxlength="100"
           autocomplete="off" autocapitalize="sentences" enterkeyhint="next"
           oninput="onComposerInput()" onkeydown="onComposerKey(event)"/>
    <button class="composer-go" onclick="quickAddActivity()"
            aria-label="Add">${icon('chevron-right')}</button>
  </div>`;
}
function onComposerInput(){
  const c=$('composer');
  if(c) c.classList.toggle('has-text',!!$('composerInput').value.trim());
}
function onComposerKey(e){
  if(e.key==='Enter'){ e.preventDefault(); quickAddActivity(); }
}
function focusComposer(){
  const el=$('composerInput');
  if(el) el.focus();
}
