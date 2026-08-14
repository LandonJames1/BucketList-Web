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
  set('bulkAddIcon',icon('plus','ic-sm'));

  set('lbCloseBtn',icon('x'));
  set('lbPrev',icon('chevron-left'));
  set('lbNext',icon('chevron-right'));

  set('installCloseIcon',icon('x'));
  set('iosCloseIcon',icon('x'));
  set('iosShareGlyph',icon('share'));

  /* The composer's left slot is the screenshot button, not a
     decorative plus — see the note in index.html. */
  set('homeComposerShot',icon('camera'));
  set('homeComposerGo',icon('chevron-right'));
  set('searchFieldIcon',icon('search'));
  set('searchClearIcon',icon('x','ic-xs'));
  set('actListChevron',icon('chevron-right'));
  set('aRemindChevron',icon('chevron-right'));
  set('meNotifyIcon',icon('clock'));
  set('listPickerSearchIcon',icon('search'));
  set('listPickerNewIcon',icon('plus'));
  set('meInstallChevron',icon('chevron-right'));
  set('meShareIcon',icon('link'));
  set('meShareChevron',icon('chevron-right'));
  set('meJoinIcon',icon('share'));
  set('meJoinChevron',icon('chevron-right'));
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
  /* Before the session is restored, not after: a link can be shared in
     — or an invite to a shared list opened — while signed out, and the
     query string has to be captured and stripped before anything else
     can navigate away from it. showApp() picks both back up once there
     is a user. */
  /* A confirmation link is the third thing that can arrive in the query
     string, and it is read FIRST — the two below blank the whole search
     string once they have taken what they came for, which would destroy
     it. This one removes only its own keys and puts the rest back, so
     running it ahead of them costs them nothing. See CONFIRMING AN
     EMAIL ADDRESS in js/auth.js. */
  readEmailConfirmation();
  readSharedInput();
  readPendingJoin();
  /* The offline banner reflects the queue, which may be non-empty from
     a previous session, so it is painted before anything can render. */
  updateSyncUI();
  /* A confirmation link is a session waiting to be claimed, and it is
     tried *before* the stored one. Both orders matter: someone
     confirming on a second device has no stored session to find, and
     someone confirming on the first device has a stale one — for the
     same account, but issued before the address was verified. */
  const confirmed=await consumeEmailConfirmation();
  const user=confirmed||await restoreSession();
  if(user){
    currentUser=user;
    /* Awaited so the splash holds until Home has actually painted.
       showApp() primes the cache from the disk snapshot before its
       first render (see the note there), which is a few milliseconds
       of IndexedDB rather than a network round trip — but dropping the
       splash before it resolved would show an empty shell for exactly
       that long. Everything slow inside showApp() runs detached, so
       this waits on the paint and nothing else. */
    await showApp();
    /* After the paint, not before: arriving from an email link is
       otherwise indistinguishable from an ordinary launch, and the one
       thing this person wants to know is whether the trip through their
       inbox actually did anything. */
    if(confirmed) showToast('Email confirmed — you’re signed in.');
  } else {
    showAuth();
  }
  document.body.classList.remove('booting');
})();
