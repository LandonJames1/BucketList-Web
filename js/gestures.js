/* ==============================================================
   GESTURES — swipe to dismiss a sheet, swipe to change screen.

   Touch events rather than pointer events: this is a phone-first app,
   and the two gestures here are ones a mouse has no use for. All
   listeners are passive except the sheet drag, which has to be able to
   preventDefault once it knows the gesture is vertical.

   Both gestures are delegated from document. Nothing that opens a sheet
   or renders a row has to opt in.
   ============================================================== */

/* Any overlay on screen owns the gesture — the page underneath must not
   also react to it. */
function overlayOpen(){
  return !!document.querySelector('.modal-overlay.open')
      || $('actionSheet').classList.contains('open')
      || $('lightbox').classList.contains('open');
}

/* Surfaces with their own horizontal gesture. A map is dragged to pan,
   and anything that scrolls sideways is scrolled. */
function ownsHorizontal(el){
  return !!(el.closest&&(
    el.closest('#globalMapContainer')||el.closest('#mapContainer')||
    el.closest('.maplibregl-map')||el.closest('.seg')||
    el.closest('input')||el.closest('textarea')));
}
function ownsVertical(el){
  return !!(el.closest&&(
    el.closest('input')||el.closest('textarea')||el.closest('select')||
    el.closest('.loc-results')||el.closest('.maplibregl-map')||
    /* Photo tiles are dragged to reorder; a downward drag on one must
       not throw the whole sheet away. */
    el.closest('.photo-previews')));
}

/* ==============================================================
   SWIPE DOWN TO DISMISS A SHEET

   The grab handle at the top of every sheet has always looked like it
   could be dragged; now it can, and so can the rest of the sheet.

   The one rule that makes this coexist with a scrolling sheet body:
   **the drag only starts when the body is already at the top.** Halfway
   down a long sheet a downward swipe is a scroll, and stealing it would
   make the sheet impossible to read. Starting on the bar or the grabber
   always drags, since neither scrolls.
   ============================================================== */
const SHEET_DISMISS_PX=110;      /* far enough to be deliberate */
const SHEET_DISMISS_V=0.5;       /* …or fast enough to be a flick */
/* A flick still has to travel. Velocity alone would let a 20px twitch
   throw the sheet away, since a short fast movement scores just as high
   as a long one. */
const SHEET_FLICK_PX=48;

let shDrag=null;

function sheetAt(target){
  const overlay=target.closest&&target.closest('.modal-overlay.open');
  if(!overlay)return null;
  return{overlay,panel:overlay.querySelector('.modal')};
}

document.addEventListener('touchstart',e=>{
  shDrag=null;
  if(e.touches.length!==1)return;
  const t=e.touches[0],el=e.target;
  if(ownsVertical(el))return;

  /* --- a sheet --- */
  const s=sheetAt(el);
  if(s&&s.panel){
    const body=el.closest('.sheet-body');
    /* A scrolled body is being read, not dragged. */
    if(body&&body.scrollTop>0)return;
    shDrag={kind:'sheet',el:s.panel,overlay:s.overlay,
            y0:t.clientY,x0:t.clientX,t0:Date.now(),dy:0,live:false};
    return;
  }
  /* --- the action sheet --- */
  const as=$('actionSheet');
  if(as.classList.contains('open')&&el.closest('.as-panel')){
    shDrag={kind:'action',el:as.querySelector('.as-panel'),overlay:as,
            y0:t.clientY,x0:t.clientX,t0:Date.now(),dy:0,live:false};
  }
},{passive:true});

document.addEventListener('touchmove',e=>{
  if(!shDrag||e.touches.length!==1)return;
  const t=e.touches[0];
  const dy=t.clientY-shDrag.y0, dx=t.clientX-shDrag.x0;

  if(!shDrag.live){
    /* Wait until the direction is unambiguous before committing, so a
       diagonal thumb-flick does not half-dismiss anything. */
    if(Math.abs(dy)<8&&Math.abs(dx)<8)return;
    if(dy<=0||Math.abs(dy)<Math.abs(dx)){shDrag=null;return;}
    shDrag.live=true;
    shDrag.el.style.transition='none';
    shDrag.overlay.style.transition='none';
  }
  /* Past the bottom it moves 1:1; a pull upward is resisted so the sheet
     cannot be dragged off the top of its own frame. */
  shDrag.dy=dy>0?dy:dy/4;
  shDrag.el.style.transform=`translateY(${shDrag.dy}px)`;
  /* The scrim lifts with it, so the page behind comes back as you pull. */
  const h=shDrag.el.offsetHeight||600;
  shDrag.overlay.style.opacity=String(Math.max(0,1-(shDrag.dy/h)*1.1));
  e.preventDefault();
},{passive:false});

