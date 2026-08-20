/* ==============================================================
   MESSAGES — a conversation per shared list, and the hub that
   collects them.

   ---- Only shared lists have a conversation ----

   A list nobody else is in has nobody to talk to. The hub therefore
   shows collections with at least one collection_members row, which
   is the same set sharedCollectionIds() badges on the Lists tab, and
   conversation_list() applies the same rule server-side so the two
   cannot disagree. Nothing creates a conversation: sharing a list is
   what makes one.

   ---- Messages are NOT in the app's two backing queries ----

   Everything else in the app is fetched whole, cached in memory and
   mirrored to IndexedDB, because collections and activities are
   bounded by how much one person curates. Messages are not: they
   grow forever and are read from the tail. Putting them in that
   cache would mean pulling every message in every list on every
   launch.

   So there are two different things here, and they are cached
   differently:

   - **The hub** is one RPC (conversation_list) returning one row per
     shared list — the last message and an unread count. Bounded by
     the number of lists, so it is cached for the session like
     anything else and refreshed on foreground.
   - **A conversation** is fetched when you open it, newest
     CONV_PAGE first, and pages backwards as you scroll up. Nothing
     is held between visits.

   ---- Realtime, and how far it reaches ----

   postgres_changes filters on a single column equality, which is
   exactly a conversation (`collection_id=eq.X`) and cannot express
   "any list I am in". So the live channel is opened for the
   conversation you are looking at and closed when you leave it; the
   hub's unread counts refresh on foreground and after a send. That
   is the same trade the rest of the app already makes — revalidate()
   on foreground — and it avoids a per-user broadcast channel with a
   database trigger behind it.

   ---- It degrades, like everything else optional ----

   probeMessages() looks for the messages table once at sign-in,
   exactly as probeSharing() looks for collection_members. Without
   it the Messages tab is hidden and nothing else changes. Run
   supabase/messages.sql to turn it on.
   ============================================================== */

/* How many messages a conversation loads at a time. */
const CONV_PAGE=40;
/* Messages from the same person inside this window are drawn as one
   run — one name, one timestamp — rather than repeating the header on
   every line. */
const MSG_RUN_MS=5*60*1000;
/* Characters after "@" before the mention list appears. Zero, because
   "@" on its own is a deliberate act: nobody types it by accident in
   the middle of a sentence about a shared list. */
const MENTION_MIN=0;
const MENTION_MAX=6;

/* ==============================================================
   IS THIS AVAILABLE AT ALL?
   ============================================================== */
let _msgReady=null,_msgProbe=null;

/* Whether this project has the messages tables is a fact about the
   schema — identical for every account, and it does not change between
   launches. It was nonetheless being re-learned by a round trip on
   every single one, and the tab is hidden in the markup until it
   answers: the other four tabs paint instantly and Chat arrived
   seconds later, which reads as the bar being broken.

   So the last answer is remembered and applied at paint time. It is a
   hint, not a source of truth — messagesReady() still means "the probe
   said yes", and the probe overwrites this the moment it answers, in
   either direction. The worst case is a tab that shows for a second on
   a project that has since lost the migration. */
const MSG_TAB_KEY='bl_msgtab';
function msgTabRemembered(){
  try{ return localStorage.getItem(MSG_TAB_KEY)==='1'; }catch(e){ return false; }
}
function rememberMsgTab(ok){
  try{ localStorage.setItem(MSG_TAB_KEY,ok?'1':'0'); }catch(e){}
}

/* Reset on every auth transition, for the same reason probeSharing()
   is: the conversation cache beside it is per-account. Whether the
   table exists is a fact about the schema, but keeping the two in one
   place is worth more than re-probing once per sign-in. */
function resetMessagesProbe(){ _msgReady=null;_msgProbe=null; }

function probeMessages(){
  if(_msgReady!==null) return Promise.resolve(_msgReady);
  if(_msgProbe) return _msgProbe;

  _msgProbe=(async()=>{
    try{
      const{error}=await sb.from('messages').select('id').limit(1);
      _msgReady=!error;
      if(error) console.info('[messages] no messages table — the Messages tab is hidden. '+
        'Run supabase/messages.sql to enable it.');
    }catch(e){ _msgReady=false; }
    rememberMsgTab(_msgReady);
    _msgProbe=null;
    /* The tab is painted before this answers, so it has to be told. */
    applyMessagesAvailability();
    if(_msgReady) refreshConversations();
    return _msgReady;
  })();
  return _msgProbe;
}
function messagesReady(){ return _msgReady===true; }

/* The tab is in the markup either way — hiding it here rather than
   building it conditionally keeps paintStaticIcons() and the tab bar
   layout unconditional, and a tab that appears mid-session is far
   less odd than one that shifts the other four sideways. */
function applyMessagesAvailability(){
  const tab=$('tabMessages');
  if(!tab) return;
  /* Before the probe has answered, the remembered answer decides — that
     is the whole point of it. Afterwards only the probe does. */
  const show=_msgReady===null?msgTabRemembered():messagesReady();
  tab.style.display=show?'':'none';
}

/* ==============================================================
   THE HUB CACHE

   One row per shared list. Small and bounded, so it is held for the
   session and refreshed when the app comes back to the foreground —
   the same lifetime the collections cache has.
   ============================================================== */
let _convos=null,_convosPromise=null;

function invalidateConversations(){ _convos=null;_convosPromise=null; }
function cachedConversations(){ return _convos||[]; }

async function fetchConversations(){
  if(!messagesReady()||!currentUser) return [];
  if(_convos) return _convos;
  if(_convosPromise) return _convosPromise;

  _convosPromise=(async()=>{
    /* Unanswerable offline, and an empty hub is better than a wrong
       one — the same call sharedCollectionIds() makes. */
    if(!navigator.onLine){ _convosPromise=null; return []; }
    const{data,error}=await sb.rpc('conversation_list');
    _convosPromise=null;
    if(error){
      console.warn('fetchConversations:',error);
      return [];
    }
    _convos=data||[];
    updateMessagesBadge();
    return _convos;
  })();
  return _convosPromise;
}

