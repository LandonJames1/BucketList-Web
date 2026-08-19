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

/* ==============================================================
   LOADING MAPLIBRE ON DEMAND

   maplibre-gl.js is ~900KB and used to sit in <head> as an ordinary
   parser-blocking <script> — so every cold launch downloaded, parsed
   and executed the entire GL map engine before the browser would look
   at a single one of the app's own files, on the way to a Home screen
   that has no map on it.

   Now it is fetched the first time a map is actually asked for. The
   two entry points below await this; nothing else in the app touches
   `maplibregl`.

   The stylesheet comes with it. Loading the CSS eagerly and the script
   lazily would leave MapLibre's control styles applying to nothing on
   every screen, and it is small enough that splitting them buys
   nothing.

   `false` here means the script could not be fetched — offline on a
   cold cache, most likely — and the callers show the same "map
   unavailable" state they already show for missing WebGL, rather than
   throwing inside a render.
   ============================================================== */
const MAPLIBRE_JS='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
const MAPLIBRE_CSS='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css';
let _maplibreP=null;

function ensureMapLibre(){
  if(window.maplibregl) return Promise.resolve(true);
  if(_maplibreP) return _maplibreP;

  _maplibreP=new Promise(resolve=>{
    if(!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)){
      const link=document.createElement('link');
      link.rel='stylesheet';link.href=MAPLIBRE_CSS;
      document.head.appendChild(link);
    }
    const s=document.createElement('script');
    s.src=MAPLIBRE_JS;
    s.async=true;
    s.onload=()=>resolve(!!window.maplibregl);
    s.onerror=()=>{
      console.warn('[map] could not load maplibre-gl');
      /* Cleared rather than left resolved-false, so coming back to the
         tab once the connection returns tries again instead of being
         permanently stuck on the error state. */
      _maplibreP=null;
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return _maplibreP;
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
    features:acts.filter(a=>a.locationLat&&a.locationLng).map(a=>{
      const lng=parseFloat(a.locationLng),lat=parseFloat(a.locationLat);
      return {
        type:'Feature',
        geometry:{type:'Point',coordinates:[lng,lat]},
        properties:{
          id:a.id,name:a.name,done:a.completed?1:0,
          /* Pending pins are coloured by priority on the same scale the
             lists use, and a high one is drawn larger as well — on a map
             you are reading pins against each other, not against a
             legend. Completed pins stay olive: done outranks priority. */
          pri:a.completed?'':(a.priority||'medium'),
          photo:(a.photos&&a.photos[0])||'',location:a.location||'',
          /* The coordinates again, as plain numbers. A cluster's own
             geometry is the average of its children, which says nothing
             about how far apart they are — so the source aggregates
             min/max of these into every cluster and samePlaceCluster()
             reads the span back off the feature that was tapped. No
             leaf query, no round trip, and it is available at draw time
             too, which is what lets a stacked cluster be drawn as a
             stack. */
          x:lng,y:lat,
        },
      };
    }),
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

/* A cluster bubble with its count baked in. One image per
   (count, state, stacked) triple, generated on demand and cached.
   Drawing the number into the image avoids needing a `glyphs` font
   endpoint for a symbol layer.

   `stacked` says the cluster's children are all at one place, so
   zooming will never pull them apart — tapping it opens the place
   sheet instead. That is a different answer from the same-looking
   control, so it gets a different look: a second disc peeking out
   behind the first, the way a stack of cards reads. */
function ensureClusterIcon(map,count,allDone,stacked){
  const id='cluster-'+count+'-'+(allDone?'d':'p')+(stacked?'-s':'');
  if(iconSet(map).has(id))return id;
  const r=count>=10?25:count>=5?22:19;
  const off=stacked?5:0;
  const size=r*2+6+off*2;
  const{canvas,ctx,dpr}=makeCanvas(size);
  const c=size/2;
  const fill=allDone?cssVar('--green'):cssVar('--tint');
  if(stacked){
    /* The card behind. Drawn first and slightly smaller, with the same
       white ring, so the front disc reads as sitting on top of it. */
    ctx.beginPath();ctx.arc(c+off,c-off,r-1.5,0,Math.PI*2);
    ctx.fillStyle=fill;
    ctx.shadowColor='rgba(0,0,0,.3)';ctx.shadowBlur=6;ctx.shadowOffsetY=2;
    ctx.fill();
    ctx.shadowColor='transparent';
    ctx.lineWidth=2.5;ctx.strokeStyle='#fff';ctx.stroke();
  }
  /* The front disc stays on the canvas centre, which is where the
     symbol layer anchors the image — so growing the canvas for the
     card behind does not shift the bubble off its coordinate. */
  const cx=c,cy=c;
  ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle=fill;
  ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=7;ctx.shadowOffsetY=2;
  ctx.fill();
  ctx.shadowColor='transparent';
  ctx.lineWidth=2.5;ctx.strokeStyle='#fff';ctx.stroke();
  ctx.fillStyle='#fff';
  ctx.font='600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(String(count),cx,cy+.5);
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

/* How close two activities have to be before they count as the same
   place rather than as neighbours: about 25m at the equator, which is
   under the width of one pin at the map's deepest zoom. Coordinates
   picked from the same search result — or from the Home shortcut — are
   identical, so this only has to absorb the case where the same address
   was geocoded twice and came back a few metres apart. */
const SAME_PLACE_DEG=0.00022;

/* Does this cluster hold activities that are all at one point? Reads
   the min/max the source aggregates (see clusterProperties below), so
   it needs no leaf query and works inside a style expression too. */
const CLUSTER_SPAN_X=['-',['get','x1'],['get','x0']];
const CLUSTER_SPAN_Y=['-',['get','y1'],['get','y0']];
const CLUSTER_STACKED=['all',
  ['<',CLUSTER_SPAN_X,SAME_PLACE_DEG],
  ['<',CLUSTER_SPAN_Y,SAME_PLACE_DEG]];

function samePlaceCluster(p){
  if(!p||p.x1===undefined)return false;
  return (p.x1-p.x0)<SAME_PLACE_DEG && (p.y1-p.y0)<SAME_PLACE_DEG;
}

/* Cluster properties are generated by MapLibre, so a cluster's icon has
   to be selected by expression rather than stamped on. The id it builds
   matches what ensureClusterIcon() registers. */
const CLUSTER_ICON_EXPR=['concat','cluster-',
  ['to-string',['get','point_count']],
  ['case',['==',['get','done'],['get','point_count']],'-d','-p'],
  ['case',CLUSTER_STACKED,'-s','']];

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
  state.byId=indexActs(acts);
  stampPointIcons(map,state,false);

  map.addSource('acts',{
    type:'geojson',
    data:state.geojson,
    cluster:true,
    /* Roughly a pin's width, so "clustered" means "these pins would be
       drawn on top of each other". */
    clusterRadius:56,
    /* Clustering used to stop at zoom 13, and that was the bug behind
       "several activities at one address are unreachable": past 13 every
       point drew its own pin, so a house with five activities at it was
       five pins stacked on the same pixel and a tap opened whichever was
       on top. The radius is in screen pixels, so keeping clustering on
       all the way to the map's own maxZoom costs nothing at street
       level — anything genuinely metres apart separates on its own —
       and leaves only the coincident ones bundled, which is exactly the
       set the place sheet exists to open. */
    clusterMaxZoom:map.getMaxZoom(),
    clusterProperties:{
      /* Sum of completed children, so a cluster can be tinted by whether
         everything inside it is done. */
      done:['+',['get','done']],
      /* The bounding box of the children. A cluster's own geometry is
         their average, which cannot say whether they are one place or a
         whole neighbourhood — this can. See samePlaceCluster(). */
      x0:['min',['get','x']], x1:['max',['get','x']],
      y0:['min',['get','y']], y1:['max',['get','y']],
    },
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
      f.properties.done===f.properties.point_count,
      samePlaceCluster(f.properties)));
    if(iconSet(map).size!==before) map.triggerRepaint();
  };
  map.on('data',e=>{ if(e.sourceId==='acts'&&e.isSourceLoaded) ensureClusterIcons(); });
  map.on('moveend',ensureClusterIcons);
  state.ensureClusterIcons=ensureClusterIcons;

  /* Tapping a cluster zooms into it — unless zooming cannot help,
     which is the whole point of this change. A cluster whose children
     are all at one address stays a cluster however far you zoom, so
     easing towards it forever was a control that visibly did nothing.
     Those open the place sheet instead. The expansion-zoom check
     behind it is the belt to that brace: it catches anything supercluster
     cannot split for a reason the bounding box does not describe. */
  map.on('click','clusters',e=>{
    const f=e.features&&e.features[0];
    if(!f)return;
    const src=map.getSource('acts');
    if(!src)return;
    const at=f.geometry.coordinates;
    if(samePlaceCluster(f.properties)) return openClusterPlace(map,state,f);
    Promise.resolve(src.getClusterExpansionZoom(f.properties.cluster_id))
      .then(z=>{
        if(z>map.getMaxZoom()) return openClusterPlace(map,state,f);
        map.easeTo({center:at,zoom:z+.3,duration:560});
      })
      .catch(()=>{});
  });
  map.on('click','points',e=>{
    const fs=e.features||[];
    if(!fs.length)return;
    /* Clustering is on at every zoom now, so coincident points should
       already have been bundled — but a query can still return more
       than one overlapping pin, and picking [0] is how the original bug
       looked from the outside. */
    if(fs.length>1) return openPlaceSheet(placeActs(state,fs.map(f=>f.properties.id)));
    openActDetail(fs[0].properties.id);
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
  state.byId=indexActs(acts);
  stampPointIcons(map,state,false);
  map.getSource('acts').setData(state.geojson);
  if(state.ensureClusterIcons) setTimeout(state.ensureClusterIcons,60);
}

/* ==============================================================
   ONE POINT, SEVERAL ACTIVITIES

   A pin is a place, and a place holds as many activities as you put
   there — "home" most of all, which collects every chore you will ever
   file. Zooming in never separated those (they share one coordinate),
   so the map had a stack of pins on one pixel and a tap opened whichever
   was on top. The rest were, in the app's own terms, in the database and
   reachable from nowhere.

   The fix is in two halves. Clustering now runs at every zoom, so a
   stack is always one bubble carrying its count rather than N pins
   pretending to be one — see attachActivityLayer(). And a bubble that
   zooming cannot split opens this sheet, which is the missing half: the
   list of what is actually there.

   The activities come from the layer's own index rather than from a
   fetch, so the sheet shows exactly the set the map is showing — the
   Map tab's To Go / Done filter and the collection map's search included.
   ============================================================== */

/* id → activity, rebuilt with the layer data. The GeoJSON carries only
   what the pins need to draw; the sheet wants the whole row. */
function indexActs(acts){
  const m={};
  acts.forEach(a=>{m[a.id]=a;});
  return m;
}

function placeActs(state,ids){
  const by=state&&state.byId||{};
  return ids.map(id=>by[id]).filter(Boolean);
}

/* Enough for any real address. A cluster with more than this in it is
   not one place, it is a city, and it will have expanded long before. */
const PLACE_MAX=250;

/* A cluster's children, resolved back into activities. getClusterLeaves
   is the only thing here that is asynchronous — the clustering lives in
   a worker — so the sheet opens a frame later than the tap. */
function openClusterPlace(map,state,f){
  const src=map.getSource('acts');
  if(!src)return;
  Promise.resolve(src.getClusterLeaves(f.properties.cluster_id,PLACE_MAX,0))
    .then(leaves=>{
      const acts=placeActs(state,(leaves||[]).map(l=>l.properties.id));
      if(acts.length===1) return openActDetail(acts[0].id);
      if(acts.length) openPlaceSheet(acts);
    })
    .catch(e=>console.warn('[map] could not read cluster:',e&&e.message));
}

/* What to call the point. The activities at one coordinate were each
   given their location text separately, so they can disagree in wording
   — take the one the most of them wrote, and fall back to coordinates
   rather than to an empty title. */
function placeTitle(acts){
  const counts={};
  let best='',bestN=0;
  acts.forEach(a=>{
    const t=(a.location||'').trim();
    if(!t)return;
    counts[t]=(counts[t]||0)+1;
    if(counts[t]>bestN){best=t;bestN=counts[t];}
  });
  if(best)return best;
  const a=acts[0];
  return a&&a.locationLat?`${(+a.locationLat).toFixed(4)}, ${(+a.locationLng).toFixed(4)}`:'This place';
}

/* Pending first and in the order Up Next would put them — the sheet is
   read to decide what to do next, and something already done has no
   next. Completed rows follow, most recent first, so the place still
   reads as a record of what happened there. */
function sortPlaceActs(acts){
  return acts.slice().sort((a,b)=>
    (a.completed?1:0)-(b.completed?1:0) ||
    (a.completed
      ? new Date(b.completedDate||0)-new Date(a.completedDate||0)
      : daysToTarget(a)-daysToTarget(b) || priorityRank(a)-priorityRank(b)) ||
    new Date(b.createdAt)-new Date(a.createdAt));
}

/* Built on .act-row rather than on a row of its own: these are the same
   objects the collection screen lists, and the only thing that differs
   is that they can have come from any list, so the meta line carries a
   .list-chip the way the Up Next rows do. */
function placeRowHTML(a,lists){
  const di=dateInfo(a);
  const thumb=a.photos&&a.photos.length
    ? `<img class="act-thumb" src="${esc(a.photos[0])}" alt="" loading="lazy"/>` : '';
  const bits=[`<span class="list-chip">${esc(activityListLabel(a,lists))}</span>`];
  if(a.completed){
    if(a.completedDate) bits.push(`<span class="pl-when">${esc(fmtDate(a.completedDate,true))}</span>`);
  } else if(di.label){
    bits.push(`<span class="badge b-${di.cls}">${esc(di.label)}</span>`);
  }
  return `<div class="act-row${a.completed?' done':''}${priClass(a)}" onclick="placeOpenActivity('${a.id}')">
    <button class="act-check" onclick="event.stopPropagation();placeToggleActivity('${a.id}')"
            aria-label="${a.completed?'Mark as not done':'Mark as done'}">
      ${icon(a.completed?'check-circle':'circle')}
    </button>
    <button class="act-main">
      <span class="act-name">${esc(a.name)}</span>
      <span class="act-meta">${priTagHTML(a)}${bits.join('')}</span>
    </button>
    ${thumb}
    <span class="act-chevron">${icon('chevron-right')}</span>
  </div>`;
}

function openPlaceSheet(acts){
  if(!acts||!acts.length)return;
  const list=sortPlaceActs(acts);
  const lists=cachedCollections();
  const done=list.filter(a=>a.completed).length;
  const n=list.length;
  const counts=[`${n} ${n===1?'activity':'activities'}`];
  if(done) counts.push(`${done} done`);
  $('placeBody').innerHTML=`
    <div class="pl-head">
      <div class="t-eyebrow">${esc(counts.join(' · '))}</div>
      <h2 class="pl-title">${esc(placeTitle(list))}</h2>
    </div>
    <div class="pl-list">${list.map(a=>placeRowHTML(a,lists)).join('')}</div>`;
  openModal('placeSheet');
}

/* Both row actions close this sheet first. The activity sheet and the
   completion sheet are earlier in the document than this one, so an
   overlay opened on top of it would render underneath it — and the
   activity sheet in particular has half a dozen buttons that close
   themselves to open something else, which a registered return would
   resurrect this sheet on top of. Tapping the pin again is the way
   back, and it costs one tap. */
function placeOpenActivity(id){
  closeModal('placeSheet');
  openActDetail(id);
}
function placeToggleActivity(id){
  closeModal('placeSheet');
  /* No source: refreshAfterChange() then redraws whichever map is
     actually on screen, which is the one this sheet was opened from. */
  toggleCompleteFrom('',id);
}

/* Resolves when a map has finished loading its style — or immediately
   if it already has. Lets the data query and the map build run at the
   same time instead of one after the other. */
function mapLoaded(map){
  return new Promise(resolve=>{
    if(map.loaded()&&map.getStyle())return resolve();
    map.once('load',resolve);
  });
}

const hasGeo=a=>a.locationLat&&a.locationLng;

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

  /* The map survives navigation now (see destroyGlobalMap), so coming
     back to the tab is a resize and a data swap rather than a rebuild —
     no style download, no tile fetch, no globe spin-up. Rebuilding it
     every visit was most of what made this tab feel slow. */
  if(globalMapObj){
    globalMapObj.resize();
    updateGlobalMapMarkers();
    return;
  }

  if(!webglOK()){
    mapEl.innerHTML=emptyMapHTML('Map unavailable',
      'This browser has WebGL turned off, which the globe needs.');
    $('globalMapBar').innerHTML='';$('globalMapActions').innerHTML='';
    return;
  }

  /* Start the query WITHOUT waiting on it, so the style, the tiles and
     the Supabase round trip all happen at once. The old code awaited the
     data first and only then began building the map, which made the two
     costs add up instead of overlap. */
  const dataP=fetchAllActivities();

  /* When rows are already cached the answer is free, so an empty map can
     be shown without building a globe only to tear it down again. */
  if(cacheWarm()){
    const known=(await dataP).filter(hasGeo);
    if(!known.length){
      mapEl.innerHTML=emptyMapHTML();
      $('globalMapBar').innerHTML='';$('globalMapActions').innerHTML='';
      return;
    }
  }

  /* Awaited here rather than at the top of the function so it overlaps
     the data query started above, the same way the style and tile
     fetches already do. */
  if(!await ensureMapLibre()){
    mapEl.innerHTML=emptyMapHTML('Map unavailable',
      'The map couldn’t be loaded. Check your connection and try again.');
    $('globalMapBar').innerHTML='';$('globalMapActions').innerHTML='';
    return;
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

  $('globalMapActions').innerHTML=
    `<button class="map-fab" onclick="zoomGlobe()" aria-label="View the whole globe">${icon('compass')}</button>`+
    `<button class="map-fab" onclick="fitGlobal(true)" aria-label="Fit all places">${icon('locate')}</button>`;

  const built=globalMapObj;
  const [acts]=await Promise.all([dataP,mapLoaded(built)]);
  /* The user can leave the tab while this is in flight, which tears the
     map down underneath us. */
  if(globalMapObj!==built||!built.getStyle())return;

  const geo=acts.filter(hasGeo);
  if(!geo.length){
    destroyGlobalMap();
    mapEl.innerHTML=emptyMapHTML();
    $('globalMapBar').innerHTML='';$('globalMapActions').innerHTML='';
    return;
  }
  attachActivityLayer(built,geo,globalMapState);
  globalMapHomeBounds=boundsOf(geo);
  fitGlobal(false);
  updateGlobalMapMarkers(geo);
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
  /* The map now outlives its screen, so this can be asked while the Map
     tab is hidden and the container measures 0 — which would make the
     log2 -Infinity and pin minZoom there. */
  if(!(short>0)) return 0;
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
async function updateGlobalMapMarkers(preloaded){
  if(!globalMapObj||!globalMapObj.getSource('acts'))return;
  /* renderGlobalMap already has the rows when it calls this on first
     build. It used to refetch them here — every single activity,
     including their photos — purely to filter a list it was holding. */
  const all=preloaded||await fetchAllActivities();
  let acts=all.filter(hasGeo);
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

async function renderMap(acts){
  const mapEl=$('mapContainer');
  const geo=acts.filter(hasGeo);

  destroyDetailMap();
  if(!geo.length){mapEl.innerHTML=emptyMapHTML();return;}
  if(!webglOK()){
    mapEl.innerHTML=emptyMapHTML('Map unavailable','This browser has WebGL turned off.');
    return;
  }
  if(!await ensureMapLibre()){
    mapEl.innerHTML=emptyMapHTML('Map unavailable',
      'The map couldn’t be loaded. Check your connection and try again.');
    return;
  }
  /* The view can change while the script is in flight — this is the
     first visit to a collection's map, so it is a real wait. Bail
     rather than building a map into a container that has since been
     re-rendered or navigated away from. */
  if(curPage!=='detail'||curView!=='map') return;

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
  if(search) acts=acts.filter(a=>a.name.toLowerCase().includes(search));
  setLayerData(actMap,detMapState,acts);
}

function destroyDetailMap(){
  if(actMap){actMap.remove();actMap=null;}
  detMapState={};
  detMapHomeBounds=null;
}

/* Both maps must re-measure when the viewport changes. */
function refreshMapZoomFloors(){
  /* Only the map on screen is worth re-measuring; the global map is kept
     alive while hidden, where its container has no size. It is resized on
     the way back in by renderGlobalMap(). */
  if(globalMapObj&&curPage==='globalmap'){
    globalMapObj.resize();
    /* The fill zoom depends on the container's short side, so a rotate
       changes it. */
    globalMapObj.setMinZoom(globeFillZoom());
  }
  if(actMap) actMap.resize();
}
