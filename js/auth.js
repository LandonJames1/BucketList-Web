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
  /* The conversation cache, the unread badge and the live realtime
     channel are all per-account — and the channel is subscribed under
     the previous session's token, so it has to go with the rest. See
     ONE ACCOUNT AT A TIME. */
  resetMessagesState();
  /* Whether the *previous* account still existed says nothing about
     this one. See IS THIS SESSION STILL A REAL ACCOUNT? below. The
     watch is restarted by showApp(), so it never runs without a user
     to run for. */
  resetSessionLiveCheck();
  stopSessionWatch();
  _recheckAfter=0;
  userProfile=null;
  /* The saved Home address is per-account, and it is mirrored into
     localStorage — so without this the next person to sign in on this
     device inherits the previous one's home address as their search
     bias and their "Home" shortcut. */
  resetHomePlace();
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
  /* Someone who arrived on an invite link and has never had a session
     on this device is, overwhelmingly, someone being handed the app for
     the first time — that is what sharing is for. Opening on Sign In
     asks them for an account they do not have and makes creating one
     the second thing they find. The check is deliberately "has this
     browser ever held a session", not "is there one now": a signed-out
     regular still gets the form they expect. */
  if(pendingJoin&&!authIsSignUp&&!hasStoredSession()){
    authIsSignUp=true;
    applyAuthMode();
  }
  /* An invite opened while signed out lands here. Say so, or signing
     in looks like the only thing the link did. See js/sharing.js. */
  updateAuthInviteNotice();
  pwaUpdateOnlineState();
}

/* ==============================================================
   IS THIS SESSION STILL A REAL ACCOUNT?

   It shipped that it did not have to be. Deleting an account signs out
   the device that pressed the button and nothing else — and there is
   always something else: another browser, a laptop, and on iOS the
   installed PWA, which has its own storage partition and is therefore
   a second signed-in copy of the app by construction.

   Every one of those keeps a session in localStorage, and nothing ever
   asked the server about it:

   - getSession() answers from disk without a request whenever the
     access token has not expired, so restoreSession() saw a perfectly
     good session for an account that no longer existed;
   - PostgREST verifies a JWT's *signature*. It does not check that
     auth.uid() still exists in auth.users, so the token kept being
     accepted — reads came back empty, because the rows had cascaded
     away, which is exactly what an account with nothing in it looks
     like.

   The result was being signed into a deleted account for the lifetime
   of an access token, seeing an empty app, and — the way this was
   found — following an invite link into it. Everything downstream then
   failed in a way that pointed anywhere but here: join_collection()
   inserts a member row with a foreign key onto auth.users, so it was
   rejected for a reason no message on screen could explain.

   So the session is checked against the server once per launch.
   getUser() is a real request to /auth/v1/user, which 4xxs for a user
   that has been deleted or banned.

   TWO RULES, and the second is the one that keeps this from becoming a
   worse bug than the one it fixes:

   1. It never blocks the first paint. The check is started at boot and
      awaited only by the things that must not run against a dead
      session — joining a list, redeeming a claimed invite.
   2. **Only a definitive answer from the server signs anyone out.** A
      request that failed to arrive is not an answer. Offline, or on a
      flaky connection, the session is kept — signing someone out
      because their train went into a tunnel is the bug restoreSession()
      already exists to avoid, and it would be worse arriving from here.
   ============================================================== */
let _liveCheck=null;
function resetSessionLiveCheck(){ _liveCheck=null; }

/* Memoised: several callers want the answer and it is one request. */
function ensureSessionLive(){
  if(!_liveCheck) _liveCheck=verifyLiveUser();
  return _liveCheck;
}

async function verifyLiveUser(){
  if(!currentUser) return false;
  /* Nothing to learn, and see rule 2. */
  if(!navigator.onLine) return true;

  let err=null;
  try{
    const res=await sb.auth.getUser();
    if(res&&res.data&&res.data.user) return true;
    err=res&&res.error;
  }catch(e){ err=e; }

  if(!authAnswerIsDefinitive(err)) return true;
  console.warn('[auth] this session belongs to an account that no longer exists — signing out',err);
  await signOutStaleSession();
  return false;
}

