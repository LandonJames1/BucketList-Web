/* ==============================================================
   AUTH — sign in, sign up, sign out, and the auth screen toggle.
   ============================================================== */

/* ==============================================================
   EVERYTHING THAT BELONGS TO ONE ACCOUNT

   Called on every auth transition, in both directions — not only when
   someone presses Sign Out.

   That distinction is the whole bug this exists for. The caches were
   cleared in handleSignOut() and nowhere else, so a sign-in that
   followed any *other* kind of session ending — a lapsed token, which
   onAuthStateChange handles by quietly showing the login screen —
   started with the previous account's rows still in memory and served
   them. A fresh sign-up was the worst case, because a new account has
   no disk snapshot, so showApp()'s `if(warm)` skipped the revalidate
   that would eventually have corrected it.

   js/api.js now refuses to hand its cache to a user it was not filled
   for, which is the backstop and the thing that makes this
   structurally safe. This is the belt to that pair of braces: it
   clears the per-account state living in the other files, which the
   cache guard cannot see.

   Two things it deliberately leaves alone:

   - **The disk snapshot.** It is keyed by user id already (snapKey in
     offline.js), so it cannot leak across accounts, and a session
     lapsing in a tunnel is not a reason to destroy someone's offline
     copy of their own data. Explicit sign-out still clears it.
   - **The schema probes** (remind_at, the media bucket) are facts
     about the database, identical for everyone, so re-probing them
     per account would be a round trip for a known answer.
     probeSharing() is reset anyway because _sharedIds beside it is
     per-user, and separating them is not worth one cheap query.
   ============================================================== */
function resetAccountState(){
  cancelPendingStats();
  invalidateAll();
  invalidateSharedIds();
  resetSharingProbe();
  userProfile=null;
  /* The globe is kept alive across navigation, so nothing else would
     dispose it — and its pins are the previous account's places. */
  destroyGlobalMap();
  destroyDetailMap();
  curTab='home';curPage='home';backTab='lists';
  curListId=null;editingListId=null;editingActId=null;
  curFilter='all';curSort=DEFAULT_ACT_SORT;curView='list';
  upMedia=[];coverPhoto='';
}

function showAuth(){
  $('authPage').style.display='flex';
  $('appWrap').style.display='none';
  pwaUpdateOnlineState();
}
async function showApp(){
  $('authPage').style.display='none';
  $('appWrap').style.display='block';

  /* ---- Paint before the network ----

     readRows() only reaches for the on-disk snapshot when the network
     cannot answer, which is right for any single fetch and wrong for a
     cold launch: a complete copy of the user's data is already sitting
     in IndexedDB, and Home was nonetheless waiting on two *serialised*
     round trips — collections, then the activities that depend on
     their ids — before it drew a single row.

     So prime the cache off the disk snapshot first. nav('home') then
     renders from memory with no request at all, and revalidate()
     refreshes behind the painted screen. A genuinely first-ever launch
     has no snapshot, returns false, and waits exactly as before. */
  const warm=await primeFromSnapshot();

  /* Boot into the dashboard. */
  nav('home');

  /* Everything past this point is deliberately not awaited: none of it
     gates the first paint, and awaiting any of it would put it back on
     the critical path this function exists to keep clear. */
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
  /* And whether an activity can belong to more than one list. Armed
     here rather than only in the revalidate chain below, because the
     *write* path needs the answer even on a cold launch that never
     revalidates — sending a column the table does not have fails the
     whole insert. See probeMultiList() in js/api.js. */
  probeMultiList();
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

  /* Home was drawn from disk, so it may be behind what the server has
     — another device, or someone else editing a shared list. Pull
     fresh behind the painted screen and redraw whatever is showing by
     then. Only when it was actually painted from the snapshot: without
     one, nav('home') above already went to the network.

     The two scope probes are awaited first, and only here. Nothing is
     waiting on this — the screen is already up — so letting them
     answer before the refetch costs nothing visible and guarantees
     both queries run with the right scope the first time. Run in
     parallel, the collections fetch would sometimes come back
     owned-only, discover sharing was on, and have to do the whole
     thing again; the activities fetch would ask for the home list
     alone and miss anything shared into one of your lists from
     outside it. See probeMultiList() in js/api.js. */
  if(warm) Promise.all([probeSharing(),probeMultiList()])
    .then(revalidate).then(()=>refreshAfterChange());
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
      const username=$('authUsername').value.trim().toLowerCase();
      if(!displayName||!username){setAuthError('Name and username are required.');throw{handled:true};}
      if(!USERNAME_RE.test(username)){
        setAuthError('Usernames are 3–30 characters: letters, numbers, dots or underscores.');
        throw{handled:true};
      }
      /* The name and username ride along on the auth user rather than
         being written to `Users` here.

         This project has email confirmation switched on, which means
         signUp() comes back with a user and NO session — so there was
         never anything signed in to write that row with, and the two
         values the user had just typed were dropped on the floor. Every
         account created that way ended up with no profile at all: no
         name in the You tab, and nothing to show them by on a shared
         list. Handing them to auth means they survive the round trip
         through the confirmation email, and ensureUserProfile() writes
         the row on the first sign-in that actually has a session.

         emailRedirectTo points the confirmation link back at wherever
         the app is really being served. Supabase ignores it unless the
         URL is allow-listed, falling back to the project's Site URL —
         so it can only ever improve on the default. */
      const{data,error}=await sb.auth.signUp({
        email,password,
        options:{
          data:{display_name:displayName,username},
          emailRedirectTo:location.origin+location.pathname,
        },
      });
      if(error)throw error;
      if(data.user&&data.session){
        /* Before currentUser moves, not after: everything cleared here
           is keyed off who is signed in, and showApp() starts reading
           it immediately. */
        resetAccountState();
        currentUser=data.user;showApp();return;
      }
      if(data.user&&!data.session){
        setAuthError('Check your email to confirm your account.',true);
      }
    } else {
      const{data,error}=await sb.auth.signInWithPassword({email,password});
      if(error)throw error;
      resetAccountState();
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
    if(currentUser){
      /* A lapsed token lands here, not in handleSignOut(), and used to
         leave every cache filled with the departing account's rows for
         whoever signed in next. */
      currentUser=null;
      resetAccountState();
      showAuth();
    }
    return;
  }
  /* A different user arriving on an existing page — the confirmation
     link opened in a tab that still has the old session, or a token
     refresh that resolves to another account. Reset before the id
     moves, for the same reason handleAuth() does. */
  if(session?.user){
    if(currentUser&&currentUser.id!==session.user.id) resetAccountState();
    currentUser=session.user;
  }
});

async function handleSignOut(){
  /* Unsent writes belong to the account that made them, so give the
     queue one last chance to drain before the session goes. */
  await flushQueue();
  /* Every per-account cache, the debounced recounts, the live maps and
     the navigation state. Shared with the two paths in
     onAuthStateChange, so a deliberate sign-out and a lapsed session
     leave the app in exactly the same state. */
  resetAccountState();
  /* Explicit sign-out is the one case that also clears the on-disk
     snapshot. It is keyed by user id so it cannot leak, but someone
     signing out of a shared device means it, and resetAccountState()
     deliberately keeps it for a session that merely lapsed. */
  await offlineSignOut();
  /* Before the session goes: a shared device should stop receiving this
     account's reminders. */
  await unsubscribeFromPush();
  sb.auth.stopAutoRefresh();
  await sb.auth.signOut();
  currentUser=null;
  showAuth();
}
