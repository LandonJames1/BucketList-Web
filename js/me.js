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
  renderMeHome();

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

/* ==============================================================
   HOME

   One saved place, so the location field has an answer that needs no
   typing and no permission. It does two jobs:

     - the "Home" shortcut at the top of every location dropdown;
     - the bias point for place search when there is no geolocation
       fix, which is most of the time — see biasPoint() in location.js.
       That second job is quiet and is the more valuable one: it is
       what makes "coffee" mean the cafés near you rather than Coffee
       County, Georgia, without ever raising a permission prompt.

   STORAGE IS TWO-LAYERED, on purpose. The real home is three columns
   on `Users` (supabase/home.sql), so it follows the account to a new
   device. But the app has to work before that migration is run, and a
   missing column would otherwise take the whole profile query down
   with it — so the columns are read in their own query, a failure is
   noted once and tolerated, and localStorage carries the value on
   this device either way. Once the columns exist, a value saved
   locally is pushed up on the next load.

   The localStorage key is per-user. Every cache in this app is
   per-account and cleared by resetAccountState() (see ONE ACCOUNT AT
   A TIME in CLAUDE.md); a shared key would show the previous
   account's home address to the next person to sign in on the device.
   ============================================================== */
let _homePlace=null,_homeColumns=null;

function homePlace(){ return _homePlace; }
function homeKey(){ return currentUser?`bl_home:${currentUser.id}`:null; }

function readHomeLocal(){
  const k=homeKey();
  if(!k) return null;
  try{
    const raw=localStorage.getItem(k);
    if(!raw) return null;
    const v=JSON.parse(raw);
    return v&&v.location?v:null;
  }catch(e){ return null; }
}

function writeHomeLocal(place){
  const k=homeKey();
  if(!k) return;
  try{
    if(place&&place.location) localStorage.setItem(k,JSON.stringify(place));
    else localStorage.removeItem(k);
  }catch(e){/* private mode, a full quota — not worth failing a save over */}
}

/* Cleared on every auth transition, by resetAccountState(). */
function resetHomePlace(){ _homePlace=null;_homeColumns=null; }

async function loadHomePlace(){
  /* The device's copy first, so the shortcut and the search bias are
     available without waiting on a round trip. */
  _homePlace=readHomeLocal();
  if(curPage==='me') renderMeHome();
  if(!currentUser) return;

  const{data,error}=await sb.from('Users')
    .select('home_location,home_lat,home_lng').eq('id',currentUser.id).maybeSingle();
  if(error){
    _homeColumns=false;
    console.info('[home] Users has no home_* columns — Home is stored on this device only. Run supabase/home.sql to sync it.');
    return;
  }
  _homeColumns=true;
  if(data&&data.home_location){
    _homePlace={location:data.home_location,lat:data.home_lat,lng:data.home_lng};
    writeHomeLocal(_homePlace);
    if(curPage==='me') renderMeHome();
  } else if(_homePlace){
    /* Set on this device before the columns existed. Push it up. */
    saveHomePlace(_homePlace);
  }
}

async function saveHomePlace(place){
  _homePlace=place&&place.location?place:null;
  writeHomeLocal(_homePlace);
  if(curPage==='me') renderMeHome();
  if(!currentUser||_homeColumns===false) return;
  const{error}=await sb.from('Users').update({
    home_location:_homePlace?_homePlace.location:null,
    home_lat:_homePlace?_homePlace.lat:null,
    home_lng:_homePlace?_homePlace.lng:null,
  }).eq('id',currentUser.id);
  if(error){
    _homeColumns=false;
    console.info('[home] could not save Home to the server:',error.message);
  }
}