document.addEventListener('touchend',()=>{
  if(!shDrag)return;
  const d=shDrag; shDrag=null;
  if(!d.live)return;

  d.el.style.transition='';
  d.overlay.style.transition='';
  const v=d.dy/Math.max(1,Date.now()-d.t0);
  const go=d.dy>SHEET_DISMISS_PX||(d.dy>SHEET_FLICK_PX&&v>SHEET_DISMISS_V);

  /* Hand the inline styles back either way — the class-driven transition
     takes over from here. */
  const reset=()=>{
    d.el.style.transform='';
    d.overlay.style.opacity='';
  };
  if(!go){ reset(); return; }

  if(d.kind==='action'){ reset(); closeActionSheet(); return; }
  /* Let the sheet finish falling from where the finger left it rather
     than snapping back to closed. */
  d.el.style.transform='translateY(100%)';
  d.overlay.style.opacity='0';
  d.overlay.classList.remove('open');
  releasePickerRoom(null);
  setTimeout(()=>{ reset(); setBodyScrollLock(false); },300);
  /* A swipe is a dismissal like any other, so it owes the same return
     to whatever sheet opened this one. */
  afterSheetClosed(d.overlay.id);
},{passive:true});

/* ==============================================================
   SWIPE BETWEEN SCREENS

   iOS pops a pushed screen with a swipe that must start at the very
   left edge. That edge is a hard target on a big phone, so here the
   gesture works from anywhere on the screen.

   Root tabs move to their neighbour in tab-bar order, so the whole app
   is reachable by swiping.

   **The Map tab is the exception**, and has to be: the globe is dragged
   horizontally to spin it, so a full-screen swipe there would fight the
   map on every pan. On that screen alone the swipe must start near an
   edge — which is still the iOS gesture, just narrower — leaving the
   middle to the globe. Same for the per-collection map inside the
   detail screen.
   ============================================================== */
const SWIPE_MIN=64;              /* deliberate, not a stray drag */
const SWIPE_RATIO=1.5;           /* clearly horizontal, not a scroll */
const SWIPE_EDGE=34;             /* the escape hatch on a map screen */
const PUSHED_PAGES=['detail','upnext','done'];

let pgSwipe=null;

document.addEventListener('touchstart',e=>{
  pgSwipe=null;
  if(e.touches.length!==1||overlayOpen())return;
  const t=e.touches[0];
  const w=window.innerWidth;
  const nearEdge=t.clientX<=SWIPE_EDGE||t.clientX>=w-SWIPE_EDGE;
  /* On a map, only the edges are ours. */
  if(ownsHorizontal(e.target)&&!nearEdge)return;
  pgSwipe={x0:t.clientX,y0:t.clientY,t0:Date.now()};
},{passive:true});

document.addEventListener('touchend',e=>{
  const s=pgSwipe; pgSwipe=null;
  if(!s||overlayOpen())return;
  const t=e.changedTouches[0];
  const dx=t.clientX-s.x0, dy=t.clientY-s.y0;
  if(Math.abs(dx)<SWIPE_MIN||Math.abs(dx)<Math.abs(dy)*SWIPE_RATIO)return;
  /* A slow drag is someone repositioning their hand, not a swipe. */
  if(Date.now()-s.t0>700)return;

  if(PUSHED_PAGES.includes(curPage)){
    /* Back only. There is nothing to the right of a pushed screen. */
    if(dx>0){ curPage==='detail'?goBack():nav('home'); }
    return;
  }
  const i=TAB_ORDER.indexOf(curTab);
  if(i<0)return;
  const next=TAB_ORDER[i+(dx<0?1:-1)];
  if(next) selectTab(next);
},{passive:true});
