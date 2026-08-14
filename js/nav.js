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
const PAGE_TAB={home:'home',lists:'lists',globalmap:'map',me:'me',detail:'lists',
  upnext:'home',done:'home',search:'home'};

function nav(page,listId){
  const prev=curPage;
  if(page==='detail'&&listId) curListId=listId;
  /* Opening a collection always starts in list view — including
     re-opening the one you were just in. The view mode is a per-visit
     choice, not a preference; leaving the map up because that is where
     you were last is never what was meant. Keyed on *entering* detail,
     not on the list id, or coming back to the same list would keep it. */
  if(page==='detail'&&prev!=='detail') curView='list';

  /* Pushed screens slide in from the right; switching tabs cross-fades. */
  const PUSHED=['detail','upnext','done','search'];
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

  /* The per-collection map is torn down on the way out: it is rebuilt
     for whichever collection you open next anyway, so keeping it costs a
     WebGL context for nothing.

     The Map tab's globe is deliberately kept. Rebuilding it meant
     re-downloading the style, re-fetching tiles and re-spinning the
     globe every single visit, which is most of what made that tab feel
     slow. That leaves at most two live contexts — the cap browsers
     enforce is an order of magnitude above that. renderGlobalMap()
     resizes it on the way back in, since a hidden container measures 0. */
  if(page!=='detail') destroyDetailMap();

  window.scrollTo(0,0);
  updateNavbar();

  if(page==='home')      renderHome();
  if(page==='upnext')    renderUpNext();
  if(page==='done')      renderDone();
  if(page==='search')    renderSearch();
  if(page==='lists')     renderCollections();
  if(page==='detail')    renderDetail();
  if(page==='globalmap') renderGlobalMap();
  if(page==='me')        renderMe();
}

/* Which screen is the root of each tab, and the order they sit in the
   tab bar — which is the order js/gestures.js swipes through. */
const TAB_ROOT={home:'home',lists:'lists',map:'globalmap',me:'me'};
const TAB_ORDER=['home','lists','map','me'];

/* Tab bar taps.

   A tab button must ALWAYS go somewhere. The old guard bailed out
   whenever the tapped tab was already the selected one, which is wrong
   for every screen pushed on top of a tab: standing on Up Next or
   Accomplished (both owned by Home) and pressing Home did nothing at
   all, because the Home tab was already lit. It only special-cased
   'detail'. The rule is simply "if you are not on the tab's root, go to
   it" — which is also what iOS does.

   An open sheet is dismissed first. The tab bar sits above the scrim and
   stays tappable, so without this a tap navigated the screen underneath
   and left the sheet floating over the wrong page. */
function selectTab(tab){
  const root=TAB_ROOT[tab];
  if(!root)return;
  dismissOverlays();
  if(curPage===root){
    /* Already home: scroll back to the top, the other thing iOS does. */
    window.scrollTo({top:0,behavior:'smooth'});
    return;
  }
  curTab=tab;
  nav(root);
}
function goBack(){ nav(backTab==='lists'?'lists':backTab); }

/* Close anything floating above the page. Used by the tab bar, so a
   navigation can never leave a sheet stranded over a screen it has
   nothing to do with. */
function dismissOverlays(){
  clearSheetReturns();
  document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open'));
  const as=$('actionSheet'),lb=$('lightbox');
  if(as&&as.classList.contains('open')) closeActionSheet();
  if(lb&&lb.classList.contains('open')) closeLightbox();
  setBodyScrollLock(false);
}

/* ==============================================================
   REFRESHING AFTER A CHANGE

   The single place that answers "something was written, what needs to
   be redrawn?". Every mutation ends here.

   It defaults to whatever screen is actually showing, which is the
   whole point: the old code passed a source string around by hand and
   several paths hardcoded 'detail'. Completing or editing an activity
   from Up Next therefore re-rendered the collection screen — a screen
   the user was not even looking at — and the row they had just changed
   sat there unchanged until a manual reload. Pass a source only to
   force a specific screen; leave it off and the current one is right.
   ============================================================== */
