/* ==============================================================
   SHARED LISTS — more than one person adding to a collection.

   A trip, a restaurant list, a couple's someday list: the cases
   people actually keep are rarely one person's alone. What makes it
   work here is that a shared collection is an ordinary collection —
   it appears on the Lists tab, its activities are on Home, on the
   map, in search — so nothing in the app had to learn a second kind
   of list. The only differences are a badge, a Share entry in the ⋯
   menu, and Leave in place of Delete for a list you do not own.

   ---- Invites, not usernames ----

   Sharing is a link carrying a random code. Inviting by username
   would need a policy letting any signed-in user search the Users
   table, which turns a private table into a directory; a link needs
   nothing known about the other person in advance, works before they
   have signed up, and travels over whatever the two people already
   use to talk. The code is minted here rather than by the database
   so the link exists the instant the sheet opens.

   ---- It degrades, like everything else optional ----

   probeSharing() looks for the collection_members table once at
   sign-in, exactly as probeStorage() looks for the media bucket and
   probeRemindColumn() for remind_at. Without it every sharing
   affordance is hidden and the app is single-user, unchanged. Run
   supabase/sharing.sql to turn it on.

   ---- Who can do what ----

   Owner: everything, including deleting the list and revoking links.
   Member: add, complete, edit and delete activities; rename the list;
           leave. Cannot delete the list or re-share it.

   That is enforced by RLS, not here — the checks in this file decide
   which buttons to draw, and a client-side check is not a security
   boundary. See supabase/sharing.sql.

   ---- Offline ----

   Joining and inviting both need the network: an invite has to be
   validated against a table, and queueing "join a list" would mean
   showing a list whose contents cannot be fetched. Activities in an
   already-joined shared list are queued and synced like any other,
   with last-write-wins — see js/offline.js.
   ============================================================== */

/* ==============================================================
   CAPABILITY PROBE
   ============================================================== */
let _sharingReady=null,_sharingProbe=null;

/* Forget the answer so the next sign-in probes again.

   Whether `collection_members` exists is a fact about the schema and
   the same for everyone, so this is not strictly necessary — but
   `_sharedIds` right below it is emphatically per-user, the two are
   reset together by resetAccountState(), and one cheap query per
   sign-in is not worth the risk of someone later assuming this probe
   survives an account change when the ids beside it must not. */
function resetSharingProbe(){ _sharingReady=null;_sharingProbe=null; }

function probeSharing(){
  if(_sharingReady!==null) return Promise.resolve(_sharingReady);
  /* showApp() and handlePendingJoin() can both reach this in the same
     tick — an invite opened on a cold start does exactly that — so the
     in-flight promise is shared rather than probing twice. */
  if(_sharingProbe) return _sharingProbe;

  _sharingProbe=(async()=>{
    try{
      const{error}=await sb.from('collection_members').select('collection_id').limit(1);
      _sharingReady=!error;
      if(error) console.info('[sharing] no collection_members table — shared lists are off. '+
        'Run supabase/sharing.sql to enable them.');
    }catch(e){ _sharingReady=false; }
    _sharingProbe=null;

    /* This probe runs in parallel with the first render, so
       fetchCollections() may already have answered — with
       sharingReady() still false, which means it filtered to owned
       lists and cached that. Flipping the answer without dropping the
       cache would hide every joined list until the next reload.

       But only *that* case needs the refetch, and it used to fire
       unconditionally: on a cold launch the app now paints from the
       disk snapshot, whose scope is already correct, and revalidate()
       refreshes behind it — so invalidating here as well meant a
       second full fetch of both tables on every single launch.
       collectionsScope() is what tells the two apart. */
    if(_sharingReady&&collectionsScope()===false){
      invalidateAll();
      if(currentUser) refreshAfterChange();
    }
    return _sharingReady;
  })();
  return _sharingProbe;
}
function sharingReady(){ return _sharingReady===true; }

/* Whether the signed-in user owns a collection. Anything they can see
   but do not own is one they joined. */
function ownsCollection(l){
  return !!(l&&currentUser&&(!l.ownerId||l.ownerId===currentUser.id));
}
function isSharedWithMe(l){
  return sharingReady()&&!!l&&!!l.ownerId&&!!currentUser&&l.ownerId!==currentUser.id;
}

/* ==============================================================
   WHICH LISTS HAVE SOMEONE ELSE IN THEM

   `ownerId` alone answers "did someone share this WITH me", which is
   only half of it — a list you own and have invited someone into is
   just as shared, and the Lists tab has to say so on both.

   One query answers both directions at once, because the RLS policy
   on collection_members returns your own membership rows plus every
   row for a collection you own. Cached for the session and dropped
   whenever membership can have changed (joining, leaving, removing
   someone), so the badge cannot go stale on the screen that shows it.
   ============================================================== */
