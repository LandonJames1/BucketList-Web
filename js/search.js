/* ==============================================================
   SEARCH — one field over everything.

   The detail screen has always had a search box, but it only ever
   searched the collection you were already standing in. That is the
   wrong shape for this app: the whole point is that an idea can be
   filed anywhere, so "where did I put that" is a question about the
   *whole* library, not about one list.

   A pushed screen rather than a tab: the tab bar is full at four, and
   search is something you arrive at with a question rather than a
   place you go to browse. It is reachable from the bar button on
   Home, Lists, Up Next and Accomplished.

   Matching is fuzzy (js/fuzzy.js), so a half-remembered or misspelt
   name still finds the row. Everything runs against the in-memory
   cache, which means it is instant and works offline.
   ============================================================== */

/* Below this a hit is noise. Tuned against matchScore's bands: a
   whole-word prefix scores ~.62 and up, the trigram fallback tops out
   at .55, so this keeps the weakest character-overlap hits out while
   letting every structural match through. */
const SEARCH_MIN=.34;

/* Weights per field. The name is what people mean nearly every time;
   a stray hit deep in a notes field must never outrank it. */
const SEARCH_ACT_WEIGHTS=[['name',1],['location',.8],['collection',.62],['description',.6],['completionNotes',.45]];

/* How many of each kind to draw. Past this the screen stops being an
   answer and becomes another list to search. */
const SEARCH_LIMIT=40;

let searchTerm='',searchFilter='all';

/* ==============================================================
   THE SCREEN
   ============================================================== */
function openSearch(){
  searchTerm='';searchFilter='all';
  nav('search');
}

async function renderSearch(){
  /* The field is part of the page, not rebuilt per keystroke — same
     reason renderDetail() splits in two. Rebuilding it here would
     drop focus on every character typed. */
  const field=$('searchInput');
  if(field&&field.value!==searchTerm) field.value=searchTerm;

  renderSearchFilter();
  await renderSearchResults();

  /* Opening the screen should put the caret in the field: arriving
     here is always a question, and making the user tap once more to
     start asking it is a wasted step. */
  if(!searchTerm&&field&&document.activeElement!==field){
    setTimeout(()=>field.focus(),320);
  }
}

function renderSearchFilter(){
  const seg=$('searchFilter');
  if(!seg)return;
  seg.querySelectorAll('button').forEach(b=>
    b.classList.toggle('active',b.dataset.f===searchFilter));
}

function onSearchInput(){
  searchTerm=$('searchInput').value;
  const f=$('searchField');
  if(f) f.classList.toggle('has-value',!!searchTerm);
  renderSearchResults();
}
function clearSearch(){
  searchTerm='';
  $('searchInput').value='';
  $('searchField').classList.remove('has-value');
  renderSearchResults();
  $('searchInput').focus();
}
function setSearchFilter(f){
  searchFilter=f;
  renderSearchFilter();
  renderSearchResults();
}

/* ==============================================================
   RUNNING THE SEARCH

   Returns scored hits rather than a filtered array, because the
   ranking is the useful part — with fuzzy matching a query returns a
   long tail of weak hits, and the order is what makes the top of the
   list the answer.
   ============================================================== */
