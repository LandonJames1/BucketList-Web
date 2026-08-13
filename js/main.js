/* ==============================================================
   BOOT — paint the static icons, restore the Supabase session, then
   show the app or the auth screen.
   Loaded LAST: every function it touches is already defined.
   ============================================================== */

/* index.html leaves empty placeholder elements where an icon belongs
   rather than inlining a dozen SVG blobs into the markup. Fill them
   in once, here, from the sprite map in js/icons.js. */
function paintStaticIcons(){
  const set=(id,html)=>{const el=$(id);if(el)el.innerHTML=html;};

  /* Tab bar — each tab carries both a stroked and a filled glyph;
     CSS shows whichever matches the selected state. */
  const tab=(id,off,on,label)=>set(id,
    `<span class="ic-off">${icon(off)}</span><span class="ic-on">${icon(on)}</span><span>${label}</span>`);
  tab('tabHome','home','home-fill','Home');
  tab('tabLists','stack','stack-fill','Lists');
  tab('tabMap','compass','compass-fill','Map');
  tab('tabMe','summit','summit-fill','You');

  set('coverZoneIcon',icon('photo','ic-lg'));
  set('photoZoneIcon',icon('camera','ic-sm'));
  set('actMoreChevron',icon('chevron-down'));
  set('compMoreChevron',icon('chevron-down'));
  set('bulkAddIcon',icon('plus','ic-sm'));

  set('lbCloseBtn',icon('x'));
  set('lbPrev',icon('chevron-left'));
  set('lbNext',icon('chevron-right'));

  set('installCloseIcon',icon('x'));
  set('iosCloseIcon',icon('x'));
  set('iosShareGlyph',icon('share'));

  set('homeComposerIcon',icon('plus'));
  set('homeComposerGo',icon('chevron-right'));
  set('actListChevron',icon('chevron-right'));
  set('aRemindChevron',icon('chevron-right'));
  set('meNotifyIcon',icon('clock'));
  set('listPickerSearchIcon',icon('search'));
  set('listPickerNewIcon',icon('plus'));
  set('meInstallChevron',icon('chevron-right'));
  const lead=document.querySelector('#page-me .li-blue');
  if(lead) lead.innerHTML=icon('share');
}

/* ==============================================================
   SESSION RESTORE

   Signing in should stick. Three things can break that, and each is
   handled here:

   1. The access token has lapsed while the app was closed. getSession()
      normally refreshes it, but if that call fails we retry explicitly
      with refreshSession() before giving up.
   2. The device is offline at launch. A network failure is *not* a
      signed-out user — dumping someone to the login screen because
      their train went into a tunnel is the worst version of this bug.
      With a stored session we go straight into the app and let the
      offline banner explain why data is missing.
   3. The refresh timer stalls while the app is backgrounded. auth.js
      restarts it on foreground.
   ============================================================== */
async function restoreSession(){
  try{
    const{data:{session},error}=await sb.auth.getSession();
    if(error)throw error;
    if(session?.user) return session.user;
  }catch(e){
    console.warn('[auth] getSession failed:',e);
  }

  /* getSession came back empty. If there is no stored session at all the
     user is genuinely signed out; if there is one, the failure was the
     refresh, so try that directly. */
  if(!hasStoredSession()) return null;

  try{
    const{data:{session}}=await sb.auth.refreshSession();
    if(session?.user) return session.user;
  }catch(e){
    console.warn('[auth] refreshSession failed:',e);
  }

  /* Still nothing, but a session is on disk and we are offline: trust it
     rather than signing the user out over a dropped connection. */
  if(!navigator.onLine){
    const stored=readStoredSession();
    if(stored?.user) return stored.user;
  }
  return null;
}

function readStoredSession(){
  try{ return JSON.parse(localStorage.getItem('bucketlist-auth')); }
  catch(e){ return null; }
}
function hasStoredSession(){ return !!readStoredSession(); }

(async()=>{
  paintStaticIcons();
  const user=await restoreSession();
  if(user){
    currentUser=user;
    showApp();
  } else {
    showAuth();
  }
  document.body.classList.remove('booting');
})();
