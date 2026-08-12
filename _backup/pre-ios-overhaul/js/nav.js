/* ==============================================================
   NAVIGATION — page switching, topnav scroll state, mobile menu
   nav() is the single entry point for changing pages; it also tears
   down any live Leaflet map so it does not leak.
   ============================================================== */

function nav(page,listId){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  $('page-'+page).classList.add('active');
  curPage=page;
  /* Any page change closes the mobile menu, including ones triggered from
     somewhere other than a menu link (a card tap, goBack(), delList()). */
  closeMobileMenu();
  document.querySelectorAll('.topnav-link').forEach(l=>{
    l.classList.toggle('active',l.dataset.page===page||(page==='detail'&&l.dataset.page==='collections'));
  });
  window.scrollTo(0,0);
  /* Cleanup maps when leaving pages */
  if(page!=='globalmap'&&globalMapObj){globalMapObj.remove();globalMapObj=null;globalMapClusters=null;globalMapAllMarkers=[];globalMapHomeBounds=null;}
  if(page!=='detail'&&actMap){actMap.remove();actMap=null;detMapHomeBounds=null;}
  if(page==='home') renderHome();
  if(page==='collections') renderCollections();
  if(page==='detail'&&listId){curListId=listId;renderDetail();}
  if(page==='globalmap') renderGlobalMap();
}
function goBack(){nav('collections');}

/* ==============================================================
   TOPNAV SCROLL
   ============================================================== */
window.addEventListener('scroll',()=>{
  $('topnav').classList.toggle('scrolled',window.scrollY>20);
});

/* ==============================================================
   MOBILE MENU
   The full-screen overlay needs the page behind it frozen, or iOS
   scrolls the body under it while the menu sits still.
   ============================================================== */
function toggleMobileMenu(){
  const open=$('mobileMenu').classList.toggle('open');
  setBodyScrollLock(open);
}
function closeMobileMenu(){
  if(!$('mobileMenu').classList.contains('open'))return;
  $('mobileMenu').classList.remove('open');
  setBodyScrollLock(false);
}
/* Shared with the modal system: only release the lock once nothing that
   wants it is still on screen. */
function setBodyScrollLock(lock){
  if(lock){document.body.style.overflow='hidden';return;}
  if(document.querySelector('.modal-overlay.open'))return;
  if($('mobileMenu').classList.contains('open'))return;
  if($('lightbox').classList.contains('open'))return;
  document.body.style.overflow='';
}

/* ==============================================================
   VIEWPORT CHANGES
   Rotating the phone (or the iOS URL bar collapsing) leaves Leaflet
   with stale dimensions until it is told to re-measure.
   ============================================================== */
let navResizeTimer=null;
window.addEventListener('resize',()=>{
  clearTimeout(navResizeTimer);
  navResizeTimer=setTimeout(()=>{
    if(actMap) actMap.invalidateSize();
    if(globalMapObj) globalMapObj.invalidateSize();
  },200);
});