/* ---- Asking often enough to be worth calling a forced sign-out ----

   The launch check alone leaves a device that is already open running
   as a deleted account until somebody closes it. These are the other
   moments, and between them there is no realistic gap:

   - the app is foregrounded (the visibilitychange handler);
   - the network comes back;
   - five minutes pass with the app on screen;
   - the server rejects a write. That last one is the one that matters
     most, because it means the very first thing the user tries to DO
     in a deleted account throws them out, rather than the next tick.

   All of them funnel through here so the throttle is shared: several
   failing writes in a row are one question, not one each. */
const SESSION_RECHECK_MS=5*60*1000;
const RECHECK_THROTTLE_MS=30*1000;
let _sessionTimer=null,_recheckAfter=0;

function recheckSessionSoon(){
  if(!currentUser||!navigator.onLine) return;
  const now=Date.now();
  if(now<_recheckAfter) return;
  _recheckAfter=now+RECHECK_THROTTLE_MS;
  resetSessionLiveCheck();
  ensureSessionLive();
}

function startSessionWatch(){
  stopSessionWatch();
  _sessionTimer=setInterval(()=>{
    /* Hidden is the foreground handler's job, and a backgrounded PWA
       has its timers suspended anyway — this would only fire late and
       ask a question that is about to be asked properly. */
    if(document.visibilityState!=='visible') return;
    recheckSessionSoon();
  },SESSION_RECHECK_MS);
}
function stopSessionWatch(){
  if(_sessionTimer){ clearInterval(_sessionTimer); _sessionTimer=null; }
}

/* Did the server actually answer, and was the answer "no"? */
function authAnswerIsDefinitive(err){
  /* A reply with no user and no error in it. */
  if(!err) return true;
  /* supabase-js's own class for "the request never got there". */
  if(err.name==='AuthRetryableFetchError') return false;
  const status=Number(err.status||err.statusCode||0);
  /* Being rate-limited or timed out says nothing about the account,
     and acting on either would sign out a perfectly good user. */
  if(status===408||status===429) return false;
  if(status>=400&&status<500) return true;
  const code=String(err.code||err.error_code||'').toLowerCase();
  return /user_not_found|session_not_found|user_banned|bad_jwt/.test(code);
}

/* Like handleSignOut(), minus everything that needs a working session.
   The token is dead, so revoking it server-side would only 4xx; the
   push unsubscribe would too, and its rows cascaded with the account. */
async function signOutStaleSession(){
  const hadInvite=!!pendingJoin;
  currentUser=null;              /* before signOut, so the SIGNED_OUT
                                    handler does not repeat this */
  resetAccountState();
  /* The deleted account's own offline copy of its data. Explicit, as in
     handleSignOut(): this device is not coming back to that account. */
  await offlineSignOut();
  try{ await sb.auth.signOut({scope:'local'}); }
  catch(e){ console.warn('[auth] local sign-out:',e); }
  showAuth();
  setAuthNotice('<strong>That account no longer exists.</strong>'+
    (hadInvite
      ?'It was deleted, and this device was still signed in as it. Sign in or create an account — the invite is still here.'
      :'It was deleted, and this device was still signed in as it. Sign in or create an account to carry on.'));
}

/* ==============================================================
   WHETHER TO ASK THE SERVER FOR A WAITING INVITE

   claim_invites_for_me() is a round trip, and for almost every launch
   the answer is "nothing" — so it is not on the boot path. Two things
   make it due, and between them they cover every way a claimed invite
   can be reached:

   - a real authentication just happened (the form, or a confirmation
     link redeemed at boot). That is the moment a claim is redeemable
     for the first time, on whatever device it happened on;
   - the account is younger than a week. This is the belt: a session
     restored from storage never passes the first test, so a sweep that
     failed — offline at the moment of confirmation, say — would
     otherwise never be retried, because the person is already signed in
     and has no reason to sign in again. An invite in flight is days
     old at most, and an established account never pays for this.
   ============================================================== */