/* ==============================================================
   MOVING HOUSE

   Change your home address and every activity whose location IS home
   moves with it. "Book a plumber", "clear the gutters", "finish the
   garage" are all at home rather than at an address, and re-pointing
   them one at a time after a move is exactly the chore nobody does —
   so they sit on the map at a house somebody else lives in.

   WHICH ACTIVITIES: the ones carrying `location_is_home`, set when
   their location was chosen with the Home shortcut. NOT the ones whose
   location text happens to equal the old address. See "THIS ACTIVITY
   IS AT HOME" in api.js for why that distinction is the whole design —
   text-matching would drag an activity that is genuinely in your old
   home town along with the ones that meant *home*, and say nothing.

   It is one dbUpdate against `location_is_home`, so it costs a single
   round trip however many rows match, and applyOp() patches the cache
   and the on-disk snapshot from the same match — no refetch.

   The user is TOLD, in a toast naming the count. This rewrites rows
   they are not looking at, which nothing else in this app does
   silently; the toast is what keeps it from being a silent write, and
   setting the old address back reverses it.
   ============================================================== */
async function updateHomeActivities(place){
  if(!homeFlagReady()||!place||!place.location) return 0;

  /* Count first, so the toast can say how many and so nothing is
     written when the answer is none. */
  const{data,error}=await sb.from('Activities')
    .select('id,location').eq('location_is_home',true);
  if(error||!data||!data.length) return 0;

  /* Already correct — a Home edited for spelling, or re-saved
     unchanged. Nothing to write and nothing to announce. */
  const stale=data.filter(r=>r.location!==place.location);
  if(!stale.length) return 0;

  const{error:upErr}=await dbUpdate('Activities',{
    location:place.location,
    location_lat:place.lat==null?null:place.lat,
    location_lng:place.lng==null?null:place.lng,
  },{location_is_home:true});
  if(upErr){
    console.warn('updateHomeActivities:',upErr);
    return 0;
  }
  return stale.length;
}

/* Removing Home severs the link rather than moving anything. The
   activities keep the location they have — they are still at that
   place — but they stop following a *future* home address, which the
   user has just said they do not have. Without this, setting a new
   home months later would move rows nobody remembers flagging. */
async function clearHomeActivityFlags(){
  if(!homeFlagReady()) return;
  const{data}=await sb.from('Activities').select('id').eq('location_is_home',true);
  if(!data||!data.length) return;
  await dbUpdate('Activities',{location_is_home:false},{location_is_home:true});
}

function renderMeHome(){
  const row=$('meHomeRow');
  if(!row)return;
}

function openHomeSheet(){
  const input=$('homeLoc');
  input.value=_homePlace&&_homePlace.location?_homePlace.location:'';
  $('homeLocLat').value=_homePlace&&_homePlace.lat!=null?_homePlace.lat:'';
  $('homeLocLng').value=_homePlace&&_homePlace.lng!=null?_homePlace.lng:'';
  /* The stored value is resolved by construction, so mark it as such —
     otherwise opening the sheet and saving would re-geocode it. */
  if(input.value) locGeoMark(input); else delete input.dataset.geoFor;
  $('homeClearBtn').style.display=_homePlace?'':'none';
  $('homeError').textContent='';
  openModal('homeSheet');
}

async function saveHomeSheet(){
  const input=$('homeLoc');
  const err=$('homeError');
  err.textContent='';
  if(!input.value.trim()){ await saveHomePlace(null); closeModal('homeSheet'); return; }

  const btn=$('homeSaveBtn');
  btn.disabled=true;
  const res=await resolveLocationField('homeLoc');
  btn.disabled=false;
  if(!res.ok){
    err.textContent='We couldn’t find that place. Try picking one from the list.';
    shakeEl(input);
    return;
  }
  const place={location:input.value.trim(),
               lat:parseFloat($('homeLocLat').value),
               lng:parseFloat($('homeLocLng').value)};
  await saveHomePlace(place);

  /* Everything set to Home moves with it. See MOVING HOUSE. */
  btn.disabled=true;
  const moved=await updateHomeActivities(place);
  btn.disabled=false;

  closeModal('homeSheet');
  showToast(moved
    ? `Home saved — moved ${moved} activit${moved===1?'y':'ies'}`
    : 'Home saved');
  /* Those rows are on screen behind this sheet. */
  if(moved) refreshAfterChange();
}

async function clearHomePlace(){
  await clearHomeActivityFlags();
  await saveHomePlace(null);
  closeModal('homeSheet');
}

