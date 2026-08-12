/* ==============================================================
   MAPS — MapLibre GL JS.

   Why not Leaflet: Leaflet is a DOM/raster map. It cannot show a
   globe, and every pan repositions hundreds of DOM nodes, which is
   what made the old map feel heavy. MapLibre renders on the GPU and
   ships a real globe projection — zoomed out you get the Earth as a
   sphere, and it eases into flat web-mercator as you zoom in, the
   way Google Earth/Maps behaves.

   Two maps live here:
     globalMapObj — the Map tab, full-bleed, globe projection
     actMap       — the per-collection map inside the detail screen

   Clustering is done by the GeoJSON source itself (in a worker), not
   on the main thread. Cluster bubbles are GPU layers; only the handful
   of *unclustered* pins become DOM markers, so the node count stays
   tiny however many activities exist.
   ============================================================== */

let actMap=null;

/* Raster basemap — no API key, and the same CARTO tiles the app used
   before, so nothing new needs allow-listing. */
const TILE_URL='https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png';
const MAP_ATTRIB='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

function mapStyle(){
  return {
    version:8,
    sources:{
      carto:{
        type:'raster',
        tiles:['a','b','c','d'].map(s=>TILE_URL.replace('{s}',s)),
        tileSize:256,
        maxzoom:19,
        attribution:MAP_ATTRIB,
      },
    },
    layers:[
      /* Shows through wherever a tile has not loaded, and colours the
         sphere's unloaded edges. */
      {id:'bg',type:'background',paint:{'background-color':'#dfe6ea'}},
      {id:'carto',type:'raster',source:'carto',paint:{'raster-fade-duration':160}},
    ],
    /* The globe lives in the style, which is where MapLibre v5 reads it
       from; the map option alone is not enough. */
    projection:{type:'globe'},
    /* Atmosphere around the globe when zoomed out. */
    sky:{
      'sky-color':'#87b3d9','horizon-color':'#e6eef2','fog-color':'#e6eef2',
      'sky-horizon-blend':.6,'horizon-fog-blend':.6,'fog-ground-blend':.15,
    },
  };
}

/* MapLibre needs WebGL. Without it, say so rather than showing a blank
   rectangle. */
function webglOK(){
  try{
    const c=document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (c.getContext('webgl')||c.getContext('experimental-webgl')));
  }catch(e){ return false; }
}

function emptyMapHTML(title,sub){
  return `<div class="map-empty"><div class="empty">${icon('pin')}
    <div class="empty-title">${esc(title||'No places yet')}</div>
    <div class="empty-sub">${esc(sub||'Add a location to an activity and it will show up here.')}</div>
  </div></div>`;
}

/* Activities → GeoJSON, the shape the clustering source wants. */
function actsToGeoJSON(acts){
  return {
    type:'FeatureCollection',
    features:acts.filter(a=>a.locationLat&&a.locationLng).map(a=>({
      type:'Feature',
      geometry:{type:'Point',coordinates:[parseFloat(a.locationLng),parseFloat(a.locationLat)]},
      properties:{
        id:a.id,name:a.name,done:a.completed?1:0,
        photo:(a.photos&&a.photos[0])||'',location:a.location||'',
      },
    })),
  };
}

/* The DOM for one unclustered pin. */
function makePinEl(p){
  const el=document.createElement('button');
  el.className='map-pin '+(p.done?'done':'pending');
  el.setAttribute('aria-label',p.name);
  el.innerHTML=p.photo ? `<img src="${p.photo}" alt=""/>` : `<span class="map-pin-dot"></span>`;
  el.onclick=e=>{e.stopPropagation();openActDetail(p.id);};
  return el;
}

/* ==============================================================
   SHARED SET-UP — clustered source, cluster layers, and the marker
   syncing that keeps unclustered pins in step with the viewport.
   ============================================================== */
