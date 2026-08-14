/* ==============================================================
   ME TAB — lifetime stats and account actions.

   Replaces the old marketing home page: the four stats that used
   to sit under the hero live here, which is where a native app
   keeps them.
   ============================================================== */

async function renderMe(){
  /* Identity first — it needs no network beyond the cached profile. */
  renderMeIdentity();
  renderMeNotifications();

  const lists=await fetchCollections();
  const allActs=await fetchAllActivities(lists);
  const total=allActs.length;
  const done=allActs.filter(a=>a.completed).length;
  const pct=total?Math.round(done/total*100):0;
  const located=allActs.filter(a=>a.locationLat&&a.locationLng).length;

  $('meStats').innerHTML=`
    <div class="stat"><div class="stat-num">${lists.length}</div><div class="stat-label">Lists</div></div>
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Activities</div></div>
    <div class="stat accent"><div class="stat-num">${done}</div><div class="stat-label">Accomplished</div></div>
    <div class="stat"><div class="stat-num">${located}</div><div class="stat-label">On the map</div></div>`;

  $('meProgress').innerHTML=`
    <div class="me-progress-top">
      <strong>${pct}% complete</strong>
      <span>${done} of ${total}</span>
    </div>
    <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>`;
}

function renderMeIdentity(){
  const name=(userProfile&&userProfile.display_name)||'';
  const email=(currentUser&&currentUser.email)||'';
  const handle=(userProfile&&userProfile.username)?'@'+userProfile.username:email;
  const initials=(name||email||'?').trim().charAt(0).toUpperCase();
  $('meIdentity').innerHTML=`
    <div class="me-avatar">${esc(initials)}</div>
    <div class="me-identity-body">
      <div class="me-identity-name">${esc(name||email||'Signed in')}</div>
      ${handle?`<div class="me-identity-sub">${esc(handle)}</div>`:''}
    </div>`;
}

/* ==============================================================
   THE PROFILE ROW

   `Users` holds the display name and handle. It is read once per
   session — nothing in the app changes it after sign-up — and
   **created here if it is missing**, which is the part that matters.

   It used to be written inline by handleAuth() at the moment of
   sign-up. That only ever worked on a project with email confirmation
   switched off, because confirmation means signUp() returns no session
   and there is nothing signed in to write the row with. This project
   has confirmation on, so every account created since has had no
   profile: no name in the You tab, and nothing to identify them by on
   a shared list.

   So the name and username now travel as auth user metadata (see
   handleAuth) and the row is written on the first sign-in that has a
   real session. Running it on every sign-in rather than only after
   sign-up is deliberate — it also repairs the accounts that were
   created while this was broken.
   ============================================================== */
const USERNAME_RE=/^[a-z0-9_.]{3,30}$/;

async function loadUserProfile(){
  if(!currentUser)return;
  const{data,error}=await sb.from('Users').select('display_name,username').eq('id',currentUser.id).maybeSingle();
  if(error){console.error('loadUserProfile:',error);return;}
  if(data){
    userProfile=data;
    if(curPage==='me') renderMeIdentity();
    return;
  }
  await createUserProfile();
}

/* Fall back to the email's local part for anything created before the
   metadata was carried, so an old account still gets a sane handle
   rather than being left without a row forever. */
function profileSeed(){
  const meta=(currentUser&&currentUser.user_metadata)||{};
  const email=(currentUser&&currentUser.email)||'';
  const local=email.split('@')[0]||'';
  const display=(meta.display_name||meta.full_name||meta.name||local||'').trim();
  let username=(meta.username||local||'').toLowerCase().replace(/[^a-z0-9_.]/g,'');
  if(username.length<3) username=(username+'user').slice(0,12);
  return{display:display||username,username:username.slice(0,30)};
}

async function createUserProfile(){
  const seed=profileSeed();
  if(!seed.username)return;

  /* Usernames are meant to be unique, so a collision is an expected
     outcome rather than an error — suffix and retry a few times before
     giving up. 23505 is Postgres "unique_violation". */
  for(let attempt=0;attempt<4;attempt++){
    const username=attempt?`${seed.username.slice(0,26)}${Math.floor(Math.random()*9000+1000)}`:seed.username;
    const row={id:currentUser.id,display_name:seed.display,username};
    const{error}=await sb.from('Users').insert(row);
    if(!error){
      userProfile={display_name:row.display_name,username:row.username};
      if(curPage==='me') renderMeIdentity();
      return;
    }
    if(error.code!=='23505'){
      /* Most likely no INSERT policy on Users. Nothing the user can do
         about it, and the app works without a profile — so say it once
         in the console and carry on rather than blocking sign-in. */
      console.warn('createUserProfile:',error);
      return;
    }
    /* The id is the primary key, so a collision on it means the row
       already exists — another tab won the race. Re-read and stop. */
    const{data}=await sb.from('Users').select('display_name,username').eq('id',currentUser.id).maybeSingle();
    if(data){
      userProfile=data;
      if(curPage==='me') renderMeIdentity();
      return;
    }
  }
}

/* Notification row in the You tab: reflects the real permission state
   rather than pretending it is a toggle we control. */
function renderMeNotifications(){
  const row=$('meNotifyRow');
  if(!row)return;
  if(!remindersReady()){row.style.display='none';return;}
  row.style.display='';
  const state=notificationState();
  const label={granted:'On',denied:'Blocked in browser settings',
               default:'Off',unsupported:'Not supported'}[state];
  $('meNotifyValue').textContent=label;
  row.onclick=state==='default'?requestNotifications:()=>{
    if(state==='denied') showToast('Allow notifications in your browser settings');
    else if(state==='granted') showToast('Reminders are on');
  };
}

function confirmSignOut(){
  showActionSheet({
    title:'Sign Out',
    message:'You’ll need to sign in again to reach your lists.',
    items:[{label:'Sign Out',role:'destructive',onSelect:handleSignOut}],
  });
}