function searchActivities(q,acts,lists){
  const byId={};
  lists.forEach(l=>{byId[l.id]=l.name;});
  /* Every list an activity is in, not just its home one — searching
     "Japan" has to find something filed into the Japan list from
     somewhere else, or the list name stops being a reliable way to
     find things the moment an activity is in two. */
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

function searchCollections(q,lists){
  return lists
    .map(l=>({l,score:scoreFields(q,[[l.name,1],[l.description,.6]])}))
    .filter(h=>h.score>=SEARCH_MIN)
    .sort((x,y)=>y.score-x.score);
}

async function renderSearchResults(){
  const box=$('searchResults');
  if(!box)return;
  const q=searchTerm.trim();

  if(!q){ box.innerHTML=searchIdleHTML(); return; }

  const lists=await fetchCollections();
  let acts=await fetchAllActivities(lists);
  if(searchFilter==='pending')   acts=acts.filter(a=>!a.completed);
  if(searchFilter==='completed') acts=acts.filter(a=>a.completed);

  const actHits=searchActivities(q,acts,lists);
  /* Lists are only offered under "All": the To do / Done filter is a
     statement about activities, and a collection is neither. */
  const listHits=searchFilter==='all'?searchCollections(q,lists):[];

  if(!actHits.length&&!listHits.length){
    box.innerHTML=`<div class="empty">${icon('search')}
      <div class="empty-title">No matches</div>
      <div class="empty-sub">Nothing anywhere matches &ldquo;${esc(q)}&rdquo;.</div>
      <button class="btn btn-tinted" onclick="searchAddAsNew()">Add it as an activity</button>
    </div>`;
    return;
  }

  let h='';
  if(listHits.length){
    h+=`<div class="srch-sec-head">${listHits.length} ${listHits.length===1?'list':'lists'}</div>
      <div class="group">${listHits.slice(0,SEARCH_LIMIT).map(({l})=>
        `<button class="row tappable has-leading" onclick="nav('detail','${l.id}')">
          <img class="srch-list-cover" src="${esc(l.cover||randCover())}" alt="" loading="lazy"/>
          <span class="row-body"><span class="row-title">${searchMark(l.name,q)}</span>
          ${l.description?`<span class="row-sub">${searchMark(l.description,q)}</span>`:''}</span>
          <span class="row-chevron">${icon('chevron-right')}</span>
        </button>`).join('')}</div>`;
  }
  if(actHits.length){
    h+=`<div class="srch-sec-head">${actHits.length} ${actHits.length===1?'activity':'activities'}</div>
      <div class="act-group">${actHits.slice(0,SEARCH_LIMIT)
        .map(({a})=>searchRowHTML(a,lists,q)).join('')}</div>`;
    if(actHits.length>SEARCH_LIMIT){
      h+=`<div class="srch-more">Showing the ${SEARCH_LIMIT} closest matches. Keep typing to narrow it down.</div>`;
    }
  }
  box.innerHTML=h;
}

/* The idle state carries the one thing worth saying — what is
   searched — rather than an empty rectangle. */
function searchIdleHTML(){
  return `<div class="empty">${icon('search')}
    <div class="empty-title">Search everything</div>
    <div class="empty-sub">Every activity in every list &mdash; names, places, notes
      and links. Spelling doesn&rsquo;t have to be exact.</div></div>`;
}

/* A row here has to say which list it came from — that is the whole
   difference from the per-collection search, and without it two
   similarly named activities are indistinguishable. */
function searchRowHTML(a,lists,q){
  const chip=activityListLabel(a,lists);
  const di=dateInfo(a);
  const thumb=a.photos&&a.photos.length
    ? `<img class="act-thumb" src="${a.photos[0]}" alt="" loading="lazy"/>` : '';
  const bits=[];
  if(chip) bits.push(`<span class="list-chip">${esc(chip)}</span>`);
  if(di.label) bits.push(`<span class="badge b-${di.cls}">${esc(di.label)}</span>`);
  if(a.location) bits.push(`<span class="act-loc">${icon('pin','ic-xs')}<span>${searchMark(a.location,q)}</span></span>`);

  return `<div class="act-row${a.completed?' done':''}${priClass(a)}" onclick="openActDetail('${a.id}')">
    <button class="act-check" onclick="event.stopPropagation();toggleCompleteFrom('search','${a.id}')"
            aria-label="${a.completed?'Mark as not done':'Mark as done'}">
      ${icon(a.completed?'check-circle':'circle')}
    </button>
    <button class="act-main">
      <span class="act-name">${searchMark(a.name,q)}</span>
      <span class="act-meta">${priTagHTML(a)}${bits.join('<span class="dot">·</span>')}</span>
    </button>
    ${thumb}
    <span class="act-chevron">${icon('chevron-right')}</span>
  </div>`;
}

/* ==============================================================
   HIGHLIGHTING

   Only the literal query substring is marked, not the fuzzy match.
   A fuzzy hit has no single span to point at — "kayakking" matching
   "kayaking" would need per-character marks that read as corruption
   rather than emphasis. So when there is an exact run to show we show
   it, and otherwise the row is simply unmarked.

   Escaping happens here, not at the call site: the marks are the one
   place in the app where a rendered string is deliberately not
   esc()'d wholesale, so the split has to be on the raw text and the
   escaping applied to each piece.
   ============================================================== */
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

/* Nothing matched, so offer the other thing the user might have
   meant: this is a new idea, not a lost one. Hands the typed text to
   the full activity sheet, which is where a list gets chosen. */
function searchAddAsNew(){
  const name=searchTerm.trim();
  if(!name)return;
  openNewActivity(name);
}