function attachActivityLayer(map,geojson,state){
  map.addSource('acts',{
    type:'geojson',
    data:geojson,
    cluster:true,
    clusterRadius:56,
    clusterMaxZoom:13,
    /* Sum of completed children, so a cluster can be tinted by whether
       everything inside it is done. */
    clusterProperties:{done:['+',['get','done']]},
  });

  /* One invisible layer, purely so the source generates tiles for the
     viewport. Everything visible is a DOM marker below.

     Clusters are *computed* in MapLibre's worker (fast, off the main
     thread) but *drawn* as DOM, for two reasons: a GPU symbol layer
     would need a `glyphs` font endpoint the style does not have, and
     DOM lets the bubbles use the app's own mono type. Only a handful
     of clusters are ever on screen, so the node count stays trivial. */
  map.addLayer({
    id:'acts-src',type:'circle',source:'acts',
    paint:{'circle-radius':1,'circle-opacity':0},
  });

  state.markers={};

  const sync=()=>{
    if(!map.getLayer('acts-src'))return;
    let feats=[];
    try{ feats=map.querySourceFeatures('acts'); }catch(e){ return; }

    const nextIds=new Set();
    feats.forEach(f=>{
      const p=f.properties;
      const isCluster=!!p.cluster;
      const key=isCluster?'c'+p.cluster_id:'a'+p.id;
      if(nextIds.has(key))return;          /* a feature can repeat across tiles */
      nextIds.add(key);
      if(state.markers[key])return;
      const el=isCluster?makeClusterEl(map,p):makePinEl(p);
      state.markers[key]=new maplibregl.Marker({element:el})
        .setLngLat(f.geometry.coordinates).addTo(map);
    });
    Object.keys(state.markers).forEach(k=>{
      if(!nextIds.has(k)){state.markers[k].remove();delete state.markers[k];}
    });
  };

  map.on('data',e=>{ if(e.sourceId==='acts'&&e.isSourceLoaded) sync(); });
  map.on('moveend',sync);
  state.sync=sync;
}

/* A cluster bubble. Tapping it zooms to the point where the cluster
   breaks apart. */
function makeClusterEl(map,p){
  const el=document.createElement('button');
  const allDone=p.done===p.point_count;
  el.className='map-cluster'+(allDone?' done':'');
  el.textContent=p.point_count_abbreviated||p.point_count;
  el.setAttribute('aria-label',`${p.point_count} places`);
  /* Bubbles grow with the count, but only so far. */
  const size=p.point_count>=10?50:p.point_count>=5?44:38;
  el.style.width=el.style.height=size+'px';
  el.onclick=ev=>{
    ev.stopPropagation();
    const src=map.getSource('acts');
    if(!src)return;
    Promise.resolve(src.getClusterExpansionZoom(p.cluster_id))
      .then(z=>{
        const m=state_markerLngLat(map,p.cluster_id);
        map.easeTo({center:m||map.getCenter(),zoom:z+.3,duration:560});
      })
      .catch(()=>{});
  };
  return el;
}

/* getClusterExpansionZoom only returns a zoom, so look the cluster's
   position back up from the source's rendered features. */
function state_markerLngLat(map,clusterId){
  try{
    const f=map.querySourceFeatures('acts').find(x=>x.properties.cluster_id===clusterId);
    return f?f.geometry.coordinates:null;
  }catch(e){ return null; }
}

function clearMarkers(state){
  if(!state||!state.markers)return;
  Object.values(state.markers).forEach(m=>m.remove());
  state.markers={};
}

function boundsOf(acts){
  const b=new maplibregl.LngLatBounds();
  acts.forEach(a=>b.extend([parseFloat(a.locationLng),parseFloat(a.locationLat)]));
  return b;
}

/* ==============================================================
   MAP TAB — the full-bleed globe
   ============================================================== */
let globalMapState={markers:{}};

