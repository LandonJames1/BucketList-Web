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
           ${icon('link','ic-sm')}Copy link &amp; code</button>
         ${navigator.share?`<button class="btn btn-tinted btn-block" onclick="sendInviteLink()">
           ${icon('share','ic-sm')}Send it</button>`:''}
         <!-- The same invite, as something that can be typed. A link
              has to survive whatever app it is opened in; a code does
              not. Both go into the message either button produces —
              see inviteMessage(). -->
         <div class="shr-code-head">The code, on its own</div>
         <button class="shr-code" onclick="copyInviteCode()"
                 aria-label="Copy the invite code">${esc(_shareInvite)}</button>
         <button class="btn btn-tinted btn-block" onclick="copyInviteCode()">
           ${icon('link','ic-sm')}Copy just the code</button>
         <p class="shr-note">Paste it into its own message. They go to
           Lists &rarr; Join a List and enter it.</p>
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

/* What actually gets pasted into a message. The link and the code, the
   code on its own line so it can be selected without the URL coming
   with it — the link path is the convenient one and the code is the one
   that always works, so both travel together rather than the recipient
   having to be sent a second message when the first one fails. */
function inviteMessage(listName){
  return (listName?`Join my “${listName}” list on ${APP_NAME}:`:`Join my list on ${APP_NAME}:`)+
    `\n${inviteUrl(_shareInvite)}`+
    `\n\nOr open ${APP_NAME} → Lists → Join a List and enter this code:`+
    `\n${_shareInvite}`;
}

async function copyInviteLink(){
  const l=await fetchCollection(_shareListId);
  try{
    await navigator.clipboard.writeText(inviteMessage(l&&l.name));
    showToast('Link and code copied');
  }catch(e){
    /* Clipboard access is refused in plenty of contexts; the link is
       on screen either way, so this is a convenience not the
       mechanism — same call as copyShareTargetUrl(). */
    showToast('Select the link above to copy it');
  }
}

async function copyInviteCode(){
  try{
    await navigator.clipboard.writeText(_shareInvite);
    showToast('Code copied');
  }catch(e){
    showToast('Select the code above to copy it');
  }
}

/* The OS share sheet, where there is one. This is the natural way to
   hand a link to someone on a phone, and it is the one place in the
   app where the platform's own sheet beats anything we could draw. */