/* Drop and refetch. Called on foreground, after sending, and after
   anything that changes membership. */
async function refreshConversations(){
  if(!messagesReady()) return;
  invalidateConversations();
  await fetchConversations();
  updateMessagesBadge();
  if(curPage==='messages') renderMessages();
}

function unreadTotal(){
  return cachedConversations().reduce((n,c)=>n+(c.unread_count||0),0);
}

/* The count on the tab itself. Painted from whatever is cached, so it
   is correct the moment the hub is and never costs a request of its
   own. */
function updateMessagesBadge(){
  const tab=$('tabMessages');
  if(!tab) return;
  let dot=tab.querySelector('.tab-badge');
  const n=unreadTotal();
  setAppIconBadge(n);
  if(!n){ if(dot) dot.remove(); return; }
  if(!dot){
    dot=document.createElement('span');
    dot.className='tab-badge';
    tab.appendChild(dot);
  }
  dot.textContent=n>99?'99+':String(n);
}

/* The same number on the home-screen app icon. iOS honours it only in
   an installed PWA with notification permission granted, and every
   platform ignores it silently otherwise — so it is fire-and-forget.
   The service worker increments its own copy on a push while nothing
   is running; this is the authoritative value and overwrites it. */
function setAppIconBadge(n){
  try{
    if(n>0) navigator.setAppBadge?.(n);
    else navigator.clearAppBadge?.();
  }catch{}
  try{ navigator.serviceWorker?.controller?.postMessage({type:'badge-count',count:n}); }catch{}
}

/* ==============================================================
   THE HUB SCREEN
   ============================================================== */
async function renderMessages(){
  const body=$('messagesBody');
  if(!body) return;

  if(!messagesReady()){
    body.innerHTML=`<div class="empty">${icon('message')}
      <div class="empty-title">Messages aren’t set up</div>
      <div class="empty-sub">Run supabase/messages.sql against this project to turn them on.</div>
    </div>`;
    return;
  }

  /* Paint from cache when there is one — blanking a screen that is
     about to redraw from memory turns an instant render into a flash
     of nothing. Same rule cacheWarm() encodes for the other screens. */
  if(!_convos) body.innerHTML='<div class="conv-loading"><div class="spinner"></div></div>';

  const convos=await fetchConversations();
  if(curPage!=='messages') return;

  if(!convos.length){
    body.innerHTML=`<div class="empty">${icon('message')}
      <div class="empty-title">No conversations yet</div>
      <div class="empty-sub">Share a list with someone and you’ll get a conversation for it — a place to sort out who’s booking what.</div>
      <button class="btn btn-filled" onclick="selectTab('lists')">Go to Lists</button>
    </div>`;
    return;
  }

  body.innerHTML=`<div class="conv-list">${convos.map(convRowHTML).join('')}</div>`;
  updateMessagesBadge();
}

function convRowHTML(c){
  const unread=c.unread_count||0;
  const cover=c.cover_image||'';
  const thumb=cover
    ? `<img class="conv-cover" src="${esc(cover)}" alt="" loading="lazy"/>`
    : `<span class="conv-cover conv-cover-blank">${icon('stack','ic-sm')}</span>`;

  /* Who said what, trimmed to one line. A conversation nobody has
     started says so rather than showing an empty row — an empty
     preview reads as a message that failed to load. */
  let preview,when='';
  if(c.last_at){
    const who=c.last_sender_id&&currentUser&&c.last_sender_id===currentUser.id
      ? 'You'
      : msgSenderLabel(c.last_sender_id,c.last_sender_name);
    const line=(c.last_body||'').trim()||'Shared an activity';
    preview=`<span class="conv-who">${esc(who)}:</span> ${esc(line)}`;
    when=msgWhenShort(c.last_at);
  } else {
    preview='<span class="conv-empty-preview">No messages yet</span>';
  }

  return `<button class="conv-row${unread?' unread':''}" onclick="openConversation('${c.collection_id}')">
    ${thumb}
    <span class="conv-body">
      <span class="conv-top">
        <span class="conv-name">${esc(c.name||'Untitled list')}</span>
        ${when?`<span class="conv-when">${esc(when)}</span>`:''}
      </span>
      <span class="conv-bottom">
        <span class="conv-preview">${preview}</span>
        ${unread?`<span class="conv-unread">${unread>99?'99+':unread}</span>`:''}
      </span>
    </span>
  </button>`;
}

/* ==============================================================
   NAMING A SENDER

   A null sender_id means the account was deleted. The snapshot name
   is kept so the rest of the thread still reads as a conversation
   between people, but the row has to say plainly that they are gone
   — a name with no account behind it that looks like every other
   name is the quiet kind of wrong this app tries not to ship.
   ============================================================== */
function msgSenderGone(m){ return !m.sender_id; }

function msgSenderLabel(senderId,senderName){
  if(!senderId) return senderName?String(senderName):'Deleted account';
  return senderName?String(senderName):'Someone';
}

function msgIsMine(m){ return !!(currentUser&&m.sender_id===currentUser.id); }

function msgInitial(name){
  const s=(name||'?').trim();
  return s?s[0].toUpperCase():'?';
}

