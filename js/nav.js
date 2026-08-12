/* ==============================================================
   NAVIGATION — the tab bar, pushed screens, and the navigation bar.

   Three root destinations (Lists / Map / Me) plus one screen that
   pushes on top of Lists (a collection's detail). nav() is the only
   way to change screens: it also renders the nav bar for the new
   screen and tears down any live Leaflet map, which leaks and
   misrenders if you re-init over a live instance.
   ============================================================== */

/* Which tab each screen belongs to, so the right tab stays lit while
   a pushed screen is showing. */
const PAGE_TAB={home:'home',lists:'lists',globalmap:'map',me:'me',detail:'lists',upnext:'home',done:'home'};

function nav(page,listId){
  const prev=curPage;
  if(page==='detail'&&listId) curListId=listId;

  /* Pushed screens slide in from the right; switching tabs cross-fades. */
  const PUSHED=['detail','upnext','done'];
  const pushing = PUSHED.includes(page) && !PUSHED.includes(prev);
  if(pushing) backTab=curTab;

  document.querySelectorAll('.page').forEach(p=>{
    p.classList.remove('active','anim-push','anim-fade');
  });
  const el=$('page-'+page);
  el.classList.add('active', pushing?'anim-push':'anim-fade');

  curPage=page;
  curTab=PAGE_TAB[page]||curTab;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===curTab));

  /* Tear down any live map on the way out. A GL map holds a WebGL
     context, and browsers cap how many can exist at once. */
  if(page!=='globalmap') destroyGlobalMap();
  if(page!=='detail')    destroyDetailMap();

  window.scrollTo(0,0);
  updateNavbar();

  if(page==='home')      renderHome();
  if(page==='upnext')    renderUpNext();
  if(page==='done')      renderDone();
  if(page==='lists')     renderCollections();
  if(page==='detail')    renderDetail();
  if(page==='globalmap') renderGlobalMap();
  if(page==='me')        renderMe();
}

/* Tab bar taps. Tapping the tab you are already on inside a pushed
   screen pops back to that tab's root, as iOS does. */
function selectTab(tab){
  if(tab===curTab&&curPage!=='detail')return;
  const root={home:'home',lists:'lists',map:'globalmap',me:'me'}[tab];
  curTab=tab;
  nav(root);
}
function goBack(){ nav(backTab==='lists'?'lists':backTab); }

/* ==============================================================
   NAVIGATION BAR
   Rebuilt per screen rather than hidden/shown, so each screen owns
   exactly the buttons it needs.
   ============================================================== */
function updateNavbar(){
  const left=$('navLeft'),right=$('navRight'),title=$('navTitle');
  left.innerHTML='';right.innerHTML='';title.textContent='';

  /* The primary "add" action is the floating button, not a bar button —
     the top-right corner is the worst place on a phone to put the thing
     people press most. The bar keeps only Back and the overflow menu. */
  let fabFn=null,fabLabel='';
  if(curPage==='home'){
    /* No floating button here: the composer near the top of the page is
       already the add affordance, and two of them competing on one
       screen is one too many. */
    title.textContent='Bucket List';
  } else if(curPage==='lists'){
    title.textContent='Your Lists';
    fabFn=openNewList;fabLabel='New list';
  } else if(curPage==='upnext'||curPage==='done'){
    title.textContent=curPage==='upnext'?'Up Next':'Accomplished';
    left.innerHTML=`<button class="navbtn back" onclick="nav('home')">${icon('chevron-left')}<span>Home</span></button>`;
  } else if(curPage==='detail'){
    left.innerHTML=`<button class="navbtn back" onclick="goBack()">${icon('chevron-left')}<span>Lists</span></button>`;
    right.innerHTML=`<button class="navbtn disc ghost" onclick="openCollectionMenu()" aria-label="List options">${icon('ellipsis')}</button>`;
    fabFn=openNewActivity;fabLabel='New activity';
  } else if(curPage==='globalmap'){
    title.textContent='The Map';   /* the map has its own floating controls */
  } else if(curPage==='me'){
    title.textContent='You';
  }
  setFab(fabFn,fabLabel);
  applyNavCondense();
}

/* Show/hide and rebind the floating action button for the current screen.
   Takes the handler itself rather than a string, so the binding is a real
   reference the bundler/linter can see. */
function setFab(fn,label){
  const fab=$('fab');
  if(!fab)return;
  if(!fn){fab.classList.remove('show');fab.onclick=null;return;}
  fab.innerHTML=icon('plus');
  fab.setAttribute('aria-label',label||'Add');
  fab.onclick=()=>fn();
  fab.classList.add('show');
}

/* ==============================================================
   SCROLL — the large title scrolls away and the compact title in
   the bar fades in behind it, the way a UINavigationController
   with prefersLargeTitles does.
   ============================================================== */
function applyNavCondense(){
  const bar=$('navbar');
  const marker=document.querySelector('.page.active .large-title h1');
  let condensed;
  if(marker){
    /* Condense once the large title's baseline passes under the bar. */
    condensed = marker.getBoundingClientRect().bottom <= navChromeTop()+2;
    /* Pushed screens have no large title of their own; they show the
       collection name instead, so seed it from the page. */
  } else {
    condensed = window.scrollY > 8;
  }
  bar.classList.toggle('condensed',condensed);
}
function navChromeTop(){
  const cs=getComputedStyle(document.documentElement);
  return parseFloat(cs.getPropertyValue('--nav-h'))+
         (parseFloat(cs.getPropertyValue('--safe-top'))||0);
}
window.addEventListener('scroll',applyNavCondense,{passive:true});

/* ==============================================================
   BODY SCROLL LOCK
   The single place that touches body overflow. It refuses to
   unlock while anything that wants the lock is still on screen,
   so closing one overlay cannot unfreeze the page under another.
   ============================================================== */
function setBodyScrollLock(lock){
  if(lock){document.body.style.overflow='hidden';return;}
  if(document.querySelector('.modal-overlay.open'))return;
  if($('actionSheet').classList.contains('open'))return;
  if($('lightbox').classList.contains('open'))return;
  document.body.style.overflow='';
}

/* ==============================================================
   VIEWPORT CHANGES
   Rotating the phone (or the iOS URL bar collapsing) leaves a GL map
   with stale dimensions until it is told to re-measure.
   ============================================================== */
let navResizeTimer=null;
window.addEventListener('resize',()=>{
  clearTimeout(navResizeTimer);
  navResizeTimer=setTimeout(()=>{
    refreshMapZoomFloors();
    applyNavCondense();
  },180);
});