let authJustAuthenticated=false;
const INVITE_SWEEP_AGE=7*24*60*60*1000;
function inviteSweepDue(){
  if(!currentUser) return false;
  if(authJustAuthenticated) return true;
  const born=Date.parse(currentUser.created_at||'');
  return !!born&&(Date.now()-born)<INVITE_SWEEP_AGE;
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

  /* A first-ever launch has no snapshot, so nav('home') below goes
     straight to the network — and the two scope probes would still be
     in flight when it did. Both of them invalidate and refetch when
     they flip true, so that first render cost a *full* fetch of both
     tables twice: once filtered to owned lists and the home-list
     column, once correctly. The probes are one column with limit 1 and
     run in parallel, so paying a single round trip here buys the
     doubled one back. Only on a cold launch: a snapshot-primed boot is
     already correct by construction and must not wait for anything. */
  if(!warm) await Promise.all([probeSharing(),probeMultiList()]);

  /* Boot into the dashboard. */
  nav('home');

  /* Everything past this point is deliberately not awaited: none of it
     gates the first paint, and awaiting any of it would put it back on
     the critical path this function exists to keep clear. */
  loadUserProfile();
  /* The saved Home address — the location field's no-typing shortcut and
     the bias point for place search. Reads localStorage synchronously
     first, so the shortcut is there before the round trip lands. */
  loadHomePlace();
  pwaUpdateOnlineState();
  /* Only offer the iOS install walkthrough once someone is signed in;
     installing a login screen is pointless. */
  pwaMaybeShowIosHint();
  sb.auth.startAutoRefresh();
  /* Keep asking whether this account still exists while the app is on
     screen. Without it, a device left open runs as a deleted account
     until somebody closes it. See IS THIS SESSION STILL A REAL
     ACCOUNT? */
  startSessionWatch();
  /* Whether the media bucket exists decides how the completion sheet
     stores photos and whether it accepts video at all. Probed once,
     early, so the first upload does not have to find out. */
  /* The You tab's avatar control needs the answer too — it is offered
     only when the bucket exists — and it may already be on screen, so
     redraw the identity row once the probe lands rather than leaving
     the control hidden until the next visit. */
  probeStorage().then(()=>{ if(curPage==='me') renderMeIdentity(); });
  /* Whether an activity can remember that its location IS home, which
     is what lets a change of home address move them. See "THIS
     ACTIVITY IS AT HOME" in api.js. */
  probeHomeFlag();
  /* Spin the geo function's isolate up and open the connection, so the
     first place search of the session pays for neither. */
  warmGeo();
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
  /* And whether this project has the messages tables. The Messages tab
     stays hidden until this answers true, and answering fills the hub
     so the tab arrives with its unread count already on it. See
     js/messages.js. */
  probeMessages();
  /* A message notification tapped while the app was closed lands here.
     See ARRIVING FROM A NOTIFICATION in js/messages.js. */
  handlePushLanding();
  /* A link shared into the app is held from boot until there is
     somewhere to file it. See js/share.js. */
  handleSharedInput();
  /* An invite to a shared list is held the same way, and for the same
     reason: it can arrive while signed out. See js/sharing.js. */
  const hadPendingJoin=!!pendingJoin;
  handlePendingJoin();
  /* And the server-side half of the same thing: an invite claimed
     against this email address before the account existed, which is the
     only copy that survives a sign-up read on a different device.

     Skipped when the link path above is already running, so the two
     cannot race to join the same list or announce it twice. Nothing is
     lost by that — the claim stays on the server, and a later launch
     consumes it silently once the membership is already there. */
  if(!hadPendingJoin&&inviteSweepDue()) claimInvitesForMe();
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
  applyAuthMode();
}
/* Split out of toggleAuthMode() so the screen can be *restored* to a
   mode as well as flipped into one — coming back from the check-your-
   email state has to repaint every one of these without inverting the
   flag underneath it. */