let _sharedIds=null,_sharedIdsPromise=null;

function invalidateSharedIds(){ _sharedIds=null;_sharedIdsPromise=null; }

async function sharedCollectionIds(){
  if(!sharingReady()||!currentUser) return new Set();
  if(_sharedIds) return _sharedIds;
  if(_sharedIdsPromise) return _sharedIdsPromise;

  _sharedIdsPromise=(async()=>{
    /* Offline this is unanswerable, and an empty set simply means no
       badge — never a wrong one. */
    if(!navigator.onLine){ _sharedIdsPromise=null; return new Set(); }
    const{data,error}=await sb.from('collection_members').select('collection_id');
    _sharedIdsPromise=null;
    if(error){ console.warn('sharedCollectionIds:',error); return new Set(); }
    _sharedIds=new Set(data.map(r=>r.collection_id));
    return _sharedIds;
  })();
  return _sharedIdsPromise;
}

/* ==============================================================
   INVITE CODES

   URL-safe alphabet, no look-alike characters — these get read aloud
   and retyped often enough for 0/O and 1/l to matter. 18 characters
   from a 32-symbol alphabet is 90 bits, which is not guessable.
   ============================================================== */
const INVITE_ALPHABET='abcdefghjkmnpqrstuvwxyz23456789';
const INVITE_LEN=18;

function makeInviteCode(){
  const bytes=new Uint8Array(INVITE_LEN);
  crypto.getRandomValues(bytes);
  let out='';
  for(const b of bytes) out+=INVITE_ALPHABET[b%INVITE_ALPHABET.length];
  return out;
}

function inviteUrl(code){
  return location.origin+location.pathname.replace(/index\.html$/,'')+
         'index.html?join='+encodeURIComponent(code);
}

/* ==============================================================
   THE SHARE SHEET
   ============================================================== */
let _shareListId=null,_shareInvite='',_shareMembers=[];

async function openShareList(){
  if(!sharingReady()){
    showToast('Shared lists need supabase/sharing.sql to be run first');
    return;
  }
  const l=await fetchCollection(curListId);
  if(!l)return;
  _shareListId=l.id;_shareInvite='';_shareMembers=[];

  $('shareListBody').innerHTML='<div class="imp-status"><div class="spinner"></div></div>';
  openModal('shareListSheet');

  if(!navigator.onLine){
    $('shareListBody').innerHTML=`<div class="imp-status">
      <p>Sharing needs a connection — an invite has to be created on the server.</p></div>`;
    return;
  }

  /* Reuse a live invite rather than minting one per visit. A list
     with fourteen dead links in it is a list nobody can audit. */
  const{data:invites}=await sb.from('collection_invites')
    .select('code,revoked').eq('collection_id',l.id).eq('revoked',false).limit(1);
  if(invites&&invites.length) _shareInvite=invites[0].code;

  const{data:members}=await sb.from('collection_members')
    .select('user_id,display_name,role,created_at').eq('collection_id',l.id);
  _shareMembers=members||[];

  renderShareList(l);
}

function renderShareList(l){
  const owner=ownsCollection(l);
  const link=_shareInvite?inviteUrl(_shareInvite):'';

  let h=`<p class="shr-lead">${owner
    ? 'Anyone with this link can open &ldquo;'+esc(l.name)+'&rdquo; and add to it.'
    : 'You were invited to &ldquo;'+esc(l.name)+'&rdquo;. Only its owner can invite others.'}</p>`;

  if(owner){
    h+= link
      ? `<div class="shr-url" id="shareListUrl">${esc(link)}</div>
         <button class="btn btn-filled btn-block" onclick="copyInviteLink()">
           ${icon('link','ic-sm')}Copy invite link</button>
         ${navigator.share?`<button class="btn btn-tinted btn-block" onclick="sendInviteLink()">
           ${icon('share','ic-sm')}Send it</button>`:''}
         <button class="btn btn-plain btn-block" onclick="revokeInvite()">Turn the link off</button>`
      : `<p class="shr-note">Sharing is off for this list. Creating a link lets
           anyone who has it join.</p>
         <button class="btn btn-filled btn-block" onclick="createInvite()">
           ${icon('link','ic-sm')}Create an invite link</button>`;
  }

  /* The roster. The owner is not a member row — they are the owner —
     so they are prepended rather than queried for. */
  const people=[{name:owner?'You':'The owner',role:'owner'}]
    .concat(_shareMembers.map(m=>({
      name:(currentUser&&m.user_id===currentUser.id)?'You':(m.display_name||'Someone'),
      role:m.role||'editor',
      userId:m.user_id,
    })));

  h+=`<div class="shr-people-head">${people.length} ${people.length===1?'person':'people'}</div>
    <div class="group">${people.map(p=>`
      <div class="row has-leading">
        <span class="row-leading li-purple shr-avatar">${esc((p.name||'?').trim().charAt(0).toUpperCase())}</span>
        <span class="row-body"><span class="row-title">${esc(p.name)}</span></span>
        <span class="row-trailing"><span class="shr-role">${esc(cap(p.role))}</span>
        ${owner&&p.userId?`<button class="shr-remove" onclick="removeMember('${p.userId}')"
            aria-label="Remove ${esc(p.name)}">${icon('x','ic-xs')}</button>`:''}</span>
      </div>`).join('')}</div>`;

  if(!owner){
    h+=`<div class="sheet-actions">
      <button class="btn btn-destructive btn-block" onclick="confirmLeaveList()">
        ${icon('signout')}Leave this list</button></div>`;
  }

  $('shareListBody').innerHTML=h;
}

