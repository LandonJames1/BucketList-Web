/* ==============================================================
   UP NEXT — every unfinished activity, pushed on top of Home.

   Home shows the four most pressing; this is the rest of them. It
   reuses `upNextRowHTML()` and `sortUpNext()` from home.js so the two
   screens can never disagree about what "next" means.

   Rows are grouped by how soon they are due rather than listed flat: a
   long undifferentiated list of everything you have ever wanted to do
   is exactly the thing this screen exists to make navigable.
   ============================================================== */

/* Bands are derived from the urgency class dateInfo() already hands the
   badges, so a row's group always agrees with the colour of its label. */
const UPNEXT_GROUPS=[
  {id:'overdue', label:'Overdue',        match:c=>c==='overdue'},
  {id:'soon',    label:'Coming up',      match:c=>c==='urgent'||c==='soon'},
  {id:'later',   label:'Later this year',match:c=>c==='moderate'},
  {id:'distant', label:'Further out',    match:c=>c==='relaxed'},
  {id:'someday', label:'No fixed date',  match:c=>c==='forever'||c===''},
];

async function renderUpNext(){
  const body=$('upnextBody');
  body.innerHTML='<div class="spinner"></div>';

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

  /* Bucket in one pass, preserving the sort within each group. */
  const buckets={};
  pending.forEach(a=>{
    const cls=dateInfo(a).cls;
    const g=UPNEXT_GROUPS.find(g=>g.match(cls))||UPNEXT_GROUPS[UPNEXT_GROUPS.length-1];
    (buckets[g.id]=buckets[g.id]||[]).push(a);
  });

  body.innerHTML=UPNEXT_GROUPS
    .filter(g=>buckets[g.id]&&buckets[g.id].length)
    .map(g=>`
      <div class="home-sec-head"><h2>${esc(g.label)}</h2><span class="upnext-count">${buckets[g.id].length}</span></div>
      <div class="up-list">${buckets[g.id].map(a=>upNextRowHTML(a,lists,'upnext')).join('')}</div>`)
    .join('');
}