function refreshAfterChange(src){
  const p=src||curPage;
  if(p==='home')           return renderHome();
  if(p==='upnext')         return renderUpNext();
  if(p==='done')           return renderDone();
  /* Only the results, not the whole screen — rebuilding the field
     would drop focus, which on this screen means losing the caret
     mid-query every time a row is ticked off. */
  if(p==='search')         return renderSearchResults();
  if(p==='lists')          return renderCollections();
  if(p==='globalmap')      return renderGlobalMap();
  if(p==='me')             return renderMe();
  return renderDetail();
}

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
  /* Search is reachable from every screen that lists things, because
     "where did I put that" is a question you have on all of them.
     Not from the Map (its chrome floats over the globe and already has
     a filter) or from You (nothing there to search). */
  const searchBtn=`<button class="navbtn disc ghost" onclick="openSearch()"
      aria-label="Search everything">${icon('search')}</button>`;

  let fabFn=null,fabLabel='';
  if(curPage==='home'){
    /* No floating button here: the composer near the top of the page is
       already the add affordance, and two of them competing on one
       screen is one too many. */
    title.textContent='Someday We’ll Die';
    right.innerHTML=searchBtn;
  } else if(curPage==='lists'){
    title.textContent='Your Lists';
    right.innerHTML=searchBtn;
    fabFn=openNewList;fabLabel='New list';
  } else if(curPage==='upnext'||curPage==='done'){
    title.textContent=curPage==='upnext'?'Up Next':'Accomplished';
    left.innerHTML=`<button class="navbtn back" onclick="nav('home')">${icon('chevron-left')}<span>Home</span></button>`;
    right.innerHTML=searchBtn;
  } else if(curPage==='search'){
    title.textContent='Search';
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
   THE KEYBOARD AND THE TAB BAR

   .tabbar is `position: fixed; bottom: 0`. On iOS the software
   keyboard shrinks the **visual** viewport while leaving the layout
   viewport alone, and Safari re-anchors fixed elements to the visual
   one — so the tab bar climbs with the keyboard and parks on top of
   it, directly under the predictive-text row. It should stay at the
   bottom of the screen and let the keyboard cover it.

   Script cannot opt out of that re-anchoring, but it can measure it:
   the gap between the bottom of the visual viewport and the bottom of
   the layout viewport is exactly how far Safari has lifted the bar, so
   translating it back down by that amount returns it to where it
   belongs.

   Three things worth knowing:

   - **iOS only, and that is not a shortcut.** Chrome on Android keeps
     fixed elements pinned to the layout viewport already, which is the
     behaviour we are trying to produce. Applying the correction there
     as well would push the bar *below* the bottom of the screen by a
     whole keyboard's height.
   - **The tab bar and nothing else.** Bottom-anchored sheets *should*
     rise with the keyboard — that is the entire reason they are
     bottom-anchored, so a focused field stays put while the keyboard
     resizes the viewport. They are deliberately untouched.
   - **translate3d, not translateY.** The bar carries
     `transform: translateZ(0)` in CSS to force its own layer, without
     which iOS repaints it late during momentum scrolling and it
     appears to drift. An inline transform overrides that, so it has to
     keep the promotion itself.
   ============================================================== */
function syncTabbarToKeyboard(){
  const vv=window.visualViewport;
  const bar=$('tabbar');
  if(!vv||!bar||!isIOS())return;
  /* How much of the layout viewport sits below the visual one. Zero
     with the keyboard closed, the keyboard's height with it open. */
  const lift=Math.max(0,Math.round(window.innerHeight-(vv.height+vv.offsetTop)));
  bar.style.transform=lift?`translate3d(0,${lift}px,0)`:'';
}

if(window.visualViewport){
  /* Both events: resize fires when the keyboard opens or closes, scroll
     when the visual viewport is panned around inside the layout one —
     which iOS does on its own when a focused field would otherwise be
     hidden. */
  window.visualViewport.addEventListener('resize',syncTabbarToKeyboard);
  window.visualViewport.addEventListener('scroll',syncTabbarToKeyboard);
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
    /* Rotating with the keyboard up changes its height. */
    syncTabbarToKeyboard();
  },180);
});