async function createInvite(){
  const code=makeInviteCode();
  const{error}=await sb.from('collection_invites').insert({
    code,collection_id:_shareListId,created_by:currentUser.id,role:'editor',
  });
  if(error){
    console.error('createInvite:',error);
    showToast(error.message||'Couldn’t create a link.');
    return;
  }
  _shareInvite=code;
  const l=await fetchCollection(_shareListId);
  renderShareList(l);
  showToast('Link created');
}

async function revokeInvite(){
  showConfirm({
    title:'Turn the link off',
    message:'Anyone who already joined stays. The link stops working for anyone new.',
    confirmLabel:'Turn it off',
    onConfirm:async()=>{
      const{error}=await sb.from('collection_invites')
        .update({revoked:true}).eq('code',_shareInvite);
      if(error){showToast(error.message||'Couldn’t turn it off.');return;}
      _shareInvite='';
      const l=await fetchCollection(_shareListId);
      renderShareList(l);
      showToast('Link turned off');
    },
  });
}

async function copyInviteLink(){
  try{
    await navigator.clipboard.writeText(inviteUrl(_shareInvite));
    showToast('Link copied');
  }catch(e){
    /* Clipboard access is refused in plenty of contexts; the link is
       on screen either way, so this is a convenience not the
       mechanism — same call as copyShareTargetUrl(). */
    showToast('Select the link above to copy it');
  }
}

/* The OS share sheet, where there is one. This is the natural way to
   hand a link to someone on a phone, and it is the one place in the
   app where the platform's own sheet beats anything we could draw. */
async function sendInviteLink(){
  if(!navigator.share) return copyInviteLink();
  const l=await fetchCollection(_shareListId);
  try{
    await navigator.share({
      title:l?l.name:APP_NAME,
      text:l?`Join my “${l.name}” list on ${APP_NAME}`:`Join my list on ${APP_NAME}`,
      url:inviteUrl(_shareInvite),
    });
  }catch(e){ /* the user dismissed the share sheet */ }
}

async function removeMember(userId){
  showConfirm({
    title:'Remove them',
    message:'They lose access to this list. Anything they added stays.',
    confirmLabel:'Remove',
    onConfirm:async()=>{
      const{error}=await sb.from('collection_members').delete()
        .eq('collection_id',_shareListId).eq('user_id',userId);
      if(error){showToast(error.message||'Couldn’t remove them.');return;}
      _shareMembers=_shareMembers.filter(m=>m.user_id!==userId);
      invalidateSharedIds();
      const l=await fetchCollection(_shareListId);
      renderShareList(l);
      showToast('Removed');
    },
  });
}

/* ==============================================================
   LEAVING

   The member's counterpart to deleting. Deliberately a different
   word and a different outcome: nothing is destroyed, the list simply
   stops being yours to see.
   ============================================================== */
function confirmLeaveList(){
  showConfirm({
    title:'Leave this list',
    message:'It disappears from your lists. Nothing in it is deleted, and you can '+
            'rejoin with the link.',
    confirmLabel:'Leave',
    onConfirm:()=>leaveList(curListId),
  });
}

async function leaveList(id){
  if(!navigator.onLine){ showToast('Leaving a list needs a connection'); return; }
  const{error}=await sb.from('collection_members').delete()
    .eq('collection_id',id).eq('user_id',currentUser.id);
  if(error){
    console.error('leaveList:',error);
    showToast(error.message||'Couldn’t leave that list.');
    return;
  }
  closeModal('shareListSheet');
  /* The whole cache goes: the collection and every activity in it are
     no longer visible, and a stale snapshot would keep drawing them. */
  invalidateAll();
  invalidateSharedIds();
  await snapshotClear();
  nav('lists');
  showToast('Left the list');
}