async function sendInviteLink(){
  if(!navigator.share) return copyInviteLink();
  const l=await fetchCollection(_shareListId);
  try{
    /* No `url:` field. Given one, most share targets send the URL and
       drop the text — which is exactly the half that fails, and the
       code would go with it. Putting the link inside the text keeps
       both in the message. See the JOINING BY CODE section. */
    await navigator.share({
      title:l?l.name:APP_NAME,
      text:inviteMessage(l&&l.name),
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
    pendingJoin=bootReadLong(JOIN_STASH)||null;
    return;
  }
  pendingJoin=code;
  /* Held where a reload cannot destroy it — and, unlike a shared link,
     where closing the tab cannot destroy it either. See bootKeepLong()
     in js/utils.js: the recipient of an invite is the one person
     guaranteed to have to sign in first, and leaving the tab to go and
     find a password is the single most likely thing they do next. */
  bootKeepLong(JOIN_STASH,code);
  /* readSharedInput() may have stripped this already; doing it twice
     is harmless and neither can be made to depend on the other. */
  history.replaceState(null,'',location.pathname);
}

/* ==============================================================
   AN INVITE THAT SURVIVES CREATING AN ACCOUNT

   Every other capture in this file is client-side — a global, the URL,
   a localStorage shelf — and all of them are bounded by one device.
   That is enough for a recipient who already has an account: they sign
   in on the device the link opened on and the code is still there.

   It is not enough for the case sharing exists for, which is handing
   the app to somebody who has never seen it. They have to sign up,
   this project confirms email addresses, and the confirmation link
   gets opened wherever their mail is — usually a different phone from
   the one the invite landed on. There the shelf is empty, and the
   invite is gone with nothing on screen to say so.

   Carrying the code through on the auth user's metadata was built and
   reverted: too many silent client-side links in one chain. So the
   intent goes to the SERVER before signUp() is called — "whoever signs
   up with this address means to join this list" — and is redeemed by
   whatever device eventually signs in. See section 5 of
   supabase/sharing.sql for the table, the two RPCs and what they
   expose.

   Both halves fail soft. An older project that has not had section 5
   run against it gets an error from the RPC, logs one line, and
   behaves exactly as it did before.
   ============================================================== */

/* Called from handleAuth(), before either signUp() or sign-in, with
   the address being typed into the form. */
async function claimInviteForEmail(code,email){
  if(!code||!email||!navigator.onLine) return false;
  try{
    const{data,error}=await sb.rpc('claim_invite',{invite_code:code,claim_email:email});
    if(error){
      console.info('[sharing] claim_invite unavailable — an invite will not survive '+
        'a sign-up on another device. Re-run supabase/sharing.sql.',error.message);
      return false;
    }
    if(!data||!data.ok){ console.info('[sharing] claim_invite refused:',data&&data.error); return false; }
    console.log('[join] invite claimed for',email);
    return true;
  }catch(e){
    console.info('[sharing] claim_invite failed:',e);
    return false;
  }
}

/* The other end, from showApp(). Joins anything the server was holding
   for this address and says so — a list that silently appeared is
   barely better than one that never did.

   Deliberately not called on every launch: inviteSweepDue() in
   js/auth.js limits it to a real sign-in and to accounts young enough
   for an invite to still be in flight. */
async function claimInvitesForMe(){
  if(!currentUser||!navigator.onLine) return;
  /* Same reason as handlePendingJoin(): redeeming a claim inserts a
     member row, which a deleted account cannot own. */
  if(!await ensureSessionLive()) return;
  if(!await probeSharing()) return;

  let res;
  try{ res=await sb.rpc('claim_invites_for_me'); }
  catch(e){ console.info('[sharing] claim_invites_for_me failed:',e); return; }
  if(res.error){
    console.info('[sharing] claim_invites_for_me unavailable — re-run '+
      'supabase/sharing.sql to close the sign-up path.',res.error.message);
    return;
  }
  const joined=(res.data&&res.data.joined)||[];
  if(!joined.length) return;

  /* Same reasoning as acceptJoin(): whole collections just became
     visible, so nothing is patched — the snapshot is definitely
     missing rows it should have. */
  invalidateAll();
  invalidateSharedIds();
  await snapshotClear();
  await revalidate();
  console.log('[join] redeemed',joined.length,'claimed invite(s)');
  nav('detail',joined[0].collection_id);
  showToast(joined.length===1
    ?`Joined “${joined[0].name}”`
    :`Joined ${joined.length} shared lists`);
}

/* The sign-in screen's half of the same capture.

   Someone who taps an invite link and has never opened the app before
   is shown a login form, which says nothing about the invite. They
   sign in, and if anything downstream then fails they have no way to
   tell whether the link ever carried anything — which is exactly how
   this reads when it goes wrong: "the link just opens the app". So
   the invite is acknowledged on the screen that is holding it up.

   And then named, if the network will say what it is. peek_invite is
   granted to anon precisely so this can run before there is an
   account: "Sam shared Japan with you" is a reason to create one,
   where "you have been invited to a shared list" is a form to fill in. */
let _authInviteSeq=0;
function updateAuthInviteNotice(){
  const el=$('authInvite');
  if(!el) return;
  /* showAuth() can run more than once — a lapsed session, a failed
     confirmation — so a peek that answers late must not repaint a
     notice that has since been cleared or replaced. */
  const seq=++_authInviteSeq;
  const code=pendingJoin;
  if(!code){ el.style.display='none'; el.innerHTML=''; return; }

  const line='Create an account or sign in — the list will be waiting either way.';
  el.innerHTML=`<strong>You&rsquo;ve been invited to a shared list.</strong>${line}`;
  el.style.display='block';
  if(!navigator.onLine) return;

  sb.rpc('peek_invite',{invite_code:code}).then(({data,error})=>{
    if(seq!==_authInviteSeq||pendingJoin!==code) return;
    if(error||!data||!data.ok) return;
    el.innerHTML=`<strong>${esc(data.owner)} shared &ldquo;${esc(data.name)}&rdquo; with you.</strong>${line}`;
  }).catch(()=>{});
}

/* Once they have gone off to their inbox, the promise changes: there
   is nothing left for them to do here, and the thing they cannot
   otherwise know is that the invite is no longer riding on this
   browser. It isn't — claimInviteForEmail() put it on the server. */
function authInviteWaitingNotice(){
  const el=$('authInvite');
  if(!el||!(pendingJoin||bootReadLong(JOIN_STASH))) return;
  el.innerHTML=`<strong>Your invite is saved.</strong>
    Open the confirmation link on any device and the shared list will be
    there when you land.`;
  el.style.display='block';
}

/* Called from showApp() once there is a signed-in user to join as. */
async function handlePendingJoin(){
  if(!pendingJoin) return;

  /* Before the code is taken out of the global, and before anything is
     shown: a session restored from disk may belong to an account that
     has since been deleted, and this is the path where that surfaced.
     peek_invite would have succeeded — the JWT is still signed, and it
     is granted to anon anyway — so the sheet would open, the invite
     would be consumed, and only join_collection() would fail, on a
     foreign key onto auth.users, reading as "that invite link isn't
     valid" for a link that was perfectly good.

     A failure to reach the server is not an answer and returns true, so
     this cannot strand an invite on a bad connection. When it does come
     back false the auth screen is already up, holding the invite. */
  if(!await ensureSessionLive()) return;

  const code=pendingJoin;
  pendingJoin=null;

  /* NOT dropped from the shelf yet.

     It used to be dropped right here, one line after being read, and
     three of the paths below can fail without the user ever having
     had the chance to join — the probe says sharing is off, the
     device is offline, the invite cannot be read. Consuming the code
     before any of them meant a failure destroyed the invite for good:
     the link had already stripped itself out of the URL, so there was
     nothing left to retry with and no way to get back to it. The
     recipient's only recourse was to ask for a whole new link, which
     is exactly the failure this reads as from the outside.

     So it is consumed once the invite has actually been read and the
     sheet is showing it. That still gives the property the early drop
     was there for — a reload while the sheet is open finds no code
     and cannot re-run the join — and it costs nothing, because by
     that point _joinCode is holding it in memory. */
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
    showToast('Joining a list needs a connection — the invite is saved');
    return;
  }

  $('joinBody').innerHTML='<div class="imp-status"><div class="spinner"></div><p>Reading the invite…</p></div>';
  openModal('joinSheet');

  const{data,error}=await sb.rpc('peek_invite',{invite_code:code});
  if(error||!data||!data.ok){
    /* A code that cannot be read is not going to become readable, so
       this one IS consumed — leaving it would re-open the same error
       sheet on every launch. */
    bootDropLong(JOIN_STASH);
    console.error('peek_invite:',error||data);
    renderJoinError((data&&data.error)||'not_found');
    return;
  }
  bootDropLong(JOIN_STASH);
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
    <button class="btn btn-tinted btn-block" onclick="openJoinByCode()">Enter a code instead</button>
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

/* ==============================================================
   JOINING BY CODE — the floor tier

   Every other way in depends on a link surviving a journey the app
   does not control: a messaging app that may open it in its own
   in-app browser, iOS handing it to Safari rather than to the
   installed PWA (there is no API to ask for the PWA — Universal Links
   need a native app, and a manifest scope is only a hint), a sign-in
   detour, a discarded tab. Each of those is individually survivable
   and the app now survives them, but the list has no end, and the
   recipient is the person least equipped to debug any of it.

   So an invite is also just a code, typed into the app you are
   already standing in. Nothing can eat it. This is the same shape as
   the reminder delivery tiers and the four ways a link gets shared
   in: the reliable floor exists so that the convenient path failing
   is an annoyance rather than the feature not existing.

   It takes a pasted link as readily as a bare code, because what
   people have in their clipboard is whatever they were sent.
   ============================================================== */
function parseInviteCode(text){
  const raw=(text||'').trim();
  if(!raw) return '';
  /* A whole invite URL, however it has been mangled — the code is the
     one thing in it we can identify without parsing the rest. */
  const inUrl=raw.match(/[?&#]join=([^&#\s]+)/i);
  if(inUrl){
    const c=decodeURIComponent(inUrl[1]).toLowerCase().replace(/[^a-z0-9]/g,'');
    if(c.length===INVITE_LEN) return c;
  }
  /* Strip anything that cannot be in the alphabet rather than
     rejecting it: a code read aloud and retyped picks up spaces, and
     one pasted out of a chat app picks up invisible characters. */
  const cleaned=raw.toLowerCase().replace(/[^a-z0-9]/g,'');
  if(cleaned.length===INVITE_LEN) return cleaned;

  /* A whole message pasted in, with no link in it to find the code by.
     iOS will not let you select part of a message bubble — it copies
     the entire thing — so "paste what they sent you" has to be a
     working instruction, not a best case.

     Every word is checked against the invite alphabet, which excludes
     i, l, o and 0/1 precisely so codes do not look like words. An
     18-character run drawn only from it is not something ordinary
     prose produces. */
  const words=raw.toLowerCase().match(/[a-z0-9]+/g)||[];
  for(const w of words){
    if(w.length===INVITE_LEN&&[...w].every(ch=>INVITE_ALPHABET.includes(ch))) return w;
  }
  return '';
}

function openJoinByCode(){
  closeModal('joinSheet');
  $('joinCodeInput').value='';
  $('joinCodeError').textContent='';
  openModal('joinCodeSheet');
  /* Not focused on open: the sheet is still sliding in, and a field
     focused mid-animation is what ensurePickerRoom() has to defend
     against elsewhere. */
  setTimeout(()=>{const el=$('joinCodeInput');if(el)el.focus();},350);
}

async function submitJoinCode(){
  const code=parseInviteCode($('joinCodeInput').value);
  if(!code){
    $('joinCodeError').textContent='That doesn’t look like an invite code. Paste the whole link if it’s easier.';
    shakeEl($('joinCodeInput'));
    return;
  }
  if(!navigator.onLine){
    $('joinCodeError').textContent='Joining a list needs a connection.';
    return;
  }
  closeModal('joinCodeSheet');
  /* Straight back onto the ordinary invite path, so a code and a link
     land on the same sheet and cannot disagree about what joining
     looks like. */
  pendingJoin=code;
  await handlePendingJoin();
}
