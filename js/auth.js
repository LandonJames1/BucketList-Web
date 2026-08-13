/* ==============================================================
   AUTH — sign in, sign up, sign out, and the auth screen toggle.
   ============================================================== */

function showAuth(){
  $('authPage').style.display='flex';
  $('appWrap').style.display='none';
  pwaUpdateOnlineState();
}
function showApp(){
  $('authPage').style.display='none';
  $('appWrap').style.display='block';
  /* Boot into the dashboard. */
  nav('home');
  loadUserProfile();
  pwaUpdateOnlineState();
  /* Only offer the iOS install walkthrough once someone is signed in;
     installing a login screen is pointless. */
  pwaMaybeShowIosHint();
  sb.auth.startAutoRefresh();
  /* Whether the media bucket exists decides how the completion sheet
     stores photos and whether it accepts video at all. Probed once,
     early, so the first upload does not have to find out. */
  probeStorage();
  /* Find out whether reminders are available, then re-render Home so the
     banner can appear, and ping anything already due. */
  /* Anything written while offline on an earlier visit is still in the
     queue on disk. Find it and send it now, before the first render,
     so the screen is never briefly drawn without the user's own
     changes on it. See js/offline.js. */
  offlineInit();
  /* Whether the members table exists decides whether collections are
     fetched as "mine" or as "everything RLS lets me see" — probed
     early for the same reason as the media bucket. See js/sharing.js. */
  probeSharing();
  /* A link shared into the app is held from boot until there is
     somewhere to file it. See js/share.js. */
  handleSharedInput();
  /* An invite to a shared list is held the same way, and for the same
     reason: it can arrive while signed out. See js/sharing.js. */
  handlePendingJoin();
  probeRemindColumn().then(ok=>{
    if(ok&&curPage==='home') renderHome();
    checkDueReminders();
    /* Re-register the device if permission was granted on a previous
       visit — push subscriptions can be rotated by the browser. */
    if(ok&&notificationState()==='granted') subscribeToPush();
  });
}

let authIsSignUp=false;
function toggleAuthMode(){
  authIsSignUp=!authIsSignUp;
  $('authTitle').textContent=authIsSignUp?'Create Account':'Welcome Back';
  $('authSub').textContent=authIsSignUp
    ?'Start collecting the things you want to do.'
    :'Sign in to reach your lists.';
  $('authBtn').textContent=authIsSignUp?'Create Account':'Sign In';
  $('authToggleText').textContent=authIsSignUp?'Already have an account?':'Don’t have an account?';
  $('authToggleBtn').textContent=authIsSignUp?'Sign in':'Create one';
  $('authExtraFields').style.display=authIsSignUp?'':'none';
  $('authPass').setAttribute('autocomplete',authIsSignUp?'new-password':'current-password');
  setAuthError('');
}
function setAuthError(msg,ok){
  const el=$('authError');
  el.textContent=msg||'';
  el.classList.toggle('ok',!!ok);
}

async function handleAuth(){
  const email=$('authEmail').value.trim();
  const password=$('authPass').value;
  if(!email||!password){setAuthError('Enter your email and password.');return;}
  setAuthError('');
  const btn=$('authBtn');
  btn.disabled=true;
  const label=btn.textContent;
  btn.textContent='…';
  try{
    if(authIsSignUp){
      const displayName=$('authDisplayName').value.trim();
      const username=$('authUsername').value.trim();
      if(!displayName||!username){setAuthError('Name and username are required.');throw{handled:true};}
      const{data,error}=await sb.auth.signUp({email,password});
      if(error)throw error;
      if(data.user&&data.session){
        await sb.from('Users').insert({id:data.user.id,display_name:displayName,username});
        currentUser=data.user;showApp();return;
      }
      if(data.user&&!data.session){
        setAuthError('Check your email to confirm your account.',true);
      }
    } else {
      const{data,error}=await sb.auth.signInWithPassword({email,password});
      if(error)throw error;
      currentUser=data.user;showApp();return;
    }
  }catch(err){
    if(!err.handled) setAuthError(err.message||'Sign in failed.');
  }
  btn.disabled=false;
  btn.textContent=label;
}

/* ==============================================================
   KEEPING THE SESSION ALIVE

   supabase-js refreshes the access token on a timer, but browsers
   throttle timers in background tabs and suspend them outright in a
   backgrounded PWA. Without this the token can be stale on resume and
   the next request 401s, which reads to the user as "it logged me out
   again". The documented fix is to stop the timer when hidden and
   restart it — which also forces an immediate refresh — when visible.
   ============================================================== */
document.addEventListener('visibilitychange',()=>{
  if(!currentUser)return;
  if(document.visibilityState!=='visible'){ sb.auth.stopAutoRefresh(); return; }
  sb.auth.startAutoRefresh();
  /* Rows are cached for the session so tab switches cost nothing (see
     api.js). Coming back to the app is the one moment that cache could
     be behind — the same account may have been used on another device —
     so drop it, pull fresh, and redraw whatever is on screen. */
  revalidate().then(()=>refreshAfterChange());
});

/* The network returning is the other moment the cache can be stale: a
   cold launch offline fills it from the on-disk snapshot rather than
   from the server.

   revalidate() flushes the write queue before it refetches — see the
   note on it in api.js. Doing it the other way round makes the user's
   offline additions visibly disappear and then come back. */
window.addEventListener('online',()=>{
  updateSyncUI();
  if(!currentUser)return;
  revalidate().then(()=>refreshAfterChange());
});
window.addEventListener('offline',()=>updateSyncUI());

/* Keep currentUser in step with whatever the auth client decides.
   TOKEN_REFRESHED fires on every successful renewal; SIGNED_OUT fires if
   a refresh ultimately fails, which is the one case where showing the
   login screen is correct. */
sb.auth.onAuthStateChange((event,session)=>{
  if(event==='SIGNED_OUT'){
    if(currentUser){ currentUser=null;userProfile=null;showAuth(); }
    return;
  }
  if(session?.user) currentUser=session.user;
});

async function handleSignOut(){
  /* Unsent writes belong to the account that made them, so give the
     queue one last chance to drain before the session goes. */
  await flushQueue();
  /* The cache is per-account. Leaving it behind would show the next
     person to sign in on this device the previous one's lists — and
     that now means the on-disk snapshot as well as the in-memory one. */
  invalidateAll();
  await offlineSignOut();
  /* The globe is kept alive across navigation, so signing out has to be
     the thing that actually disposes it — otherwise the next account
     inherits the previous one's pins. */
  destroyGlobalMap();
  destroyDetailMap();
  /* Before the session goes: a shared device should stop receiving this
     account's reminders. */
  await unsubscribeFromPush();
  sb.auth.stopAutoRefresh();
  await sb.auth.signOut();
  currentUser=null;userProfile=null;
  curTab='home';curPage='home';curListId=null;
  showAuth();
}