/* ==============================================================
   ACCEPTING AN INVITE

   Read at boot alongside a shared link and for the same reason: the
   link can be opened while signed out, and the sign-in screen must
   not eat it. The query string is stripped immediately so a reload
   cannot re-run the join.
   ============================================================== */
const JOIN_STASH='bl_pending_join';

function readPendingJoin(){
  let params;
  try{ params=new URLSearchParams(location.search); }catch(e){ params=null; }
  const code=((params&&params.get('join'))||'').trim();
  if(!code){
    /* Nothing in the URL, but a previous load of this tab may have
       captured a code and then been reloaded out from under it — most
       likely by the service worker taking control on a first visit.
       See the controllerchange handler in js/pwa.js. */
    pendingJoin=bootRead(JOIN_STASH)||null;
    return;
  }
  pendingJoin=code;
  /* Held where a reload cannot destroy it. The recipient of an invite
     usually has to sign in before there is anyone to join as, and that
     is a long time to keep something in a global. */
  bootKeep(JOIN_STASH,code);
  /* readSharedInput() may have stripped this already; doing it twice
     is harmless and neither can be made to depend on the other. */
  history.replaceState(null,'',location.pathname);
}

/* Called from showApp() once there is a signed-in user to join as. */
async function handlePendingJoin(){
  if(!pendingJoin) return;
  const code=pendingJoin;
  pendingJoin=null;
  /* Consumed. Dropped here rather than in acceptJoin(), so that a
     reload while the sheet is open cannot re-run the join — the same
     property stripping the query string gives. */
  bootDrop(JOIN_STASH);

  if(!sharingReady()){
    /* probeSharing() may not have answered yet — it is fired in the
       same tick. Give it a moment before deciding the feature is off,
       or an invite opened on a cold start is refused on a race. */
    await probeSharing();
  }
  if(!sharingReady()){
    showToast('Shared lists aren’t set up on this project');
    return;
  }
  if(!navigator.onLine){
    showToast('Joining a list needs a connection');
    return;
  }

  $('joinBody').innerHTML='<div class="imp-status"><div class="spinner"></div><p>Reading the invite…</p></div>';
  openModal('joinSheet');

  const{data,error}=await sb.rpc('peek_invite',{invite_code:code});
  if(error||!data||!data.ok){
    renderJoinError((data&&data.error)||'not_found');
    return;
  }
  _joinCode=code;
  $('joinBody').innerHTML=`
    <p class="shr-lead"><strong>${esc(data.owner)}</strong> shared a list with you.</p>
    <div class="join-card">
      <div class="join-name">${esc(data.name)}</div>
      <div class="join-count">${data.count} ${data.count===1?'activity':'activities'}</div>
    </div>
    <p class="shr-note">You&rsquo;ll be able to add to it, tick things off, and see
      everything on it — the same as any of your own lists.</p>
    <div class="sheet-actions">
      <button class="btn btn-filled btn-block" onclick="acceptJoin()">
        ${data.already?'Open the list':'Join the list'}</button>
    </div>`;
}

let _joinCode='';

const JOIN_ERRORS={
  not_found:'That invite link isn’t valid. Ask for a new one.',
  revoked:'That link has been turned off. Ask for a new one.',
  expired:'That link has expired. Ask for a new one.',
  not_signed_in:'Sign in first, then open the link again.',
};

function renderJoinError(code){
  $('joinBody').innerHTML=`<div class="imp-status">
    <p>${esc(JOIN_ERRORS[code]||'That invite couldn’t be opened.')}</p>
    <button class="btn btn-plain btn-block" onclick="closeModal('joinSheet')">Close</button>
  </div>`;
}

async function acceptJoin(){
  const{data,error}=await sb.rpc('join_collection',{invite_code:_joinCode});
  if(error||!data||!data.ok){
    console.error('join_collection:',error||data);
    renderJoinError((data&&data.error)||'not_found');
    return;
  }
  closeModal('joinSheet');
  /* A whole collection just became visible. Everything is refetched
     rather than patched — this is the one moment where the snapshot
     is definitely missing rows it should have. */
  invalidateAll();
  invalidateSharedIds();
  await snapshotClear();
  await revalidate();
  nav('detail',data.collection_id);
  showToast(data.already?'That’s already your list':`Joined “${data.name}”`);
}

function declineJoin(){
  _joinCode='';
  closeModal('joinSheet');
}