async function renderGlobalMap(){
  const mapEl=$('globalMapContainer');

  $('globalMapBar').innerHTML=`
    <div class="map-filter" id="globalFilter">
      <button class="${globalMapFilter==='all'?'active':''}" onclick="setGlobalMapFilter('all')">All</button>
      <button class="${globalMapFilter==='pending'?'active':''}" onclick="setGlobalMapFilter('pending')">To Go</button>
      <button class="${globalMapFilter==='completed'?'active':''}" onclick="setGlobalMapFilter('completed')">Done</button>
    </div>
    <div class="map-count" id="globalMapCount"></div>`;

  if(globalMapObj){
    updateGlobalMapMarkers();
    setTimeout(()=>globalMapObj&&globalMapObj.resize(),120);
    return;
  }

  if(!webglOK()){
    mapEl.innerHTML=emptyMapHTML('Map unavailable',
      'This browser has WebGL turned off, which the globe needs.');
    $('globalMapBar').innerHTML='';$('globalMapActions').innerHTML='';
    return;
  }

  const allActs=await fetchAllActivities();
  const geo=allActs.filter(a=>a.locationLat&&a.locationLng);
  if(!geo.length){
    mapEl.innerHTML=emptyMapHTML();
    $('globalMapBar').innerHTML='';$('globalMapActions').innerHTML='';
    globalMapObj=null;return;
  }

  mapEl.innerHTML='';
  globalMapObj=new maplibregl.Map({
    container:mapEl,
    style:mapStyle(),
    center:[10,25], zoom:1.4,
    /* The globe. MapLibre eases it into flat mercator as you zoom in,
       so close-up navigation still behaves like a normal map. */
    projection:{type:'globe'},
    attributionControl:{compact:true},
    /* One-finger drag should spin the globe, not tilt it. */
    dragRotate:false, pitchWithRotate:false, touchPitch:false,
    maxZoom:17, fadeDuration:120,
  });
  globalMapObj.touchZoomRotate.disableRotation();
  /* Floor the zoom so you can never pull back past a full-screen globe. */
  globalMapObj.setMinZoom(globeFillZoom());

  globalMapObj.on('load',()=>{
    attachActivityLayer(globalMapObj,actsToGeoJSON(geo),globalMapState);
    globalMapHomeBounds=boundsOf(geo);
    fitGlobal(false);
    updateGlobalMapMarkers();
  });

  $('globalMapActions').innerHTML=
    `<button class="map-fab" onclick="zoomGlobe()" aria-label="View the whole globe">${icon('compass')}</button>`+
    `<button class="map-fab" onclick="fitGlobal(true)" aria-label="Fit all places">${icon('locate')}</button>`;
}

/* The zoom at which the globe just fills the viewport.

   In globe projection the sphere's on-screen diameter depends only on
   zoom, not on the viewport: measured, it is about 211px x 2^zoom. So
   to fill the short side of the screen, solve for that zoom. Used as
   the floor everywhere, because a tiny marble adrift in empty space
   looks broken rather than zoomed out. */
const GLOBE_PX_AT_Z0=211;
function globeFillZoom(){
  const el=$('globalMapContainer');
  const short=Math.min(el.clientWidth||window.innerWidth,el.clientHeight||window.innerHeight);
  return Math.log2((short*0.94)/GLOBE_PX_AT_Z0);
}

/* Fit every place, leaving room for the floating chrome top and bottom.
   Clamped so a globe-spanning set of pins still fills the screen. */
function fitGlobal(animate){
  if(!globalMapObj||!globalMapHomeBounds)return;
  globalMapObj.fitBounds(globalMapHomeBounds,{
    padding:{top:120,bottom:130,left:44,right:44},
    maxZoom:11, duration:animate?900:0,
  });
  const floor=globeFillZoom();
  if(globalMapObj.getZoom()<floor){
    if(animate) globalMapObj.easeTo({zoom:floor,duration:600});
    else globalMapObj.setZoom(floor);
  }
}

/* Pull back to the whole planet. */
function zoomGlobe(){
  if(!globalMapObj)return;
  globalMapObj.easeTo({zoom:globeFillZoom(),duration:1000});
}