/* ==============================================================
   THE FACE BESIDE THE NAME

   A message header already said who wrote it; a photo is what makes
   that readable at a glance rather than word by word, which is the
   whole difference between a list of rows and a conversation.

   Where the photos come from is the awkward part. profiles.sql
   deliberately does not let a signed-in user read anybody else's
   Users row - that would make a private table into a directory of
   every account on the project - so this cannot be a join. It is the
   collection_avatars() RPC from supabase/avatars.sql instead, which
   discloses exactly one field for exactly the people already in this
   conversation. See that file's header.

   Three properties worth keeping:

   - **One RPC per conversation, not one per message.** The map is
     fetched once when the conversation opens and cached for the
     session, keyed by collection. A conversation of forty messages
     costs one request, and paging backwards through the history
     costs none.
   - **It never blocks the messages.** The thread paints from the
     names it already has - sender_name is a snapshot on every row -
     and repaints when the photos land. A face arriving a moment
     after the words is invisible; a conversation that waits on it is
     not.
   - **A miss is silence.** No avatars.sql, no RPC, an error, a person
     who has not set one: the initial disc that was here before is
     drawn instead. Nothing about the thread depends on this
     succeeding.
   ============================================================== */
let _avatars={};        /* collection id -> { userId: url } */

function invalidateAvatars(){ _avatars={}; }

function avatarsFor(cid){ return _avatars[cid]||null; }

async function loadConversationAvatars(cid){
  if(_avatars[cid]) return _avatars[cid];
  if(!navigator.onLine) return null;
  try{
    const{data,error}=await sb.rpc('collection_avatars',{cid});
    if(error) throw error;
    const map={};
    (data||[]).forEach(r=>{ if(r.uid&&r.avatar_url) map[r.uid]=r.avatar_url; });
    _avatars[cid]=map;
    return map;
  }catch(e){
    /* Almost always "function does not exist" - avatars.sql has not
       been run. Said once, at info level, and never again for this
       conversation: the empty map is cached so a project without the
       migration does not pay a failing round trip on every open. */
    console.info('[messages] no profile photos:',e.message||e);
    _avatars[cid]={};
    return _avatars[cid];
  }
}

/* The disc itself. `gone` keeps its grey treatment even when a photo
   is known: a deleted account must not look like every other row, and
   that rule outranks showing the picture. */
function msgAvatarHTML(m,name,gone){
  const map=avatarsFor(curConvId);
  const url=(!gone&&m.sender_id&&map)?map[m.sender_id]:'';
  if(url) return `<span class="msg-avatar has-photo"><img src="${esc(url)}" alt="" loading="lazy"/></span>`;
  return `<span class="msg-avatar${gone?' gone':''}">${esc(msgInitial(name))}</span>`;
}

/* ==============================================================
   TIME

   Two formats: a short stamp for a hub row ("14:02", "Tue", "3 Mar")
   and a clock time inside the thread, with a day separator between
   runs. The full date is never abbreviated to something the reader
   has to decode — see the note in dateInfo().
   ============================================================== */
function msgClock(iso){
  const d=new Date(iso);
  return d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
}
function msgWhenShort(iso){
  const d=new Date(iso),now=new Date();
  const sameDay=d.toDateString()===now.toDateString();
  if(sameDay) return msgClock(iso);
  const days=Math.round((now-d)/86400000);
  if(days<7) return d.toLocaleDateString([],{weekday:'short'});
  return fmtDate(iso.slice(0,10));
}
function msgDayLabel(iso){
  const d=new Date(iso),now=new Date();
  if(d.toDateString()===now.toDateString()) return 'Today';
  const y=new Date(now);y.setDate(y.getDate()-1);
  if(d.toDateString()===y.toDateString()) return 'Yesterday';
  return fmtDate(iso.slice(0,10),d.getFullYear()!==now.getFullYear());
}

/* ==============================================================
   A CONVERSATION
   ============================================================== */
let _convMsgs=[];          /* oldest first, as rendered */
let _convList=null;        /* the collection row */
let _convActs=[];          /* its activities, for the mention picker */
let _convChannel=null;     /* the live subscription */
let _convHasMore=false;
let _convLoading=false;
let _pendingMentions=[];   /* activity ids attached to the message being typed */
/* Of those, the ones whose logs this message should also be filed
   into. Deliberately a separate list and deliberately empty by
   default: mentioning an activity says "this is what we are talking
   about", which is not the same as "write this down on it". The user
   opts in per chip, before sending. */
let _pendingNotes=[];

function openConversation(cid){ nav('conversation',cid); }

/* Everything belonging to the conversation that was open. Called by
   nav() on the way out and by resetMessagesState(). */
function leaveConversation(){
  unsubscribeConversation();
  _convMsgs=[];_convList=null;_convActs=[];
  _convHasMore=false;_convLoading=false;_convMuted=false;
  _pendingMentions=[];_pendingNotes=[];
  closeMentionSuggest();
}

async function renderConversation(){
  const cid=curConvId;
  if(!cid){ nav('messages'); return; }

  const scroll=$('convScroll');
  scroll.innerHTML='<div class="conv-loading"><div class="spinner"></div></div>';
  $('convComposerText').value='';
  autogrowComposer($('convComposerText'));
  _pendingMentions=[];_pendingNotes=[];
  renderPendingMentions();

  _convList=await fetchCollection(cid);
  if(!_convList){ nav('messages'); return; }
  $('navTitle').textContent=_convList.name;

  /* The activities are for the mention picker, and they come out of
     the shared cache — the same read dupeGuard() and Home's composer
     do, so it costs nothing and works offline. */
  _convActs=await fetchActivitiesFor(cid);

  if(!navigator.onLine){
    scroll.innerHTML=`<div class="empty">${icon('message')}
      <div class="empty-title">Offline</div>
      <div class="empty-sub">Messages need a connection. Anything you send will be queued and delivered when you’re back.</div>
    </div>`;
    return;
  }

  /* Started here, not awaited: the words are what the reader came for
     and the faces are decoration on top of them. The repaint below is
     what puts the photos in once they arrive. */
  const avatarsP=loadConversationAvatars(cid);

  const rows=await loadMessages(cid,null);
  if(curPage!=='conversation'||curConvId!==cid) return;

  _convMsgs=rows;
  paintConversation();
  scrollConversationToEnd(true);

  avatarsP.then(map=>{
    if(curPage!=='conversation'||curConvId!==cid) return;
    if(!map||!Object.keys(map).length) return;
    /* Already at the bottom by construction, and paintConversation()
       writes the same markup with the images filled in - so this does
       not move the reader. */
    paintConversation();
    scrollConversationToEnd(true);
  });

  subscribeConversation(cid);
  markConversationRead(cid);
  loadConversationMute(cid);
}

