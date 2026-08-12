/* ==============================================================
   MAPS (Leaflet) — shared markers/clusters, detail map, global map
   
   ============================================================== */

let actMap=null;
/* Shared function to create a marker for an activity */
function createActMarker(a){
  const photo=a.photos&&a.photos.length?a.photos[0]:null;
  const pinSize=44;
  const shortName=a.name.length>18?a.name.substring(0,16)+'…':a.name;
  const labelHtml=`<div style="position:absolute;left:50%;transform:translateX(-50%);top:${pinSize+4}px;white-space:nowrap;font-family:var(--mono);font-size:.58rem;font-weight:600;letter-spacing:.5px;color:var(--text2);text-align:center;max-width:110px;overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 3px var(--bg),0 0 3px var(--bg)">${esc(shortName)}</div>`;
  const borderColor=a.completed?'var(--olive)':'var(--terra)';
  const icon=L.divIcon({
    className:'',
    iconSize:[pinSize,pinSize+16],
    iconAnchor:[pinSize/2,pinSize],
    popupAnchor:[0,-pinSize],
    html:photo
      ?`<div style="position:relative"><div style="width:${pinSize}px;height:${pinSize}px;border-radius:50%;border:3px solid ${borderColor};overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.3);background:var(--bg2)"><img src="${photo}" style="width:100%;height:100%;object-fit:cover"/></div>${labelHtml}</div>`
      :`<div style="position:relative"><div style="width:${pinSize}px;height:${pinSize}px;border-radius:50%;background:${borderColor};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center"><div style="width:10px;height:10px;border-radius:50%;background:#fff"></div></div>${labelHtml}</div>`
  });
  const popup=`<div class="map-popup">
    ${photo?`<img src="${photo}" alt=""/>`:''}
    <div class="map-popup-name">${esc(a.name)}</div>
    <div class="map-popup-loc">${esc(a.location)}</div>
    <div class="map-popup-status ${a.completed?'done':'pending'}">${a.completed?'Completed':'Pending'}</div>
    <button class="map-popup-btn" onclick="openDetModal('${a.id}')">View Details</button>
  </div>`;
  const marker=L.marker([parseFloat(a.locationLat),parseFloat(a.locationLng)],{icon}).bindPopup(popup);
  marker._actData=a; /* stash for filtering */
  return marker;
}

/* Shared cluster config */
function makeClusterGroup(){
  const c=L.markerClusterGroup({
    maxClusterRadius:80,
    spiderfyOnMaxZoom:true,
    showCoverageOnHover:false,
    zoomToBoundsOnClick:false,
    spiderfyDistanceMultiplier:3,
    iconCreateFunction:function(cluster){
      const count=cluster.getChildCount();
      let sz='small';
      if(count>=10) sz='large';
      else if(count>=5) sz='medium';
      return L.divIcon({
        html:`<div>${count}</div>`,
        className:'marker-cluster marker-cluster-'+sz,
        iconSize:[52,52]
      });
    }
  });
  return c;
}

/* Shared cluster click handler */
function attachClusterClick(mapObj,clusters){
  clusters.on('clusterclick',function(e){
    const cluster=e.layer;
    const childMarkers=cluster.getAllChildMarkers();
    const clusterBounds=cluster.getBounds();
    const allSame=childMarkers.every(m=>{
      const ll=m.getLatLng();
      const first=childMarkers[0].getLatLng();
      return Math.abs(ll.lat-first.lat)<0.0001&&Math.abs(ll.lng-first.lng)<0.0001;
    });
    if(allSame){
      /* All markers at same point – spiderfy immediately with lines */
      cluster.spiderfy();
    } else {
      mapObj.fitBounds(clusterBounds,{padding:[60,60],maxZoom:16,animate:true});
    }
  });
}

/* Add home button to a map */
function addHomeBtn(mapObj,mapEl,homeBounds){
  const homeBtn=L.DomUtil.create('button','map-home-btn');
  homeBtn.innerHTML='&#x1F3E0;';
  homeBtn.title='Reset view';
  homeBtn.onclick=function(e){
    L.DomEvent.stopPropagation(e);
    if(homeBounds) mapObj.fitBounds(homeBounds,{padding:[60,60],maxZoom:12,animate:true});
    else mapObj.setView([20,0],2,{animate:true});
  };
  mapEl.appendChild(homeBtn);
  return homeBtn;
}

/* ---- Detail-page map (collection-specific) ---- */
let detMapClusters=null,detMapAllMarkers=[];

