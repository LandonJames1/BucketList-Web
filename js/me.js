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

/* The Users row holds the display name; fetched once per session and
   reused, since nothing in the app changes it after sign-up. */
async function loadUserProfile(){
  if(!currentUser)return;
  const{data,error}=await sb.from('Users').select('display_name,username').eq('id',currentUser.id).maybeSingle();
  if(error){console.error('loadUserProfile:',error);return;}
  userProfile=data||null;
  if(curPage==='me') renderMeIdentity();
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