/* One page, newest first from the server, handed back oldest-first
   because that is the order it is drawn in. `before` pages backwards. */
async function loadMessages(cid,before){
  let q=sb.from('messages')
    .select('id,collection_id,sender_id,sender_name,body,activity_ids,created_at,deleted_at')
    .eq('collection_id',cid)
    .is('deleted_at',null)
    .order('created_at',{ascending:false})
    .limit(CONV_PAGE);
  if(before) q=q.lt('created_at',before);

  const{data,error}=await q;
  if(error){
    console.warn('loadMessages:',error);
    _convHasMore=false;
    return [];
  }
  _convHasMore=(data||[]).length===CONV_PAGE;
  return (data||[]).slice().reverse();
}

/* Paging backwards keeps the reader's place: prepending rows moves
   everything down by exactly the height that was added, so the scroll
   offset is corrected by the same amount. Without it, loading older
   messages throws you to a different part of the conversation. */
async function loadOlderMessages(){
  if(_convLoading||!_convHasMore||!_convMsgs.length) return;
  _convLoading=true;
  const scroll=$('convScroll');
  const before=_convMsgs[0].created_at;
  const heightBefore=scroll.scrollHeight,topBefore=scroll.scrollTop;

  const older=await loadMessages(curConvId,before);
  if(older.length){
    _convMsgs=older.concat(_convMsgs);
    paintConversation();
    scroll.scrollTop=topBefore+(scroll.scrollHeight-heightBefore);
  }
  _convLoading=false;
}

function paintConversation(){
  const scroll=$('convScroll');
  if(!scroll) return;

  if(!_convMsgs.length){
    scroll.innerHTML=`<div class="empty">${icon('message')}
      <div class="empty-title">No messages yet</div>
      <div class="empty-sub">This is the conversation for “${esc((_convList&&_convList.name)||'this list')}”. Mention an activity with @ so everyone knows which one you mean.</div>
    </div>`;
    return;
  }

  let h=_convHasMore
    ? `<button class="conv-more" onclick="loadOlderMessages()">Load earlier messages</button>`
    : '';
  let lastDay='',prev=null;

  for(const m of _convMsgs){
    const day=msgDayLabel(m.created_at);
    if(day!==lastDay){
      h+=`<div class="msg-day"><span>${esc(day)}</span></div>`;
      lastDay=day;prev=null;
    }
    h+=msgRowHTML(m,prev);
    prev=m;
  }
  scroll.innerHTML=h;
}

/* A message is drawn as part of a run when the previous one is from
   the same person and close in time — one name and one stamp for the
   run rather than a header on every line. */
function msgRowHTML(m,prev){
  const mine=msgIsMine(m);
  const run=prev&&prev.sender_id===m.sender_id&&
    (new Date(m.created_at)-new Date(prev.created_at))<MSG_RUN_MS;
  const name=msgSenderLabel(m.sender_id,m.sender_name);
  const gone=msgSenderGone(m);

  const chips=(m.activity_ids||[]).map(msgActivityChipHTML).filter(Boolean).join('');
  const body=(m.body||'').trim();

  return `<div class="msg${mine?' mine':''}${run?' run':''}" data-id="${esc(m.id)}">
    ${run?'':`<div class="msg-head">
      ${msgAvatarHTML(m,name,gone)}
      <span class="msg-who">${esc(mine?'You':name)}</span>
      ${gone?'<span class="msg-gone">Deleted account</span>':''}
      <span class="msg-time">${esc(msgClock(m.created_at))}</span>
    </div>`}
    <div class="msg-bubble" onclick="openMessageMenu('${esc(m.id)}')">
      ${body?`<div class="msg-text">${esc(body)}</div>`:''}
      ${chips?`<div class="msg-chips">${chips}</div>`:''}
    </div>
  </div>`;
}

/* An activity referenced by a message. Drawn from the conversation's
   own activity list rather than a lookup, so it is free — and an
   activity that has since been taken out of this list says so instead
   of rendering as a dead tap. That is a real case: the reference is
   permanent, the membership is not. */
function msgActivityChipHTML(id){
  const a=_convActs.find(x=>x.id===id);
  if(!a){
    return `<span class="msg-chip gone">${icon('circle','ic-xs')}<span>No longer in this list</span></span>`;
  }
  return `<button class="msg-chip${a.completed?' done':''}"
      onclick="event.stopPropagation();msgOpenActivity('${esc(a.id)}')">
    ${icon(a.completed?'check-circle':'circle','ic-xs')}<span>${esc(a.name)}</span>
  </button>`;
}

function msgOpenActivity(id){ openActDetail(id); }

/* Scrolling to the newest message. `instant` on first paint, because
   animating from the top of a long conversation to the bottom is a
   visible scroll through somebody else's history. */
function scrollConversationToEnd(instant){
  const scroll=$('convScroll');
  if(!scroll) return;
  requestAnimationFrame(()=>{
    scroll.scrollTo({top:scroll.scrollHeight,behavior:instant?'auto':'smooth'});
  });
}

/* ==============================================================
   SENDING

   Through dbInsert, not sb.from().insert — so a message written in a
   tunnel is queued and replayed like any other write, and the id is
   minted here either way. applyOp() ignores tables it does not cache,
   which is exactly right: messages are not in the snapshot.
   ============================================================== */