function renderMap(acts){
  const mapEl=$('mapContainer');
  const geoActs=acts.filter(a=>a.locationLat&&a.locationLng);

  if(actMap){actMap.remove();actMap=null;detMapHomeBounds=null;}
  detMapClusters=null;detMapAllMarkers=[];

  if(!geoActs.length){
    mapEl.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:var(--mono);font-size:.8rem;color:var(--text3);letter-spacing:1px;text-transform:uppercase">No activities with locations yet</div>';
    return;
  }

  mapEl.innerHTML='';
  actMap=L.map(mapEl,{scrollWheelZoom:true}).setView([20,0],2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{
    attribution:'&copy; OpenStreetMap &copy; CARTO',
    maxZoom:18,
    subdomains:'abcd'
  }).addTo(actMap);

  detMapClusters=makeClusterGroup();
  attachClusterClick(actMap,detMapClusters);

  const bounds=[];
  geoActs.forEach(a=>{
    const lat=parseFloat(a.locationLat),lng=parseFloat(a.locationLng);
    if(isNaN(lat)||isNaN(lng))return;
    bounds.push([lat,lng]);
    const marker=createActMarker(a);
    detMapAllMarkers.push(marker);
    detMapClusters.addLayer(marker);
  });

  actMap.addLayer(detMapClusters);

  if(bounds.length===1){
    actMap.setView(bounds[0],10);
    detMapHomeBounds=L.latLngBounds(bounds).pad(0.5);
  } else if(bounds.length>1){
    detMapHomeBounds=L.latLngBounds(bounds);
    actMap.fitBounds(detMapHomeBounds,{padding:[60,60],maxZoom:12});
  }

  addHomeBtn(actMap,mapEl,detMapHomeBounds);
  setTimeout(()=>actMap.invalidateSize(),200);
}

/* Update detail map markers without re-zoom (for filter changes) */
async function updateMapMarkers(){
  if(!actMap||!detMapClusters)return;
  let acts=await fetchActivitiesFor(curListId);
  if(curFilter==='pending') acts=acts.filter(a=>!a.completed);
  if(curFilter==='completed') acts=acts.filter(a=>a.completed);
  const searchEl=$('detSearch');
  const search=searchEl?searchEl.value.toLowerCase():'';
  if(search) acts=acts.filter(a=>a.name.toLowerCase().includes(search)||(a.description||'').toLowerCase().includes(search));

  const visibleIds=new Set(acts.map(a=>a.id));
  detMapClusters.clearLayers();
  detMapAllMarkers.forEach(m=>{
    if(visibleIds.has(m._actData.id)) detMapClusters.addLayer(m);
  });

  /* Update filter buttons */
  $('detailBar').querySelectorAll('.filter-btn').forEach(btn=>{
    const f=btn.textContent.toLowerCase();
    btn.classList.toggle('active',f===curFilter);
  });
}

/* ---- Global Map page ---- */
async function renderGlobalMap(){
  const mapEl=$('globalMapContainer');

  /* Render the filter bar */
  $('globalMapBar').innerHTML=`
    <div class="detail-bar-right" style="justify-content:center;width:100%">
      <button class="filter-btn ${globalMapFilter==='all'?'active':''}" onclick="setGlobalMapFilter('all')">All</button>
      <button class="filter-btn ${globalMapFilter==='pending'?'active':''}" onclick="setGlobalMapFilter('pending')">Pending</button>
      <button class="filter-btn ${globalMapFilter==='completed'?'active':''}" onclick="setGlobalMapFilter('completed')">Completed</button>
    </div>`;

  /* If the map already exists, just update markers */
  if(globalMapObj){
    updateGlobalMapMarkers();
    setTimeout(()=>globalMapObj.invalidateSize(),200);
    return;
  }

  mapEl.innerHTML='';
  globalMapObj=L.map(mapEl,{scrollWheelZoom:true}).setView([20,0],2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{
    attribution:'&copy; OpenStreetMap &copy; CARTO',
    maxZoom:18,
    subdomains:'abcd'
  }).addTo(globalMapObj);

  globalMapClusters=makeClusterGroup();
  attachClusterClick(globalMapObj,globalMapClusters);

  const allActs=await fetchAllActivities();
  const geoActs=allActs.filter(a=>a.locationLat&&a.locationLng);

  if(!geoActs.length){
    mapEl.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:var(--mono);font-size:.8rem;color:var(--text3);letter-spacing:1px;text-transform:uppercase">No activities with locations yet</div>';
    globalMapObj=null;
    return;
  }

  const bounds=[];
  globalMapAllMarkers=[];
  geoActs.forEach(a=>{
    const lat=parseFloat(a.locationLat),lng=parseFloat(a.locationLng);
    if(isNaN(lat)||isNaN(lng))return;
    bounds.push([lat,lng]);
    const marker=createActMarker(a);
    globalMapAllMarkers.push(marker);
    globalMapClusters.addLayer(marker);
  });

  globalMapObj.addLayer(globalMapClusters);

  if(bounds.length===1){
    globalMapObj.setView(bounds[0],10);
    globalMapHomeBounds=L.latLngBounds(bounds).pad(0.5);
  } else if(bounds.length>1){
    globalMapHomeBounds=L.latLngBounds(bounds);
    globalMapObj.fitBounds(globalMapHomeBounds,{padding:[60,60],maxZoom:12});
  }

  addHomeBtn(globalMapObj,mapEl,globalMapHomeBounds);
  setTimeout(()=>globalMapObj.invalidateSize(),200);
}

function updateGlobalMapMarkers(){
  if(!globalMapObj||!globalMapClusters)return;
  globalMapClusters.clearLayers();
  globalMapAllMarkers.forEach(m=>{
    const a=m._actData;
    if(globalMapFilter==='pending'&&a.completed)return;
    if(globalMapFilter==='completed'&&!a.completed)return;
    globalMapClusters.addLayer(m);
  });
}

function setGlobalMapFilter(f){
  globalMapFilter=f;
  /* Update buttons */
  $('globalMapBar').querySelectorAll('.filter-btn').forEach(btn=>{
    btn.classList.toggle('active',btn.textContent.toLowerCase()===f);
  });
  updateGlobalMapMarkers();
}
