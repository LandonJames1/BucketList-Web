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
  /* Find out whether reminders are available, then re-render Home so the
     banner can appear, and ping anything already due. */
  probeRemindColumn().then(ok=>{
    if(ok&&curPage==='home') renderHome();
    checkDueReminders();
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
  if(document.visibilityState==='visible') sb.auth.startAutoRefresh();
  else sb.auth.stopAutoRefresh();
});

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
  sb.auth.stopAutoRefresh();
  await sb.auth.signOut();
  currentUser=null;userProfile=null;
  curTab='home';curPage='home';curListId=null;
  showAuth();
}