/* Filtering swaps the source data; the clustering worker re-runs on the
   new subset without any refetch of the map itself. */
async function updateGlobalMapMarkers(){
  if(!globalMapObj||!globalMapObj.getSource('acts'))return;
  const all=await fetchAllActivities();
  let acts=all.filter(a=>a.locationLat&&a.locationLng);
  if(globalMapFilter==='pending')   acts=acts.filter(a=>!a.completed);
  if(globalMapFilter==='completed') acts=acts.filter(a=>a.completed);
  clearMarkers(globalMapState);
  globalMapObj.getSource('acts').setData(actsToGeoJSON(acts));
  if(globalMapState.sync) setTimeout(globalMapState.sync,60);
  const c=$('globalMapCount');
  if(c) c.innerHTML=`${icon('pin')}${acts.length} ${acts.length===1?'place':'places'}`;
}

function setGlobalMapFilter(f){
  globalMapFilter=f;
  const seg=$('globalFilter');
  if(seg) seg.querySelectorAll('button').forEach((b,i)=>
    b.classList.toggle('active',['all','pending','completed'][i]===f));
  updateGlobalMapMarkers();
}

function destroyGlobalMap(){
  clearMarkers(globalMapState);
  if(globalMapObj){globalMapObj.remove();globalMapObj=null;}
  globalMapHomeBounds=null;
}

/* ==============================================================
   DETAIL MAP — one collection.
   Flat mercator: at a single collection's scale a globe is unhelpful.
   ============================================================== */
let detMapState={markers:{}};

function renderMap(acts){
  const mapEl=$('mapContainer');
  const geo=acts.filter(a=>a.locationLat&&a.locationLng);

  destroyDetailMap();
  if(!geo.length){mapEl.innerHTML=emptyMapHTML();return;}
  if(!webglOK()){
    mapEl.innerHTML=emptyMapHTML('Map unavailable','This browser has WebGL turned off.');
    return;
  }

  mapEl.innerHTML='';
  actMap=new maplibregl.Map({
    container:mapEl,
    style:mapStyle(),
    center:[0,20], zoom:1,
    attributionControl:{compact:true},
    dragRotate:false, pitchWithRotate:false, touchPitch:false,
    maxZoom:17, fadeDuration:120,
  });
  actMap.touchZoomRotate.disableRotation();
  actMap.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');

  actMap.on('load',()=>{
    attachActivityLayer(actMap,actsToGeoJSON(geo),detMapState);
    detMapHomeBounds=boundsOf(geo);
    actMap.fitBounds(detMapHomeBounds,{padding:44,maxZoom:11,duration:0});
    actMap.resize();
  });
}

async function updateMapMarkers(){
  if(!actMap||!actMap.getSource('acts'))return;
  let acts=await fetchActivitiesFor(curListId);
  if(curFilter==='pending')   acts=acts.filter(a=>!a.completed);
  if(curFilter==='completed') acts=acts.filter(a=>a.completed);
  const searchEl=$('detSearch');
  const search=searchEl?searchEl.value.trim().toLowerCase():'';
  if(search) acts=acts.filter(a=>
    a.name.toLowerCase().includes(search)||(a.description||'').toLowerCase().includes(search));
  clearMarkers(detMapState);
  actMap.getSource('acts').setData(actsToGeoJSON(acts));
  if(detMapState.sync) setTimeout(detMapState.sync,60);
}

function destroyDetailMap(){
  clearMarkers(detMapState);
  if(actMap){actMap.remove();actMap=null;}
  detMapHomeBounds=null;
}

/* Both maps must re-measure when the viewport changes. */
function refreshMapZoomFloors(){
  if(globalMapObj){
    globalMapObj.resize();
    /* The fill zoom depends on the container's short side, so a rotate
       changes it. */
    globalMapObj.setMinZoom(globeFillZoom());
  }
  if(actMap) actMap.resize();
}
