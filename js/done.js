/* ==============================================================
   ACCOMPLISHED — everything ever completed, pushed on top of Home.

   Home's "Recently accomplished" shelf shows the last six; this is the
   whole record. It reuses the same photo tiles, grouped by the month
   things were finished, because that is the axis this screen is read
   along — it is a record of when you did things, not a to-do list.

   Activities completed before the app started storing a date (or
   completed with the date cleared) have no month to file under, so they
   collect at the end.
   ============================================================== */

async function renderDone(){
  const body=$('doneBody');
  /* Only when there is actually a wait. Rows are cached for the session
     (api.js), so on every visit after the first this screen paints from
     memory — and blanking it to a spinner first would turn an instant
     redraw into a visible flash of nothing. */
  if(!cacheWarm()) body.innerHTML='<div class="spinner"></div>';

  const lists=await fetchCollections();
  const acts=await fetchAllActivities(lists);
  const done=acts.filter(a=>a.completed);

  $('doneEyebrow').textContent=done.length
    ? `${done.length} done`
    : 'Nothing yet';

  if(!done.length){
    body.innerHTML=`<div class="empty">${icon('check')}
      <div class="empty-title">Nothing accomplished yet</div>
      <div class="empty-sub">Tap the circle beside an activity to mark it done, and it will show up here.</div>
    </div>`;
    return;
  }

  /* Newest first; undated ones sort last rather than to the top, which
     is where an empty date string would otherwise put them. */
  done.sort((a,b)=>{
    if(!a.completedDate&&!b.completedDate)return 0;
    if(!a.completedDate)return 1;
    if(!b.completedDate)return -1;
    return new Date(b.completedDate)-new Date(a.completedDate);
  });

  const buckets=new Map();
  done.forEach(a=>{
    const key=a.completedDate?a.completedDate.slice(0,7):'undated';
    if(!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(a);
  });

  body.innerHTML=[...buckets.entries()].map(([key,items])=>`
      <div class="home-sec-head">
        <h2>${esc(monthLabel(key))}</h2>
        <span class="upnext-count">${items.length}</span>
      </div>
      <div class="shelf shelf-3">${items.map(a=>doneCardHTML(a)).join('')}</div>`)
    .join('');
}

/* "2026-09" → "September 2026", with the year dropped when it is the
   current one. */
function monthLabel(key){
  if(key==='undated') return 'No date recorded';
  const [y,m]=key.split('-').map(Number);
  const d=new Date(y,m-1,1);
  const opts={month:'long'};
  if(y!==new Date().getFullYear()) opts.year='numeric';
  return d.toLocaleDateString('en-US',opts);
}

function doneCardHTML(a){
  const photo=a.photos&&a.photos.length?a.photos[0]:null;
  return `<button class="rec-card" onclick="openActDetail('${a.id}')">
    <span class="rec-photo">${photo
      ? `<img src="${photo}" alt="" loading="lazy"/>`
      : `<span class="rec-photo-empty">${icon('check')}</span>`}</span>
    <span class="rec-name">${esc(a.name)}</span>
    ${a.completedDate?`<span class="rec-date">${esc(fmtDate(a.completedDate))}</span>`:''}
  </button>`;
}
