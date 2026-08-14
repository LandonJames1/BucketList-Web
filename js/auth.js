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
  /* An invite opened while signed out lands here. Say so, or signing
     in looks like the only thing the link did. See js/sharing.js. */
  updateAuthInviteNotice();
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
  setAuthView('check');
}
function authBackToForm(){
  pendingConfirmEmail='';
  setAuthView('form');
  applyAuthMode();
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
         the app is really being served — see confirmRedirectUrl(). */
      /* An invite the person is signing up *in order to accept* rides
         along too. It is already on this device's shelf, but the shelf
         is localStorage and the confirmation email is very often read
         on a different phone — where the shelf is empty and the invite
         would be silently lost. Metadata is the one thing that follows
         an account through the email. See AN INVITE THAT OUTLIVES THE
         DEVICE in js/sharing.js. */
      const meta={display_name:displayName,username};
      /* The shelf, not just the in-memory global. pendingJoin is a plain
         variable and any reload between opening the link and pressing
         this button empties it — a service-worker update, a tab the OS
         discarded, a manual refresh. The durable copy is the one that
         has actually survived to this moment. */
      const joinCode=pendingJoin||bootReadLong(JOIN_STASH);
      if(joinCode) meta.pending_join=joinCode;

      const{data,error}=await sb.auth.signUp({
        email,password,
        options:{
          data:meta,
          emailRedirectTo:confirmRedirectUrl(),
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
      const{data,error}=await sb.auth.signInWithPassword({email,password});
      if(error)throw error;
      resetAccountState();
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