async function sendMessage(){
  const input=$('convComposerText');
  const body=input.value.trim();
  const ids=_pendingMentions.slice();
  const noteIds=_pendingNotes.filter(id=>ids.includes(id));
  if(!body&&!ids.length){ shakeEl(input); return; }
  if(!curConvId) return;

  const row={
    collection_id:curConvId,
    sender_id:currentUser.id,
    /* Snapshotted at send time, exactly as collection_members does
       it. The thread stays readable if the account later goes. */
    sender_name:(userProfile&&(userProfile.display_name||userProfile.username))||'Someone',
    body,
    activity_ids:ids,
  };

  input.value='';
  _pendingMentions=[];_pendingNotes=[];
  renderPendingMentions();
  onConvComposerInput();

  const{error,offline,rows}=await dbInsert('messages',row);
  if(error){
    console.error('sendMessage:',error);
    showToast(error.message||'Couldn’t send that.');
    /* Give the text back rather than losing it. */
    input.value=body;
    _pendingMentions=ids;_pendingNotes=noteIds;
    renderPendingMentions();
    onConvComposerInput();
    return;
  }

  /* Drawn immediately from the row we minted. Realtime will echo the
     same id back for anyone else in the list; the guard in
     onRealtimeMessage() stops it being drawn twice here. */
  const sent=rows&&rows[0];
  /* Filed after the message is safely in, and never as part of that
     write: a note that fails must not make a sent message look
     unsent. Same rule the new-activity sheet's note field follows. */
  if(sent&&noteIds.length) fileMessageNotes(sent,noteIds);
  if(sent){
    _convMsgs.push(sent);
    paintConversation();
    scrollConversationToEnd();
  }
  if(offline){
    showToast('Offline — this will send when you’re back');
    return;
  }
  markConversationRead(curConvId);
  invalidateConversations();
  fetchConversations();
  /* Tell everyone else. Deliberately last and deliberately not awaited:
     the message is already saved and on screen, and a push that fails
     must not make a successful send look like a failed one. */
  notifyMessageSent(sent&&sent.id);
}

/* ==============================================================
   NOTIFYING THE REST OF THE LIST

   A message's event is the insert, so the push goes out immediately —
   unlike a reminder, which is a date and therefore needs something to
   wake up and check the calendar. See the header of
   supabase/functions/send-message-push.

   Called from the client rather than from a database trigger: no
   pg_net, no trigger to keep in step with the table, and the caller's
   JWT is right here so the function can verify who is sending. The
   function trusts the id and NOTHING else — it reads the body, the
   sender and the audience back with the service role, so a caller
   cannot push arbitrary text to arbitrary people.

   Every failure here is swallowed to a console line. The message is
   saved; not notifying is a degradation, not an error the sender
   should be shown.
   ============================================================== */
async function notifyMessageSent(messageId){
  if(!messageId||!navigator.onLine) return;
  try{
    const{data,error}=await sb.functions.invoke('send-message-push',{body:{messageId}});
    if(error) console.info('[messages] push not sent:',error.message||error);
    /* A 200 can still mean nobody was told — no registered devices,
       everyone muted, nobody else in the list. Logged because that is
       otherwise indistinguishable from a push that went out. */
    else console.info('[messages] push:',data);
  }catch(e){
    /* Not deployed, or unreachable. The conversation works regardless —
       this is the same degradation everything optional here has. */
    console.info('[messages] send-message-push unavailable:',e&&e.message);
  }
}

function onConvComposerKey(e){
  if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); return; }
  /* Escape closes the mention list without clearing what was typed. */
  if(e.key==='Escape'&&$('convMention').classList.contains('open')){
    e.preventDefault();closeMentionSuggest();
  }
}

/* iMessage's composer: one line at rest, growing a line at a time, and
   only scrolling once it hits the cap. The overflow has to be toggled
   rather than left on auto, or the box shows a scrollbar from the first
   character. */
function autogrowComposer(input){
  if(!input) return;
  input.style.height='auto';
  const h=Math.min(input.scrollHeight,120);
  input.style.height=h+'px';
  input.style.overflowY=input.scrollHeight>120?'auto':'hidden';
}

function onConvComposerInput(){
  const input=$('convComposerText');
  const wrap=$('convComposer');
  if(!input||!wrap) return;
  wrap.classList.toggle('has-text',!!input.value.trim()||!!_pendingMentions.length);
  /* Grow with the text up to a cap, then scroll — a composer that
     eats the conversation is worse than one that scrolls. */
  autogrowComposer(input);
  updateMentionSuggest();
}

/* ==============================================================
   MENTIONING AN ACTIVITY

   The point of the whole feature: "which one are we talking about?"
   answered in the message rather than in the next three messages.

   Typing "@" opens a list of this collection's activities, matched
   with the same fuzzy search Home's composer uses — searchActivities()
   against the in-memory cache, synchronous and free. Picking one
   inserts its name as ordinary text so the sentence still reads, and
   attaches its id to the message. The id is what is stored and what
   the chip is drawn from; the text is just the sentence.

   Scoped to THIS collection deliberately. An activity in a list some
   of the readers cannot see would render as "no longer in this list"
   for them, which is a worse answer than not offering it — and the
   fix when you want to talk about something else is to add it to this
   list, which is one action away.
   ============================================================== */
let _mentionAt=-1,_mentionHits=[];

function mentionQuery(){
  const input=$('convComposerText');
  if(!input) return null;
  const upto=input.value.slice(0,input.selectionStart);
  const at=upto.lastIndexOf('@');
  if(at<0) return null;
  /* "@" has to start a word, or an email address opens the picker. */
  if(at>0&&!/\s/.test(upto[at-1])) return null;
  const q=upto.slice(at+1);
  /* A space ends it: the mention is one run of characters, and the
     picker hanging around for the rest of the sentence is noise. */
  if(/\s/.test(q)) return null;
  return{at,q};
}