function applyAuthMode(){
  $('authTitle').textContent=authIsSignUp?'Create Account':'Welcome Back';
  $('authSub').textContent=authIsSignUp
    ?'Start collecting the things you want to do.'
    :'Sign in to reach your lists.';
  $('authBtn').textContent=authIsSignUp?'Create Account':'Sign In';
  $('authToggleText').textContent=authIsSignUp?'Already have an account?':'Don’t have an account?';
  $('authToggleBtn').textContent=authIsSignUp?'Sign in':'Create one';
  $('authExtraFields').style.display=authIsSignUp?'':'none';
  $('authPass').setAttribute('autocomplete',authIsSignUp?'new-password':'current-password');
  /* A sign-up that went off to wait for an email left this disabled and
     reading "…", because it returned before handleAuth() could put it
     back. Coming back to the form is the moment that gets undone. */
  $('authBtn').disabled=false;
  setAuthError('');
}

/* The form and the check-your-email panel are one screen in two states,
   not two screens. */
function setAuthView(view){
  const check=view==='check';
  $('authForm').style.display=check?'none':'';
  $('authCheck').style.display=check?'':'none';
}
function showCheckEmail(email){
  pendingConfirmEmail=email;
  setAuthError('');
  setAuthNotice('');
  $('authCheckError').textContent='';
  $('authTitle').textContent='Check your email';
  $('authSub').textContent='We sent a confirmation link to '+email+'.';
  /* The invite notice above the form is still on screen and still says
     "create an account or sign in", which is no longer what is being
     asked. Repoint it: the one thing this person cannot otherwise know
     is that the invite is not riding on this browser any more. */
  authInviteWaitingNotice();
  setAuthView('check');
}
function authBackToForm(){
  pendingConfirmEmail='';
  setAuthView('form');
  applyAuthMode();
  /* Undo showCheckEmail()'s repointing — there is a form to fill in
     again, so the notice goes back to saying what to do with it. */
  updateAuthInviteNotice();
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
  /* The durable copy, not just the in-memory one: any reload between
     opening the link and pressing this button empties the global — a
     service-worker update, a tab iOS discarded, a manual refresh. */
  const joinCode=pendingJoin||bootReadLong(JOIN_STASH);
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
         the app is really being served — see confirmRedirectUrl(). */

      /* An invite the person is signing up in order to accept is
         handed to the server BEFORE the account exists, keyed by the
         address they are creating it with. This is the one copy of the
         code that is not tied to this browser, and the confirmation
         email is very often read on a different one.

         Before signUp() rather than after: if the request succeeds on
         the server and the response never arrives, the account exists
         and this page may never run again — the claim has to already
         be there. A claim for a sign-up that then fails costs nothing;
         it is capped and expires. See js/sharing.js. */
      if(joinCode) await claimInviteForEmail(joinCode,email);

      const{data,error}=await sb.auth.signUp({
        email,password,
        options:{
          data:{display_name:displayName,username},
          emailRedirectTo:confirmRedirectUrl(),
        },
      });
      if(error)throw error;
      if(data.user&&data.session){
        /* Before currentUser moves, not after: everything cleared here
           is keyed off who is signed in, and showApp() starts reading
           it immediately. */
        resetAccountState();
        authJustAuthenticated=true;
        currentUser=data.user;showApp();return;
      }
      /* An email that already has a *confirmed* account comes back
         looking exactly like a fresh sign-up — a user, no session — so
         that signUp() cannot be used to test whether someone has an
         account here. The one thing that differs is an empty identities
         array. Without this check the person is sent to wait for an
         email that was never sent, which is the same silent dead end
         the rest of this section exists to close. */
      if(data.user&&Array.isArray(data.user.identities)&&!data.user.identities.length){
        setAuthError('That email already has an account. Sign in instead.');
        throw{handled:true};
      }
      if(data.user&&!data.session){ showCheckEmail(email); return; }
    } else {
      /* The same claim on the sign-in path. The link's own capture
         normally handles an existing account — it is sitting in this
         browser and handlePendingJoin() picks it up a moment from now —
         but that is the copy every known failure here destroys, and a
         claim is one round trip on the rare launch that has an invite
         pending. It costs nothing when the link path works: the server
         sees the membership already exists and consumes it in silence. */
      if(joinCode) await claimInviteForEmail(joinCode,email);
      const{data,error}=await sb.auth.signInWithPassword({email,password});
      if(error)throw error;
      resetAccountState();
      authJustAuthenticated=true;
      currentUser=data.user;showApp();return;
    }
  }catch(err){
    if(!err.handled) setAuthError(authErrorText(err,'Sign in failed.'));
  }
  btn.disabled=false;
  btn.textContent=label;
}

