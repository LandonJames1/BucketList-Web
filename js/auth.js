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

async function handleSignOut(){
  await sb.auth.signOut();
  currentUser=null;userProfile=null;
  curTab='home';curPage='home';curListId=null;
  showAuth();
}