function updateMentionSuggest(){
  const box=$('convMention');
  if(!box) return;
  const m=mentionQuery();
  if(!m||m.q.length<MENTION_MIN) return closeMentionSuggest();

  const q=m.q.trim();
  /* No query yet: offer what is most likely to be talked about —
     what is still to do, most recently added. */
  let hits;
  if(!q){
    hits=_convActs.filter(a=>!a.completed)
      .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))
      .slice(0,MENTION_MAX);
  } else {
    hits=searchActivities(q,_convActs,[]).slice(0,MENTION_MAX).map(h=>h.a);
  }
  if(!hits.length) return closeMentionSuggest();

  _mentionAt=m.at;_mentionHits=hits;
  box.innerHTML=`<div class="conv-mention-head">Mention an activity</div>`+
    hits.map((a,i)=>`<button class="conv-mention-item${a.completed?' done':''}"
        onclick="pickMention(${i})">
      ${icon(a.completed?'check-circle':'circle')}
      <span class="conv-mention-body">
        <span class="conv-mention-name">${searchMark(a.name,q)}</span>
        ${a.location?`<span class="conv-mention-sub">${esc(a.location)}</span>`:''}
      </span>
    </button>`).join('');
  box.classList.add('open');
}

function closeMentionSuggest(){
  const box=$('convMention');
  if(box){ box.classList.remove('open'); box.innerHTML=''; }
  _mentionAt=-1;_mentionHits=[];
}

function pickMention(i){
  const a=_mentionHits[i];
  const input=$('convComposerText');
  if(!a||!input||_mentionAt<0) return;

  /* Replace "@que" with the activity's name, so the sentence reads as
     a sentence. The chip below the message is what makes it a
     reference; this is only the words. */
  const caret=input.selectionStart;
  const before=input.value.slice(0,_mentionAt);
  const after=input.value.slice(caret);
  const insert=a.name+' ';
  input.value=before+insert+after;
  const pos=(before+insert).length;

  if(!_pendingMentions.includes(a.id)) _pendingMentions.push(a.id);
  closeMentionSuggest();
  renderPendingMentions();
  onConvComposerInput();
  input.focus();
  input.setSelectionRange(pos,pos);
}

/* The chips above the composer are the message's actual references —
   removable, because the text they inserted is editable and the two
   can otherwise only be separated by retyping the message. */
function renderPendingMentions(){
  const box=$('convPending');
  if(!box) return;
  if(!_pendingMentions.length){ box.innerHTML='';box.classList.remove('open');return; }
  const canNote=notesReady();
  box.innerHTML=_pendingMentions.map(id=>{
    const a=_convActs.find(x=>x.id===id);
    const on=_pendingNotes.includes(id);
    /* The note toggle is on the chip, not on the message, so several
       mentioned activities can each be filed or not independently. */
    const note=canNote?`<button class="conv-pending-note${on?' on':''}"
      onclick="togglePendingNote('${esc(id)}')"
      aria-pressed="${on?'true':'false'}"
      aria-label="Also add to this activity's notes">${icon(on?'pencil':'circle','ic-xs')}<span>${on?'Note on':'Note off'}</span></button>`:'';
    return `<span class="conv-pending-chip${on?' noting':''}">
      <button onclick="removePendingMention('${esc(id)}')" aria-label="Remove">${icon('x','ic-xs')}</button>
      <span>${esc(a?a.name:'Activity')}</span>
      ${note}
    </span>`;
  }).join('');
  box.classList.add('open');
}

function togglePendingNote(id){
  if(!notesReady()) return;
  _pendingNotes=_pendingNotes.includes(id)
    ? _pendingNotes.filter(x=>x!==id)
    : _pendingNotes.concat(id);
  renderPendingMentions();
}

/* One log entry per opted-in chip, attributed to the sender and
   worded exactly as the ⋯ menu's "Add to activity notes" does, so a
   note filed on send and one promoted afterwards read identically. */
async function fileMessageNotes(m,ids){
  const who=msgSenderLabel(m.sender_id,m.sender_name);
  const text=(m.body||'').trim();
  if(!text) return;
  let ok=0;
  for(const id of ids){
    const{error}=await addNote(id,`${who}: ${text}`);
    if(error) console.error('fileMessageNotes:',error); else ok++;
  }
  if(!ok) showToast('Couldn’t add that to notes.');
  else if(ok===1) showToast('Added to notes',"Open",()=>openActDetail(ids[0]));
  else showToast(`Added to ${ok} activities’ notes`);
}

function removePendingMention(id){
  _pendingMentions=_pendingMentions.filter(x=>x!==id);
  _pendingNotes=_pendingNotes.filter(x=>x!==id);
  renderPendingMentions();
  onConvComposerInput();
}

/* Tapping outside closes the mention list, delegated from the
   document the same way the location dropdown and Home's suggestions
   are — nothing that renders the composer has to bind it. */
document.addEventListener('click',e=>{
  const box=$('convMention');
  if(!box||!box.classList.contains('open')) return;
  const wrap=$('convComposer');
  if(wrap&&!wrap.contains(e.target)) closeMentionSuggest();
});

/* ==============================================================
   A MESSAGE'S OWN MENU

   Where "turn this into a note" lives. A decision reached in the
   conversation is exactly the thing that should end up on the
   activity, and this is the one place the app can do it in a tap —
   the alternative is reading the message, opening the activity and
   retyping what it said.
   ============================================================== */
function openMessageMenu(id){
  const m=_convMsgs.find(x=>x.id===id);
  if(!m) return;
  const mine=msgIsMine(m);
  const owner=_convList&&ownsCollection(_convList);
  const refs=(m.activity_ids||[]).filter(aid=>_convActs.some(a=>a.id===aid));
  const items=[];

  refs.forEach(aid=>{
    const a=_convActs.find(x=>x.id===aid);
    items.push({
      label:refs.length>1?`Add to notes: ${a.name}`:'Add to activity notes',
      icon:'pencil',
      onSelect:()=>addMessageToNotes(m,aid),
    });
    items.push({label:refs.length>1?`Open ${a.name}`:'Open activity',icon:'chevron-right',
      onSelect:()=>msgOpenActivity(aid)});
  });

  items.push({label:'Copy text',icon:'link',onSelect:()=>copyMessageText(m)});
  if(mine||owner) items.push({label:'Delete message',icon:'trash',role:'destructive',
    onSelect:()=>deleteMessage(m.id)});

  showActionSheet({title:msgSenderLabel(m.sender_id,m.sender_name),items});
}