/* ==============================================================
   CONFIRMING AN EMAIL ADDRESS

   This project has email confirmation switched on, so an account does
   not exist usefully until its owner has come back through a link in
   their inbox. That round trip leaves the app entirely — through a mail
   client, quite often onto a different device — and everything it has
   to survive happens somewhere this code does not run. So, like
   accepting an invite, it is built with a floor under it rather than
   one happy path.

   THE LINK ITSELF IS CONFIGURED IN THE DASHBOARD, NOT HERE. Two
   settings, and getting either wrong looks identical from the outside
   ("I clicked the link and it opened a broken page"):

   - **Authentication → URL Configuration → Site URL** is where every
     confirmation link goes. Left at the Supabase default it is
     http://localhost:3000, so every recipient lands on a dead page.
     emailRedirectTo below does *not* override this on its own —
     Supabase silently ignores a redirect that is not allow-listed and
     falls back to Site URL, which is exactly how this failure hides.
   - **Redirect URLs** must therefore contain the app's real origin
     before emailRedirectTo has any effect at all.

   - **Authentication → Emails → Confirm signup** should point at
     token_hash rather than the default ConfirmationURL:

         {{ .SiteURL }}/index.html?token_hash={{ .TokenHash }}&type=email

     That is what makes the link work on a *different device from the
     one that signed up*, which is the common case: people sign up on a
     laptop and read their mail on a phone. The default link comes back
     as ?code=… and, because this client uses PKCE, redeeming it needs
     the code verifier that signUp() wrote to localStorage in the
     original browser. On any other device that exchange fails with
     "both auth code and code verifier should be non-empty" and the
     recipient lands on the sign-in screen having apparently done
     nothing. verifyOtp() carries no such requirement.

   The ?code= path is still handled below, because links already sent
   are still in people's inboxes, and because password recovery uses the
   same machinery.
   ============================================================== */

/* What the URL carried, read once at boot and consumed once after. */
let pendingConfirm=null;
/* Who "Send it again" is for. */
let pendingConfirmEmail='';

/* Where a confirmation link should come back to. Deliberately
   location-derived rather than a constant: the app is served from
   several places over its life (localhost, a LAN address, the real
   host) and a hardcoded URL would send every developer's test sign-up
   to production. */
function confirmRedirectUrl(){ return location.origin+location.pathname; }

/* Read at boot, before anything can navigate away from the URL.
   Supabase has three ways of handing back the result and one of handing
   back a failure, and which one arrives depends on the email template
   and the client's flow type — so all four are read rather than
   assuming the template is the one documented above. */
