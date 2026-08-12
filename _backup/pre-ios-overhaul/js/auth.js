/* ==============================================================
   AUTH — sign in, sign up, sign out, and the auth screen toggle
   
   ============================================================== */

function showAuth(){
  $('authPage').style.display='flex';
  $('appWrap').style.display='none';
  pwaUpdateOnlineState();
}
function showApp(){
  $('authPage').style.display='none';
  $('appWrap').style.display='block';
  renderHome();
  pwaUpdateOnlineState();
  /* Offer the iOS "Add to Home Screen" walkthrough only once the user is
     actually signed in — installing a login screen is pointless. */
  pwaMaybeShowIosHint();
}
function toggleAuthMode(){
  const isLogin=$('authTitle').textContent==='Sign In';
  $('authTitle').textContent=isLogin?'Create Account':'Sign In';
  $('authBtn').textContent=isLogin?'Sign Up':'Sign In';
  $('authToggle').innerHTML=isLogin
    ?'Already have an account? <a href="#" onclick="event.preventDefault();toggleAuthMode()" style="color:var(--olive);font-weight:600">Sign in</a>'
    :'Don\'t have an account? <a href="#" onclick="event.preventDefault();toggleAuthMode()" style="color:var(--olive);font-weight:600">Create one</a>';
  $('authExtraFields').style.display=isLogin?'block':'none';
  $('authError').textContent='';
}
async function handleAuth(){
  const email=$('authEmail').value.trim();
  const password=$('authPass').value.trim();
  if(!email||!password){$('authError').textContent='Email and password required';return;}
  $('authError').textContent='';
  const isSignUp=$('authTitle').textContent==='Create Account';
  $('authBtn').disabled=true;
  $('authBtn').textContent='...';
  try{
    if(isSignUp){
      const displayName=$('authDisplayName').value.trim();
      const username=$('authUsername').value.trim();
      if(!displayName||!username){$('authError').textContent='All fields required';throw{handled:true};}
      const{data,error}=await sb.auth.signUp({email,password});
      if(error)throw error;
      if(data.user&&data.session){
        await sb.from('Users').insert({id:data.user.id,display_name:displayName,username});
        currentUser=data.user;showApp();return;
      } else if(data.user&&!data.session){
        $('authError').textContent='Check your email to confirm your account.';
        $('authError').style.color='var(--olive)';
      }
    } else {
      const{data,error}=await sb.auth.signInWithPassword({email,password});
      if(error)throw error;
      currentUser=data.user;showApp();return;
    }
  }catch(err){
    if(!err.handled) $('authError').textContent=err.message||'Authentication failed';
  }
  $('authBtn').disabled=false;
  $('authBtn').textContent=isSignUp?'Sign Up':'Sign In';
}
async function handleSignOut(){
  await sb.auth.signOut();
  currentUser=null;showAuth();
}