async function copyMessageText(m){
  try{
    await navigator.clipboard.writeText(m.body||'');
    showToast('Copied');
  }catch(e){ showToast('Couldn’t copy that'); }
}

/* Soft delete — the row stays and the thread does not reflow under
   anyone mid-read. The select filters deleted_at, so it simply stops
   being fetched. */
async function deleteMessage(id){
  const{error}=await dbUpdate('messages',{deleted_at:new Date().toISOString()},{id});
  if(error){
    console.error('deleteMessage:',error);
    showToast(error.message||'Couldn’t delete that.');
    return;
  }
  _convMsgs=_convMsgs.filter(m=>m.id!==id);
  paintConversation();
  invalidateConversations();
  fetchConversations();
}

/* ==============================================================
   READ STATE
   ============================================================== */
async function markConversationRead(cid){
  if(!messagesReady()||!currentUser||!navigator.onLine) return;
  const{error}=await sb.from('conversation_reads').upsert({
    collection_id:cid,
    user_id:currentUser.id,
    last_read_at:new Date().toISOString(),
  },{onConflict:'collection_id,user_id'});
  if(error){ console.warn('markConversationRead:',error); return; }
  /* Patch the cached hub row rather than refetching it — the count is
     zero by construction now, and the tab badge has to follow. */
  const row=cachedConversations().find(c=>c.collection_id===cid);
  if(row) row.unread_count=0;
  updateMessagesBadge();
}

/* ==============================================================
   REALTIME

   Opened for the conversation on screen and closed on the way out.
   See the header for why it does not reach the hub.
   ============================================================== */
function subscribeConversation(cid){
  unsubscribeConversation();
  if(!sb.channel) return;
  try{
    _convChannel=sb.channel('conv:'+cid)
      .on('postgres_changes',
        {event:'INSERT',schema:'public',table:'messages',filter:'collection_id=eq.'+cid},
        p=>onRealtimeMessage(p.new))
      .on('postgres_changes',
        {event:'UPDATE',schema:'public',table:'messages',filter:'collection_id=eq.'+cid},
        p=>onRealtimeMessage(p.new))
      .subscribe();
  }catch(e){
    /* Realtime not enabled on the project, or the websocket refused.
       The conversation still works; it just will not update itself
       until you come back to it. */
    console.info('[messages] realtime unavailable:',e);
    _convChannel=null;
  }
}

function unsubscribeConversation(){
  if(!_convChannel) return;
  try{ sb.removeChannel(_convChannel); }catch(e){}
  _convChannel=null;
}

function onRealtimeMessage(row){
  if(!row||curPage!=='conversation'||row.collection_id!==curConvId) return;

  /* A soft delete arrives as an update. */
  if(row.deleted_at){
    const had=_convMsgs.length;
    _convMsgs=_convMsgs.filter(m=>m.id!==row.id);
    if(_convMsgs.length!==had) paintConversation();
    return;
  }

  const at=_convMsgs.findIndex(m=>m.id===row.id);
  if(at>=0){ _convMsgs[at]=row; paintConversation(); return; }

  /* Our own send is already on screen — it was drawn from the row we
     minted, so the echo would double it. */
  if(msgIsMine(row)) return;

  /* Only stick to the bottom if that is where the reader already is.
     Yanking someone out of the history they are reading because
     somebody else typed is the thing this check exists to prevent. */
  const scroll=$('convScroll');
  const atEnd=scroll&&(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight)<80;

  _convMsgs.push(row);
  paintConversation();
  if(atEnd){ scrollConversationToEnd(); markConversationRead(curConvId); }
}

/* ==============================================================
   THE KEYBOARD AND THE COMPOSER

   The composer is fixed to the bottom, and on iOS Safari re-anchors
   fixed elements to the *visual* viewport when the keyboard opens —
   which is what we want here, unlike the tab bar (see
   syncTabbarToKeyboard in nav.js, which spends real effort undoing
   exactly this). The one thing that needs correcting is the gap it
   leaves: at rest the composer sits above the tab bar, and once it
   has been lifted onto the keyboard the tab bar is no longer under
   it, so that reserved space becomes a strip of nothing.
   ============================================================== */
function syncComposerToKeyboard(){
  const vv=window.visualViewport;
  const el=$('convComposer');
  if(!vv||!el) return;
  const lift=Math.max(0,Math.round(window.innerHeight-(vv.height+vv.offsetTop)));
  el.classList.toggle('kb',lift>60);
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',syncComposerToKeyboard);
  window.visualViewport.addEventListener('scroll',syncComposerToKeyboard);
}

/* Paging backwards when the reader reaches the top. */
document.addEventListener('scroll',e=>{
  const scroll=$('convScroll');
  if(!scroll||e.target!==scroll) return;
  if(scroll.scrollTop<60) loadOlderMessages();
},true);

/* ==============================================================
   ACCOUNT TRANSITIONS

   Every cache here is per-account, so all of it goes — including the
   live channel, which is subscribed under the previous session's
   token. See ONE ACCOUNT AT A TIME in CLAUDE.md.
   ============================================================== */
function resetMessagesState(){
  invalidateAvatars();
  leaveConversation();
  invalidateConversations();
  resetMessagesProbe();
  curConvId=null;
  updateMessagesBadge();
}

/* ==============================================================
   THE CONVERSATION'S ⋯ MENU

   Everything about the conversation that is not the conversation:
   the list it belongs to, and who is in it. Kept to three items on
   purpose — this bar button is one tap from the message field, and a
   long menu here would be a second navigation surface competing with
   the one the screen already has.
   ============================================================== */
