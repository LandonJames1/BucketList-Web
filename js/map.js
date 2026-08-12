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

   Clustering is done by the GeoJSON source itself (in a worker), not on
   the main thread, and *everything* is drawn as a GPU symbol layer —
   there are no DOM markers at all. See the MARKER ICONS section for why
   that matters.
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
        /* Pending pins are coloured by priority on the same scale the
           lists use, and a high one is drawn larger as well — on a map
           you are reading pins against each other, not against a
           legend. Completed pins stay olive: done outranks priority. */
        pri:a.completed?'':(a.priority||'medium'),
        photo:(a.photos&&a.photos[0])||'',location:a.location||'',
      },
    })),
  };
}

/* ==============================================================
   MARKER ICONS

   Pins and cluster bubbles are drawn into canvases, registered with
   map.addImage(), and rendered by symbol layers — i.e. on the GPU, in
   the same pass as the map itself.

   They used to be maplibregl.Marker DOM elements. Those are positioned
   by JavaScript writing a CSS transform once per frame, which can never
   stay perfectly in step with a GPU-composited map: during a pan or a
   pinch the pins visibly lag and swim against the terrain. Everything
   below exists to put them in the same coordinate system as the map so
   they are welded to it.
   ============================================================== */

const PIN_R=18;              /* pin radius in CSS px */
const PIN_R_HI=23;           /* high priority: same pin, more of it */
const PIN_RING=2.5;
/* The same three tokens the priority rails and capsules use, so a pin
   and a row agree about what a colour means. */
const PRI_VAR={high:'--tint',medium:'--violet',low:'--slate'};
function priColor(pri){ return cssVar(PRI_VAR[pri]||'--violet'); }
const iconsAdded=new WeakMap();   /* map -> Set of image ids already added */

function iconSet(map){
  if(!iconsAdded.has(map)) iconsAdded.set(map,new Set());
  return iconsAdded.get(map);
}

/* Device-pixel-ratio-aware canvas, so pins are crisp on a retina screen. */
function makeCanvas(size){
  const dpr=Math.min(window.devicePixelRatio||1,3);
  const c=document.createElement('canvas');
  c.width=c.height=Math.ceil(size*dpr);
  const ctx=c.getContext('2d');
  ctx.scale(dpr,dpr);
  return{canvas:c,ctx,dpr};
}
function addCanvasImage(map,id,canvas,dpr){
  if(map.hasImage(id)) map.removeImage(id);
  const ctx=canvas.getContext('2d');
  const d=ctx.getImageData(0,0,canvas.width,canvas.height);
  map.addImage(id,{width:canvas.width,height:canvas.height,data:new Uint8Array(d.data.buffer)},{pixelRatio:dpr});
}