/* Notification row in the You tab: reflects the real permission state
   rather than pretending it is a toggle we control. */
function renderMeNotifications(){
  const row=$('meNotifyRow');
  if(!row)return;
  if(!remindersReady()){row.style.display='none';return;}
  row.style.display='';
  const state=notificationState();
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

/* ==============================================================
   DELETING THE ACCOUNT

   Every other destructive action in the app is one action sheet, and
   that is right for them: deleting a list costs you a list, and you
   still have the app. This one ends the account, takes every list,
   activity, photo and completion with it, and there is no undo and no
   support channel to ask for it back — so it is the one place the app
   makes you type something. An action sheet is dismissed by a stray
   tap on the scrim, which is not a bar this should clear.

   The sheet is explicit about the two things people get wrong:

   - **Lists you own that you have shared with other people are
     deleted too**, for them as well. There is nobody to hand ownership
     to without asking, and the alternative — silently keeping a dead
     account's list alive — is worse.
   - **Lists you joined are only left.** They are not yours to destroy
     and the other members keep them intact.

   The erase itself is supabase/functions/delete-account, because
   removing the auth user needs the service_role key. Without that
   function deployed this reports the failure rather than half-doing
   it — the local sign-out only happens after the server says it is
   done.
   ============================================================== */
const DELETE_PHRASE='DELETE';

async function openDeleteAccount(){
  const lists=await fetchCollections();
  const owned=lists.filter(l=>ownsCollection(l));
  const joined=lists.length-owned.length;
  const acts=(await fetchAllActivities(lists)).filter(a=>
    owned.some(l=>a.listIds.includes(l.id)));

  const bits=[];
  if(owned.length) bits.push(`${owned.length} list${owned.length===1?'':'s'}`);
  if(acts.length)  bits.push(`${acts.length} activit${acts.length===1?'y':'ies'}`);

  $('delAcctSummary').innerHTML=
    `<p>This permanently deletes your account${bits.length?' and its '+bits.join(' and '):''},
        including every photo, note and completion. It cannot be undone.</p>`+
    (joined?`<p>${joined} list${joined===1?'':'s'} shared with you
        ${joined===1?'is':'are'} only left, not deleted — the other members keep
        ${joined===1?'it':'them'}.</p>`:'')+
    `<p><strong>Any list you own and have shared is deleted for everyone on it.</strong></p>`;

  $('delAcctConfirm').value='';
  onDeleteAccountInput();
  $('delAcctError').textContent='';
  openModal('delAcctSheet');
}

/* The button stays disabled until the word is right, so the tap that
   destroys the account cannot be the same reflex tap that opened the
   sheet. */
function onDeleteAccountInput(){
  const ok=$('delAcctConfirm').value.trim().toUpperCase()===DELETE_PHRASE;
  $('delAcctBtn').disabled=!ok;
}

async function deleteAccount(){
  if($('delAcctConfirm').value.trim().toUpperCase()!==DELETE_PHRASE) return;
  if(!navigator.onLine){
    $('delAcctError').textContent='You need to be online to delete your account.';
    return;
  }
  const btn=$('delAcctBtn');
  btn.disabled=true;btn.textContent='Deleting…';
  $('delAcctError').textContent='';
  try{
    const{data,error}=await sb.functions.invoke('delete-account',{body:{}});
    if(error) throw error;
    if(data&&data.error) throw new Error(data.error);

    /* Only now. Signing out first would leave no session to authorise
       the call, and clearing the device before the server has agreed
       would look like success after a failure. */
    closeModal('delAcctSheet');
    /* The session is already gone server-side, so this is about the
       device: it drops the caches, the on-disk snapshot and the push
       registration, and lands on the sign-in screen. */
    await handleSignOut();
    showToast('Your account has been deleted');
  }catch(err){
    console.error('deleteAccount:',err);
    $('delAcctError').textContent=
      (err&&err.message)||'Couldn’t delete your account. Nothing was changed.';
  }finally{
    btn.textContent='Delete My Account';
    onDeleteAccountInput();
  }
}