function readEmailConfirmation(){
  let q,h;
  try{
    q=new URLSearchParams(location.search);
    /* An implicit-grant link puts everything after the # instead, where
       it never reaches the server. */
    h=new URLSearchParams((location.hash||'').replace(/^#/,''));
  }catch(e){ return; }
  const get=k=>(q.get(k)||h.get(k)||'').trim();

  const c={
    error:get('error_description')||get('error'),
    errorCode:get('error_code'),
    code:get('code'),
    tokenHash:get('token_hash'),
    accessToken:get('access_token'),
    refreshToken:get('refresh_token'),
    type:get('type')||'email',
  };
  if(!c.error&&!c.code&&!c.tokenHash&&!c.accessToken) return;
  pendingConfirm=c;

  /* Single-use credentials have no business staying in the address bar,
     in the back/forward history, or in a URL someone might screenshot
     to ask why it did not work.

     Only our own keys are removed, and the rest of the query string is
     put back: readPendingJoin() and readSharedInput() run against the
     same URL, and blanking it wholesale here would eat an invite.

     Those two do blank it wholesale, which is why main.js runs this one
     *first*. Reading it last looked equivalent and was not: an invite
     link followed to a sign-up puts ?join= and the confirmation keys on
     the same URL, readPendingJoin() stripped the lot, and the
     confirmation was gone with no notice to say so — the exact silent
     failure the rest of this section exists to close. */
  ['error','error_code','error_description','code','token_hash','type',
   'access_token','refresh_token','expires_in','expires_at','token_type']
    .forEach(k=>q.delete(k));
  const rest=q.toString();
  history.replaceState(null,'',location.pathname+(rest?'?'+rest:''));
}

/* Redeem whatever the link carried. Returns the signed-in user, or null
   — and never throws: a link that cannot be honoured has to leave a
   sign-in screen with an explanation on it, not a blank app. */
async function consumeEmailConfirmation(){
  const c=pendingConfirm;
  pendingConfirm=null;
  if(!c) return null;

  if(c.error){ setAuthNotice(confirmFailureHTML(c.errorCode,c.error)); return null; }

  try{
    let res=null;
    if(c.tokenHash){
      res=await sb.auth.verifyOtp({type:c.type,token_hash:c.tokenHash});
    } else if(c.code){
      res=await sb.auth.exchangeCodeForSession(c.code);
    } else if(c.accessToken&&c.refreshToken){
      res=await sb.auth.setSession({
        access_token:c.accessToken, refresh_token:c.refreshToken,
      });
    }
    if(res&&res.error) throw res.error;
    if(res&&res.data&&res.data.user) return res.data.user;
    /* An access token with no refresh token beside it: nothing to
       persist, so treat it as a link that did not work rather than
       signing someone in for as long as one token lasts. */
    setAuthNotice(confirmFailureHTML('','That link did not carry a sign-in.'));
  }catch(e){
    console.warn('[auth] confirmation link failed:',e);
    setAuthNotice(confirmFailureHTML(e.code||e.error_code||'',e.message||''));
  }
  return null;
}

/* Every failure ends in the same offer, because every one of them is
   fixed the same way: send another link. */
function confirmFailureHTML(code,message){
  const c=String(code||'').toLowerCase();
  const m=String(message||'').toLowerCase();
  let lead='That link didn’t work.';
  let body='It may already have been used. Enter your email and we’ll send a new one.';
  if(c.includes('expired')||m.includes('expired')){
    lead='That link has expired.';
    body='Confirmation links are good for 24 hours. Enter your email below and we’ll send a fresh one.';
  } else if(m.includes('code verifier')){
    /* The cross-device PKCE failure the token_hash template above
       exists to prevent. Worth naming precisely: told only "that link
       didn't work", someone will keep re-opening the same link on the
       same phone. */
    lead='That link needs the device you signed up on.';
    body='Open it in the same browser you created the account in, or enter your email below for a fresh link.';
  }
  return '<strong>'+esc(lead)+'</strong>'+esc(body)
    +'<button onclick="resendFromNotice()">Send a new link</button>';
}

function setAuthNotice(html,ok){
  const el=$('authNotice');
  if(!el) return;
  el.innerHTML=html||'';
  el.classList.toggle('ok',!!ok);
  el.style.display=html?'':'none';
}

/* ==============================================================
   WHAT SUPABASE'S ERRORS SAY vs WHAT THEY MEAN

   Auth errors are surfaced raw almost everywhere in this app, and for
   most of them that is right — "Invalid login credentials" is already
   the sentence you would write. Three are not, and all three arrive at
   the worst possible moment.

   "email rate limit exceeded" is the one that matters most. It is not
   about this account or this address: it is the whole *project's*
   hourly allowance on Supabase's built-in email service, which is a
   testing facility with a very small budget. Shown verbatim it reads
   as "you have done something wrong", when the truthful version is
   "the project cannot send any more email for a while" — a completely
   different thing to be told, and it points at the only real fix,
   which is configuring custom SMTP.
   ============================================================== */
function authErrorText(err,fallback){
  const code=String((err&&(err.code||err.error_code))||'').toLowerCase();
  const msg=String((err&&err.message)||'');
  const low=msg.toLowerCase();

  if(code.includes('over_email_send_rate_limit')||low.includes('email rate limit')){
    return 'Too many emails from this app in the last hour. Wait a few minutes and try again.';
  }
  /* The per-address cooldown, which does name a number — keep it. */
  if(low.includes('for security purposes')) return msg;
  if(code.includes('over_request_rate_limit')){
    return 'Too many attempts just now. Give it a minute.';
  }
  return msg||fallback||'Something went wrong.';
}

/* One request behind both resend buttons. The cooldown is not politeness
   — Supabase enforces its own per-address wait, and a press inside that
   window comes back as an error that reads like the resend itself
   failed. Matched to the 60s server side rather than undercutting it,
   which only manufactures a guaranteed failure. */
let confirmResendAt=0;
const RESEND_COOLDOWN=60000;
async function sendConfirmationEmail(email,btn,errEl){
  const say=msg=>{ if(errEl) errEl.textContent=msg; };
  if(!email){ say('Enter your email first.'); return false; }
  const wait=Math.ceil((confirmResendAt-Date.now())/1000);
  if(wait>0){ say('Just a moment — try again in '+wait+'s.'); return false; }

  const label=btn?btn.textContent:'';
  if(btn){ btn.disabled=true; btn.textContent='…'; }
  say('');
  let ok=false;
  try{
    const{error}=await sb.auth.resend({
      type:'signup', email,
      options:{emailRedirectTo:confirmRedirectUrl()},
    });
    if(error) throw error;
    confirmResendAt=Date.now()+RESEND_COOLDOWN;
    ok=true;
  }catch(e){
    say(authErrorText(e,'Could not send that email.'));
  }
  if(btn){ btn.disabled=false; btn.textContent=label; }
  return ok;
}

async function resendConfirmation(){
  const email=pendingConfirmEmail||$('authEmail').value.trim();
  const ok=await sendConfirmationEmail(email,$('authResendBtn'),$('authCheckError'));
  if(ok) $('authCheckError').textContent='Sent. Check your inbox.';
}

/* The same thing from the expired-link notice, where there is no
   remembered address — whoever opened the link may never have had this
   app open before. */
async function resendFromNotice(){
  const email=$('authEmail').value.trim();
  if(!email){
    setAuthError('Enter your email above, then press it again.');
    $('authEmail').focus();
    return;
  }
  const ok=await sendConfirmationEmail(email,null,$('authError'));
  if(ok){
    setAuthNotice('<strong>Sent.</strong>A new link is on its way to '+esc(email)+'.',true);
    setAuthError('');
  }
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
  /* And the same question the boot asks, asked again. An installed PWA
     is rarely killed, so "the next launch" can be days away — and the
     token refresh that would eventually notice only runs as the current
     one nears expiry. Coming back to the app is the natural moment, and
     it is one request beside the two revalidate() is about to make. */
  recheckSessionSoon();
  /* Rows are cached for the session so tab switches cost nothing (see
     api.js). Coming back to the app is the one moment that cache could
     be behind — the same account may have been used on another device —
     so drop it, pull fresh, and redraw whatever is on screen. */
  revalidate().then(()=>refreshAfterChange());
  /* The hub's unread counts are the one thing realtime deliberately
     does not cover — postgres_changes filters on a single column, so
     the live channel only reaches the conversation on screen. Coming
     back to the app is when the rest of them get caught up. See the
     header of js/messages.js. */
  refreshConversations();
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
  /* The check is skipped outright while offline — a request that cannot
     be made is not an answer — so the connection returning is the first
     moment it can be asked at all. */
  recheckSessionSoon();
  revalidate().then(()=>refreshAfterChange());
  refreshConversations();
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
