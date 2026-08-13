/* ==============================================================
   UP NEXT — every unfinished activity, pushed on top of Home.

   Home shows the four most pressing; this is the rest of them. It
   reuses `upNextRowHTML()` and `sortUpNext()` from home.js so the two
   screens can never disagree about what "next" means.

   Rows are grouped by target band — This month, This year, Next year
   and so on — rather than listed flat, because a long undifferentiated
   list of everything you have ever wanted to do is the thing this
   screen exists to make navigable.

   Grouping comes from targetBand() in utils.js, which buckets by an
   activity's *resolved* date rather than by the band it was given. An
   activity dated 5 September therefore sits under "This year" alongside
   the ones set to that band, and sorts above them, because 5 September
   comes before the 31 December the band resolves to.
   ============================================================== */

async function renderUpNext(){
  const body=$('upnextBody');
  /* Only when there is actually a wait. Rows are cached for the session
     (api.js), so on every visit after the first this screen paints from
     memory — and blanking it to a spinner first would turn an instant
     redraw into a visible flash of nothing. */
  if(!cacheWarm()) body.innerHTML='<div class="spinner"></div>';

  const lists=await fetchCollections();
  const acts=await fetchAllActivities(lists);
  const pending=sortUpNext(acts.filter(a=>!a.completed));

  $('upnextEyebrow').textContent=pending.length
    ? `${pending.length} to go`
    : 'All clear';

  if(!pending.length){
    body.innerHTML=`<div class="empty">${icon('sparkle')}
      <div class="empty-title">Nothing pending</div>
      <div class="empty-sub">Everything on your lists is done. Add something new whenever you think of it.</div>
    </div>`;
    return;
  }

  /* Bucket in one pass. `pending` is already sorted by resolved date, so
     each bucket keeps that order and dated activities land ahead of the
     band they share a window with. */
  const buckets=new Map();
  pending.forEach(a=>{
    const g=targetBand(a);
    if(!buckets.has(g.id)) buckets.set(g.id,{group:g,items:[]});
    buckets.get(g.id).items.push(a);
  });

  body.innerHTML=[...buckets.values()]
    .sort((x,y)=>x.group.order-y.group.order)
    .map(({group,items})=>`
      <div class="home-sec-head"><h2>${esc(group.label)}</h2><span class="upnext-count">${items.length}</span></div>
      <div class="up-list">${items.map(a=>upNextRowHTML(a,lists,'upnext')).join('')}</div>`)
    .join('');
}
