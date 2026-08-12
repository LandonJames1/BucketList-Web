/* ==============================================================
   PWA — service-worker registration, install prompts, offline state.

   Loads before main.js. Everything here is defensive: if service
   workers are unavailable (file:// or plain http on a LAN address)
   the app still runs exactly as before, just without offline support.
   ============================================================== */

/* True when the app is running from the home screen rather than a browser tab.
   iOS exposes this as navigator.standalone; everyone else via display-mode. */
function isStandalone(){
  return window.navigator.standalone===true ||
         window.matchMedia('(display-mode: standalone)').matches ||
         window.matchMedia('(display-mode: minimal-ui)').matches;
}
function isIOS(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         /* iPadOS 13+ reports as a Mac; touch points give it away. */
         (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
}

/* Tag the root element so CSS can add safe-area padding only where it is
   actually needed (in a browser tab the browser chrome already handles it). */
if(isStandalone()) document.documentElement.classList.add('standalone');
if(isIOS()) document.documentElement.classList.add('ios');

/* ==============================================================
   SERVICE WORKER
   ============================================================== */
let pwaDeferredPrompt=null;

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('sw.js').then(reg=>{
      /* When a new worker finishes installing behind the active one, offer a
         reload rather than swapping the app out from under the user. */
      reg.addEventListener('updatefound',()=>{
        const sw=reg.installing;
        if(!sw)return;
        sw.addEventListener('statechange',()=>{
          if(sw.state==='installed'&&navigator.serviceWorker.controller){
            showPwaToast('A new version is ready.','Reload',()=>{
              sw.postMessage('SKIP_WAITING');
            });
          }
        });
      });
    }).catch(e=>console.warn('[pwa] service worker registration failed:',e));

    let refreshing=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(refreshing)return;
      refreshing=true;
      window.location.reload();
    });
  });
}

/* ==============================================================
   INSTALL PROMPT
   Chrome/Edge fire beforeinstallprompt and let us call prompt() later.
   iOS Safari has no such API, so it gets a one-time instruction sheet.
   ============================================================== */
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault();
  pwaDeferredPrompt=e;
  showPwaInstallBar();
});
window.addEventListener('appinstalled',()=>{
  pwaDeferredPrompt=null;
  hidePwaInstallBar();
  try{localStorage.setItem('bl_installed','1');}catch(e){}
});

function showPwaInstallBar(){
  if(isStandalone())return;
  try{if(localStorage.getItem('bl_install_dismissed'))return;}catch(e){}
  const bar=$('pwaInstall');
  if(bar) bar.classList.add('show');
}
function hidePwaInstallBar(){
  const bar=$('pwaInstall');
  if(bar) bar.classList.remove('show');
}
async function pwaInstall(){
  if(!pwaDeferredPrompt)return;
  pwaDeferredPrompt.prompt();
  await pwaDeferredPrompt.userChoice;
  pwaDeferredPrompt=null;
  hidePwaInstallBar();
}
function pwaDismissInstall(){
  hidePwaInstallBar();
  try{localStorage.setItem('bl_install_dismissed','1');}catch(e){}
}

/* ---- iOS "Add to Home Screen" sheet ---- */
function pwaMaybeShowIosHint(){
  if(!isIOS()||isStandalone())return;
  /* Only Safari can install; Chrome/Firefox on iOS cannot. */
  const ua=navigator.userAgent;
  if(/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua))return;
  try{if(localStorage.getItem('bl_ios_hint_dismissed'))return;}catch(e){}
  setTimeout(()=>{
    const sheet=$('iosInstall');
    if(sheet) sheet.classList.add('show');
  },2500);
}
function pwaDismissIosHint(){
  const sheet=$('iosInstall');
  if(sheet) sheet.classList.remove('show');
  try{localStorage.setItem('bl_ios_hint_dismissed','1');}catch(e){}
}

/* ==============================================================
   OFFLINE STATE
   Supabase reads fail silently when offline, so say so out loud.
   ============================================================== */
function pwaUpdateOnlineState(){
  const bar=$('offlineBar');
  if(!bar)return;
  bar.classList.toggle('show',!navigator.onLine);
}
window.addEventListener('online',()=>{
  pwaUpdateOnlineState();
  /* Re-render whatever page is showing now that data can load again. */
  if(typeof nav==='function'&&currentUser) nav(curPage,curListId);
});
window.addEventListener('offline',pwaUpdateOnlineState);

/* ==============================================================
   TOAST (also used for the "new version ready" prompt)
   ============================================================== */
let pwaToastTimer=null;
function showPwaToast(msg,actionLabel,onAction){
  const el=$('pwaToast');
  if(!el)return;
  el.innerHTML=`<span>${esc(msg)}</span>`;
  if(actionLabel){
    const btn=document.createElement('button');
    btn.className='pwa-toast-btn';
    btn.textContent=actionLabel;
    btn.onclick=()=>{el.classList.remove('show');if(onAction)onAction();};
    el.appendChild(btn);
  }
  el.classList.add('show');
  clearTimeout(pwaToastTimer);
  pwaToastTimer=setTimeout(()=>el.classList.remove('show'),onAction?15000:4000);
}
