/* ==============================================================
   HOME PAGE — stats strip and the featured collections grid
   
   ============================================================== */

async function renderHome(){
  const lists=await fetchCollections();
  const allActs=await fetchAllActivities(lists);
  const totalAct=allActs.length;
  const doneAct=allActs.filter(a=>a.completed).length;
  const pct=totalAct?Math.round(doneAct/totalAct*100):0;

  $('homeStats').innerHTML=`
    <div class="stats-strip-item"><div class="stats-strip-number">${lists.length}</div><div class="stats-strip-label">Collections</div></div>
    <div class="stats-strip-item"><div class="stats-strip-number">${totalAct}</div><div class="stats-strip-label">Activities</div></div>
    <div class="stats-strip-item"><div class="stats-strip-number">${doneAct}</div><div class="stats-strip-label">Accomplished</div></div>
    <div class="stats-strip-item"><div class="stats-strip-number">${pct}%</div><div class="stats-strip-label">Complete</div></div>`;

  const featured=lists.slice(0,3);
  if(!featured.length){
    $('featuredGrid').innerHTML=`
      <div class="collection-card-new" onclick="openNewList()" style="aspect-ratio:3/4">
        <div class="plus">+</div><span>Create your first collection</span>
      </div>`;
    return;
  }
  $('featuredGrid').innerHTML=featured.map(l=>{
    const acts=allActs.filter(a=>a.listId===l.id);
    const cnt=acts.length;
    const done=acts.filter(a=>a.completed).length;
    const cover=l.cover||randCover();
    return `<div class="featured-card" onclick="nav('detail','${l.id}')">
      <img src="${cover}" alt="" loading="lazy"/>
      <div class="featured-card-overlay">
        <div class="featured-card-title">${esc(l.name)}</div>
        <div class="featured-card-count">${cnt} items &middot; ${done} completed</div>
      </div>
    </div>`;
  }).join('');
}