/* A plain dot pin: filled circle, white ring. */
function ensureDotIcon(map,done,pri){
  const id='pin-'+(done?'done':pri||'medium');
  if(iconSet(map).has(id))return id;
  const hi=!done&&pri==='high';
  const r=hi?PIN_R_HI:PIN_R;
  const size=r*2+PIN_RING*2+4;
  const{canvas,ctx,dpr}=makeCanvas(size);
  const c=size/2;
  ctx.beginPath();ctx.arc(c,c,r,0,Math.PI*2);
  ctx.fillStyle=done?cssVar('--green'):priColor(pri);
  ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=6;ctx.shadowOffsetY=1.5;
  ctx.fill();
  ctx.shadowColor='transparent';
  ctx.lineWidth=PIN_RING;ctx.strokeStyle='#fff';ctx.stroke();
  ctx.beginPath();ctx.arc(c,c,hi?5.5:4.5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
  addCanvasImage(map,id,canvas,dpr);
  iconSet(map).add(id);
  return id;
}

/* A photo pin: the activity's first photo, circular-cropped in a ring.
   Loading is async, so the feature renders as a dot until the image is
   ready and then repaints. */
function ensurePhotoIcon(map,id,src,done,pri,onReady){
  if(iconSet(map).has(id))return;
  iconSet(map).add(id);                        /* claim it, so we load once */
  const img=new Image();
  img.crossOrigin='anonymous';
  img.onload=()=>{
    if(!map.getStyle())return;                 /* map torn down mid-load */
    const hi=!done&&pri==='high';
    const r=hi?PIN_R_HI:PIN_R;
    const size=r*2+PIN_RING*2+4;
    const{canvas,ctx,dpr}=makeCanvas(size);
    const c=size/2;
    ctx.save();
    ctx.beginPath();ctx.arc(c,c,r,0,Math.PI*2);
    ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=6;ctx.shadowOffsetY=1.5;
    ctx.fillStyle='#fff';ctx.fill();
    ctx.shadowColor='transparent';
    ctx.clip();
    /* cover-fit the photo into the circle */
    const s=Math.max((r*2)/img.width,(r*2)/img.height);
    const w=img.width*s,h=img.height*s;
    ctx.drawImage(img,c-w/2,c-h/2,w,h);
    ctx.restore();
    ctx.beginPath();ctx.arc(c,c,r,0,Math.PI*2);
    /* The ring carries the priority colour, since a photo fills the
       circle and there is nowhere else on the pin to put it. */
    ctx.lineWidth=hi?PIN_RING+1:PIN_RING;
    ctx.strokeStyle=done?cssVar('--green'):priColor(pri);
    ctx.stroke();
    try{
      addCanvasImage(map,id,canvas,dpr);
      if(onReady)onReady();
      map.triggerRepaint();
    }catch(e){
      /* Reading the canvas back taints it if the photo came from a
         cross-origin host that does not send CORS headers. The app's own
         photos are base64 data URLs, so this only bites on remote covers;
         drop the claim and let the feature keep its dot. */
      console.warn('[map] could not build photo pin:',e.message);
      iconSet(map).delete(id);
    }
  };
  img.onerror=()=>{ iconSet(map).delete(id); };
  img.src=src;
}

/* A cluster bubble with its count baked in. One image per (count, state)
   pair, generated on demand and cached. Drawing the number into the
   image avoids needing a `glyphs` font endpoint for a symbol layer. */
function ensureClusterIcon(map,count,allDone){
  const id='cluster-'+count+'-'+(allDone?'d':'p');
  if(iconSet(map).has(id))return id;
  const r=count>=10?25:count>=5?22:19;
  const size=r*2+6;
  const{canvas,ctx,dpr}=makeCanvas(size);
  const c=size/2;
  ctx.beginPath();ctx.arc(c,c,r,0,Math.PI*2);
  ctx.fillStyle=allDone?cssVar('--green'):cssVar('--tint');
  ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=7;ctx.shadowOffsetY=2;
  ctx.fill();
  ctx.shadowColor='transparent';
  ctx.lineWidth=2.5;ctx.strokeStyle='#fff';ctx.stroke();
  ctx.fillStyle='#fff';
  ctx.font='600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(String(count),c,c+.5);
  addCanvasImage(map,id,canvas,dpr);
  iconSet(map).add(id);
  return id;
}

/* Pins are drawn from the palette, so they follow light/dark mode. */
function cssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()||'#9c5a2e';
}

/* ==============================================================
   LAYER WIRING
   ============================================================== */

/* Cluster properties are generated by MapLibre, so a cluster's icon has
   to be selected by expression rather than stamped on. The id it builds
   matches what ensureClusterIcon() registers. */
const CLUSTER_ICON_EXPR=['concat','cluster-',
  ['to-string',['get','point_count']],
  ['case',['==',['get','done'],['get','point_count']],'-d','-p']];

const SYMBOL_LAYOUT={
  'icon-image':['get','_icon'],
  /* The clustering already handles crowding; leaving collision detection
     on would only make pins silently vanish. */
  'icon-allow-overlap':true,
  'icon-ignore-placement':true,
  /* Higher sort key draws later, i.e. on top. A high-priority pin is
     bigger, so it is the one that must not end up underneath a
     neighbour it overlaps. Clusters have no `pri` and fall through to
     0, which is what we want — they are all the same size. */
  'symbol-sort-key':['case',['==',['get','pri'],'high'],1,0],
};

/* Writes an `_icon` id onto every point feature and pushes the data to
   the source. Photo icons decode asynchronously, so a feature starts as
   a dot and is re-stamped once its image is ready. */
