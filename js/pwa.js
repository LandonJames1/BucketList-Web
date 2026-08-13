/* ==============================================================
   PWA — service-worker registration, install prompts, offline state.

   Everything here is defensive: if service workers are unavailable
   (file:// or plain http on a LAN address) the app still runs
   exactly as before, just without offline support.
   ============================================================== */

/* True when running from the home screen rather than a browser tab. */
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

/* Tag the root element so CSS can react to the install state. */
if(isStandalone()) document.documentElement.classList.add('standalone');
if(isIOS()) document.documentElement.classList.add('ios');

/* ==============================================================
   SERVICE WORKER
   ============================================================== */
let pwaDeferredPrompt=null;

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('sw.js').then(reg=>{
      /* Offer a reload when a new worker is waiting rather than
         swapping the app out from under the user. */
      reg.addEventListener('updatefound',()=>{
        const sw=reg.installing;
        if(!sw)return;
        sw.addEventListener('statechange',()=>{
          if(sw.state==='installed'&&navigator.serviceWorker.controller){
            showToast('A new version is ready.','Reload',()=>sw.postMessage('SKIP_WAITING'));
          }
        });
      });
      /* An installed PWA is rarely killed outright, so registration —
         the only moment the browser goes looking for a new sw.js — can
         be days apart. Without this a shipped fix simply never arrives
         on the home-screen copy, which reads as the fix never having
         been made. Check again whenever the app is foregrounded. */
      const checkForUpdate=()=>{
        if(document.visibilityState==='visible') reg.update().catch(()=>{});
      };
      document.addEventListener('visibilitychange',checkForUpdate);
      window.addEventListener('online',checkForUpdate);
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
   Chrome/Edge fire beforeinstallprompt and let us call prompt()
   later. iOS Safari has no such API, so it gets instructions.
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
  if(/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent))return;
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

/* The Me tab's "Add to Home Screen" row: re-open whichever install
   route this browser actually supports. */
function pwaShowInstallHelp(){
  if(isStandalone()){ showToast('Already installed'); return; }
  if(pwaDeferredPrompt){ pwaInstall(); return; }
  if(isIOS()){
    try{localStorage.removeItem('bl_ios_hint_dismissed');}catch(e){}
    const sheet=$('iosInstall');
    if(sheet) sheet.classList.add('show');
    return;
  }
  showToast('Use your browser’s menu to install this app.');
}

/* ==============================================================
   OFFLINE STATE

   The banner's text is owned by js/offline.js now, because what it
   should say depends on how many writes are waiting — "offline" and
   "offline with three unsaved changes" are different situations and
   the second one is the one people need told.

   The refresh on reconnect is not here either: auth.js listens for
   `online` and calls revalidate(), which flushes the queue first and
   then redraws the current screen. The old handler re-ran nav(),
   which also reset the scroll position out from under the user. */
function pwaUpdateOnlineState(){ updateSyncUI(); }