function openConversationMenu(){
  if(!_convList) return;
  const items=[
    {label:'Open the list',icon:'stack',
      onSelect:()=>nav('detail',_convList.id)},
  ];
  /* Only the owner can mint or revoke an invite — the same check the
     collection menu makes, and RLS is what actually enforces it. */
  if(sharingReady()&&ownsCollection(_convList)){
    items.push({label:'People & invites',icon:'share',onSelect:()=>{
      /* openShareList() reads curListId, which is the collection this
         conversation belongs to. */
      curListId=_convList.id;
      openShareList();
    }});
  }
  items.push({label:'Mark as read',icon:'check',onSelect:()=>{
    markConversationRead(_convList.id);
    refreshConversations();
  }});
  /* Muting stops the push and nothing else — the conversation still
     appears on the hub and still carries its unread count. A mute that
     also hid the conversation would be a way to lose a list. */
  items.push({label:_convMuted?'Unmute notifications':'Mute notifications',
    icon:_convMuted?'circle':'check-circle',
    onSelect:()=>toggleConversationMute()});
  showActionSheet({title:_convList.name,items});
}

/* ==============================================================
   GETTING HERE FROM THE LIST

   A conversation is reachable from the Messages tab and from the
   collection it belongs to, because those are the two places people
   look for it — the hub when they are catching up, the list when
   they are already looking at the thing being discussed.
   ============================================================== */
/* ==============================================================
   MUTING

   Per person per list, in conversation_prefs. Read only by
   send-message-push, which drops muted users out of the audience —
   so this changes what arrives on a lock screen and nothing about
   what the app shows.

   The table is optional like everything else: without it the toggle
   reports that it needs the migration rather than silently doing
   nothing.
   ============================================================== */
let _convMuted=false;

async function loadConversationMute(cid){
  _convMuted=false;
  if(!messagesReady()||!currentUser||!navigator.onLine) return;
  const{data,error}=await sb.from('conversation_prefs')
    .select('muted').eq('collection_id',cid).eq('user_id',currentUser.id).maybeSingle();
  if(error){ console.info('[messages] no conversation_prefs table — nothing muted'); return; }
  _convMuted=!!(data&&data.muted);
}

async function toggleConversationMute(){
  if(!_convList) return;
  const next=!_convMuted;
  const{error}=await sb.from('conversation_prefs').upsert({
    collection_id:_convList.id,
    user_id:currentUser.id,
    muted:next,
  },{onConflict:'collection_id,user_id'});
  if(error){
    console.error('toggleConversationMute:',error);
    showToast('Muting needs supabase/messages.sql to be re-run');
    return;
  }
  _convMuted=next;
  showToast(next?'Muted — you’ll still see it here':'Notifications on');
}

function openConversationForList(cid){
  if(!messagesReady()){
    showToast('Messages need supabase/messages.sql to be run first');
    return;
  }
  nav('conversation',cid);
}

/* Does this collection have a conversation? Answered from the hub
   cache, so it costs nothing and is correct as soon as the hub is —
   which is why the collection menu only offers the entry when the
   list is genuinely shared. */
function listHasConversation(cid){
  return messagesReady()&&cachedConversations().some(c=>c.collection_id===cid);
}

/* ==============================================================
   ARRIVING FROM A NOTIFICATION

   Tapping a message notification has to land on the conversation it
   came from, and there are two entirely different cases:

   - **The app is already running.** The service worker postMessages
     the running page, which is the only way to reach it — there is no
     URL routing in this app, so there is nothing to navigate to.
   - **The app is cold.** There is no page to tell, so sw.js opens
     `?conv=<id>` and this reads it at boot.

   The boot reader follows readEmailConfirmation()'s pattern, NOT
   readSharedInput()'s: it removes only its own key and puts the rest of
   the query string back, so it can run before the two readers that
   blank the search string wholesale. Order matters here for the same
   reason it does there — an invite link followed to a message
   notification would otherwise lose one of the two.
   ============================================================== */
let pendingConv=null,pendingAct=null;

function readPushLanding(){
  try{
    const p=new URLSearchParams(location.search);
    const id=p.get('conv'),act=p.get('act');
    if(!id&&!act) return;
    pendingConv=id||null;
    pendingAct=act||null;
    p.delete('conv');p.delete('act');
    const rest=p.toString();
    history.replaceState({},'',location.pathname+(rest?'?'+rest:'')+location.hash);
  }catch(e){ /* a malformed URL is not worth failing the boot over */ }
}

/* Called from showApp(), once there is a user to open it for. */
function handlePushLanding(){
  const act=pendingAct;
  pendingAct=null;
  if(act) openActivityFromPush(act);
  const id=pendingConv;
  pendingConv=null;
  if(!id) return;
  /* probeMessages() may not have answered yet on a cold start. Waiting
     on it is correct: without the table there is no conversation to
     open, and navigating anyway would land on an error state. */
  probeMessages().then(ok=>{ if(ok) nav('conversation',id); });
}

/* The warm case. sw.js posts this when a notification is tapped while
   the app is already open. */
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message',e=>{
    const d=e.data;
    if(!d||!currentUser) return;
    if(d.type==='open-activity'&&d.activityId) return openActivityFromPush(d.activityId);
    if(d.type!=='open-conversation'||!d.collectionId) return;
    if(!messagesReady()) return;
    nav('conversation',d.collectionId);
  });
}

/* A reminder notification names one activity, so tapping it should land
   on that activity and not merely on the app. There is no URL routing
   here, so "landing" means navigating to the collection it is homed in
   and opening its sheet on top — the same place a tap on its row goes. */
async function openActivityFromPush(id){
  try{
    const a=await fetchActivity(id);
    if(!a) return;
    if(a.listId) nav('detail',a.listId);
    openActDetail(id);
  }catch(e){ /* a reminder that cannot be opened is not worth an error */ }
}