function stampPointIcons(map,state,push){
  let changed=false;
  state.geojson.features.forEach(f=>{
    const p=f.properties;
    let id;
    const pri=p.pri||'medium';
    if(p.photo){
      /* The id carries the priority, so changing it builds a new image
         rather than reusing the old colour and size. */
      const pid='photo-'+p.id+'-'+(p.done===1?'done':pri);
      ensurePhotoIcon(map,pid,p.photo,p.done===1,pri,()=>stampPointIcons(map,state,true));
      id=map.hasImage(pid)?pid:ensureDotIcon(map,p.done===1,pri);
    } else {
      id=ensureDotIcon(map,p.done===1,pri);
    }
    if(p._icon!==id){p._icon=id;changed=true;}
  });
  if(changed&&push){
    const src=map.getSource('acts');
    if(src) src.setData(state.geojson);
  }
  return changed;
}

function attachActivityLayer(map,acts,state){
  state.geojson=actsToGeoJSON(acts);
  stampPointIcons(map,state,false);

  map.addSource('acts',{
    type:'geojson',
    data:state.geojson,
    cluster:true,
    clusterRadius:56,
    clusterMaxZoom:13,
    /* Sum of completed children, so a cluster can be tinted by whether
       everything inside it is done. */
    clusterProperties:{done:['+',['get','done']]},
  });

  map.addLayer({id:'points',type:'symbol',source:'acts',
    filter:['!',['has','point_count']],layout:SYMBOL_LAYOUT});
  map.addLayer({id:'clusters',type:'symbol',source:'acts',
    filter:['has','point_count'],
    layout:Object.assign({},SYMBOL_LAYOUT,{'icon-image':CLUSTER_ICON_EXPR})});

  /* Cluster counts change with every zoom level, so make sure an image
     exists for whichever ones are currently on screen. Each is cached
     after its first use, so this settles almost immediately. */
  const ensureClusterIcons=()=>{
    if(!map.getLayer('clusters'))return;
    let feats=[];
    try{ feats=map.querySourceFeatures('acts',{filter:['has','point_count']}); }
    catch(e){ return; }
    const before=iconSet(map).size;
    feats.forEach(f=>ensureClusterIcon(map,f.properties.point_count,
      f.properties.done===f.properties.point_count));
    if(iconSet(map).size!==before) map.triggerRepaint();
  };
  map.on('data',e=>{ if(e.sourceId==='acts'&&e.isSourceLoaded) ensureClusterIcons(); });
  map.on('moveend',ensureClusterIcons);
  state.ensureClusterIcons=ensureClusterIcons;

  map.on('click','clusters',e=>{
    const f=e.features&&e.features[0];
    if(!f)return;
    const src=map.getSource('acts');
    if(!src)return;
    Promise.resolve(src.getClusterExpansionZoom(f.properties.cluster_id))
      .then(z=>map.easeTo({center:f.geometry.coordinates,zoom:z+.3,duration:560}))
      .catch(()=>{});
  });
  map.on('click','points',e=>{
    const f=e.features&&e.features[0];
    if(f) openActDetail(f.properties.id);
  });
  ['clusters','points'].forEach(l=>{
    map.on('mouseenter',l,()=>{map.getCanvas().style.cursor='pointer';});
    map.on('mouseleave',l,()=>{map.getCanvas().style.cursor='';});
  });
}

/* Swap the visible set without rebuilding the map. */
function setLayerData(map,state,acts){
  if(!map||!map.getSource('acts'))return;
  state.geojson=actsToGeoJSON(acts);
  stampPointIcons(map,state,false);
  map.getSource('acts').setData(state.geojson);
  if(state.ensureClusterIcons) setTimeout(state.ensureClusterIcons,60);
}

function boundsOf(acts){
  const b=new maplibregl.LngLatBounds();
  acts.forEach(a=>b.extend([parseFloat(a.locationLng),parseFloat(a.locationLat)]));
  return b;
}

/* ==============================================================
   MAP TAB — the full-bleed globe
   ============================================================== */
let globalMapState={};

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
    attachActivityLayer(globalMapObj,geo,globalMapState);
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
  setLayerData(globalMapObj,globalMapState,acts);
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
  if(globalMapObj){globalMapObj.remove();globalMapObj=null;}
  globalMapState={};
  globalMapHomeBounds=null;
}

/* ==============================================================
   DETAIL MAP — one collection.
   Flat mercator: at a single collection's scale a globe is unhelpful.
   ============================================================== */
let detMapState={};

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
    attachActivityLayer(actMap,geo,detMapState);
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
  setLayerData(actMap,detMapState,acts);
}

function destroyDetailMap(){
  if(actMap){actMap.remove();actMap=null;}
  detMapState={};
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
