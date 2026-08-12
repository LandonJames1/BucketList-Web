/* ==============================================================
   DETAIL PAGE — one collection: progress bar, filters, activity list
   Renders as a list, a grid, or a map depending on curView.
   ============================================================== */

async function renderDetail(){
  const list=await fetchCollection(curListId);
  if(!list){nav('collections');return;}

  const cover=list.cover||randCover();
  $('detailHeroBg').style.backgroundImage=`url(${cover})`;
  $('detailTitle').textContent=list.name;
  $('detailDesc').textContent=list.description||'';

  const acts=await fetchActivitiesFor(curListId);
  const total=acts.length,done=acts.filter(a=>a.completed).length;
  const pct=total?Math.round(done/total*100):0;

  $('detailBar').innerHTML=`
    <div class="detail-bar-left">
      <div class="detail-progress">
        <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <span class="progress-label">${pct}% complete &middot; ${done}/${total}</span>
      </div>
    </div>
    <div class="detail-bar-right">
      <input class="detail-search" placeholder="Search..." oninput="renderActivitiesList()" id="detSearch"/>
      <button class="filter-btn ${curFilter==='all'?'active':''}" onclick="setFilter('all')">All</button>
      <button class="filter-btn ${curFilter==='pending'?'active':''}" onclick="setFilter('pending')">Pending</button>
      <button class="filter-btn ${curFilter==='completed'?'active':''}" onclick="setFilter('completed')">Completed</button>
      <div class="view-toggle">
        <button class="view-btn ${curView==='list'?'active':''}" onclick="setView('list')" title="List view">&#9776;</button>
        <button class="view-btn ${curView==='grid'?'active':''}" onclick="setView('grid')" title="Grid view">&#9638;</button>
        <button class="view-btn ${curView==='map'?'active':''}" onclick="setView('map')" title="Map view">&#x1F5FA;</button>
      </div>
    </div>`;

  renderActivitiesList();
}

async function renderActivitiesList(){
  const searchEl=$('detSearch');
  const search=searchEl?searchEl.value.toLowerCase():'';
  let acts=await fetchActivitiesFor(curListId);
  if(curFilter==='pending') acts=acts.filter(a=>!a.completed);
  if(curFilter==='completed') acts=acts.filter(a=>a.completed);
  if(search) acts=acts.filter(a=>a.name.toLowerCase().includes(search)||(a.description||'').toLowerCase().includes(search));
  acts.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));

  const addRow=`<div class="add-activity-row" onclick="openNewActivity()"><div class="add-icon">+</div><span>Add Activity</span></div>`;

  if(!acts.length&&!search&&curFilter==='all'){
    $('activitiesList').style.display='';
    $('mapContainer').classList.remove('active');
    $('activitiesList').innerHTML=addRow;
    return;
  }

  /* Handle map view */
  const mapEl=$('mapContainer');
  if(curView==='map'){
    $('activitiesList').style.display='none';
    mapEl.classList.add('active');
    renderMap(acts);
    return;
  } else {
    $('activitiesList').style.display='';
    mapEl.classList.remove('active');
  }

  $('activitiesList').classList.toggle('grid-view', curView==='grid');

  if(curView==='grid'){
    $('activitiesList').innerHTML=acts.map((a,i)=>{
      const di=dateInfo(a);
      const photoCell=a.photos&&a.photos.length
        ? `<div class="activity-card-photo"><img src="${a.photos[0]}" alt="" loading="lazy"/></div>`
        : `<div class="activity-card-photo"><div class="activity-card-photo-empty">Not Yet<br>Completed</div></div>`;
      return `<div class="activity-card" onclick="openDetModal('${a.id}')">
        <div class="activity-card-num">#${i+1}</div>
        ${photoCell}
        <div class="activity-card-body">
          <div class="activity-card-name">${esc(a.name)}</div>
          ${a.completed
            ? `<div class="activity-card-status done">Completed</div>`
            : (di.label ? `<span class="time-badge ${di.cls}">${di.label}</span>` : `<div class="activity-card-status pending">Pending</div>`)}
        </div>
      </div>`;
    }).join('')+`<div class="activity-card add-activity-card" onclick="openNewActivity()"><div class="add-icon">+</div><span>Add Activity</span></div>`;
    return;
  }

  $('activitiesList').innerHTML=acts.map((a,i)=>{
    const di=dateInfo(a);
    const photoCell=a.photos&&a.photos.length
      ? `<div class="activity-row-photo"><img src="${a.photos[0]}" alt="" loading="lazy"/></div>`
      : `<div class="activity-row-photo"><div class="activity-row-photo-empty">Not Yet<br>Completed</div></div>`;
    const compBtn=!a.completed?`<button class="row-action complete-act" onclick="event.stopPropagation();openComp('${a.id}')" title="Complete">&#x2713;</button>`:'';
    return `<div class="activity-row" onclick="openDetModal('${a.id}')">
      <div class="activity-num">${i+1}</div>
      ${photoCell}
      <div class="activity-row-info">
        <div class="activity-row-name">${esc(a.name)}</div>
        ${a.description?`<div class="activity-row-desc">${esc(a.description)}</div>`:''}
      </div>
      <div class="activity-row-date">${di.label ? `<span class="time-badge ${di.cls}">${di.label}</span>` : '—'}</div>
      <div class="activity-row-status ${a.completed?'done':'pending'}">${a.completed?'Completed':'Pending'}</div>
      <div class="activity-row-actions">
        ${compBtn}
        <button class="row-action" onclick="event.stopPropagation();openEditAct('${a.id}')" title="Edit">&#x270E;</button>
        <button class="row-action del" onclick="event.stopPropagation();showDeleteConfirm('activity','${a.id}')" title="Delete">&#x2715;</button>
      </div>
    </div>`;
  }).join('')+addRow;
}

function setFilter(f){
  curFilter=f;
  /* If map is active, just update markers without re-zooming */
  if(curView==='map'&&actMap){
    updateMapMarkers();
    return;
  }
  renderDetail();
}
function setView(v){curView=v;if(v!=='map'&&actMap){actMap.remove();actMap=null;detMapHomeBounds=null;}renderDetail();}
