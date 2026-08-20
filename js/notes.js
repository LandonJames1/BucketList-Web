/* ==============================================================
   NOTES — the append-only log on an activity.

   ---- Why notes came back, and why they came back different ----

   The activity sheet used to carry a "Notes / Why is this on your
   list?" field, and it was removed for a good reason that still
   holds: at the moment of capture, the answer to "why is this on
   your list" is the activity's name. The field sat empty on nearly
   every row while costing the sheet a block of height.

   This is not that field. Once a list is shared, notes are the
   working state of a plan several people are making — "we settled on
   the 14th", "Sarah's booking the car", "the permit window opens in
   March". That is a collaboration artifact, not a capture-time one,
   and it is written *after* the activity exists rather than while it
   is being created.

   ---- Append-only, and that is the whole design ----

   The app is last-write-wins with no presence, which is fine for a
   library one person curates and exactly wrong for a field two
   people might edit during one conversation. A single text column
   would mean one of them silently losing what they wrote.

   So a note is a row: attributed, timestamped, and never rewritten.
   Two people adding at the same moment both succeed, because they
   are not writing to the same place. There is deliberately no UPDATE
   policy on the table — an entry is what somebody said at a moment,
   and a log whose history can be edited is not a log. A wrong entry
   is removed and another added.

   ---- Removing one ----

   The author can remove their own; the owner of the list the
   activity is homed in can remove any, which is the moderation floor
   a shared space needs. That is enforced by RLS — the checks here
   only decide which buttons to draw.

   ---- It rides on messages.sql ----

   activity_notes is created by the same migration as the messages
   tables, so notesReady() is messagesReady(). Without it the notes
   section simply does not appear, exactly as the reminder UI does
   not appear without remind_at.
   ============================================================== */

/* Same migration, same answer. */
function notesReady(){ return messagesReady(); }

/* Notes are fetched per activity rather than cached with everything
   else, for the same reason messages are: you only ever have one
   activity open, and putting an unbounded per-row list into the two
   backing queries would pull every note in the library on launch. */
async function fetchNotes(activityId){
  if(!notesReady()||!activityId) return [];
  if(!navigator.onLine) return [];
  const{data,error}=await sb.from('activity_notes')
    .select('id,activity_id,author_id,author_name,body,created_at')
    .eq('activity_id',activityId)
    .order('created_at',{ascending:true});
  if(error){ console.warn('fetchNotes:',error); return []; }
  return data||[];
}

/* ==============================================================
   DRAWING THE LOG

   Called by openActDetail() into a placeholder it has already
   rendered, so the sheet paints immediately and the log fills in
   behind it — the notes are never what the sheet is about, and
   awaiting them would hold up the photos and the buttons.
   ============================================================== */
/* Which collection an activity is homed in, so the log can ask for
   the same avatar map the conversation uses. Read from the in-memory
   cache — this is the id collection_avatars() is scoped by, and a
   miss simply means initials. */
function noteCollectionId(activityId){
  const a=cachedActivities().find(x=>x.id===activityId);
  return a?a.listId:null;
}

async function renderActivityNotes(activityId){
  const box=$('adNotes');
  if(!box||!notesReady()) return;

  const cid=noteCollectionId(activityId);
  /* Deliberately not awaited alongside the notes: the log paints from
     author_name, which is a snapshot on every row, and repaints when
     the photos land. Same contract as a conversation — a face arriving
     a moment after the words is invisible, waiting for it is not. */
  const avatarsP=cid?loadConversationAvatars(cid):Promise.resolve(null);

  const notes=await fetchNotes(activityId);
  /* The sheet may have been closed, or a different activity opened,
     while this was in flight. */
  if(!paintActivityNotes(activityId,notes,cid)) return;

  avatarsP.then(map=>{ if(map&&Object.keys(map).length) paintActivityNotes(activityId,notes,cid); });
}

/* Returns false when the sheet has moved on, so the avatar repaint
   above can stop rather than write into somebody else's log. */
function paintActivityNotes(activityId,notes,cid){
  const still=$('adNotes');
  if(!still||still.dataset.for!==activityId) return false;

  /* The preview shows the two most recent and nothing else. It is a
     button onto the notes page — no composer, no menus — so the
     section reads as one tap rather than as a control panel. */
  const recent=notes.slice(-2).reverse();
  still.innerHTML=`
    <div class="ad-nsec-h">
      <p class="h">Notes</p>
      <span class="ad-nsec-more">${notes.length?`${notes.length} note${notes.length===1?'':'s'}`:'Add'} ${icon('chevron-right','ic-xs')}</span>
    </div>
    ${notes.length
      ? recent.map(n=>`<div class="note-card">
          <p class="m">${noteAvatarHTML(n,cid)}<span>${esc(noteWho(n))} &middot; ${esc(msgDayLabel(n.created_at))}</span></p>
          <p class="t">${esc(n.body)}</p></div>`).join('')
      : '<div class="note-empty"><p>No notes yet</p></div>'}`;

  /* The page behind it: the whole log, with each entry's own menu. */
  const full=$('adNotesFull');
  if(full) full.innerHTML=notes.length
    ? `<div class="note-log">${notes.map(n=>noteRowHTML(n,activityId,cid)).join('')}</div>`
    : `<div class="note-empty"><p>No notes yet</p></div>`;
  return true;
}

/* Who an entry is attributed to. A null author_id is an account that
   has been deleted — the entry stays, because removing it would tear
   a hole in a discussion other people had. */
function noteWho(n){
  if(!n.author_id) return n.author_name||'Deleted account';
  if(currentUser&&n.author_id===currentUser.id) return 'You';
  return n.author_name||'Someone';
}

/* The author's photo, from the same collection_avatars() map the
   conversation uses — one RPC per collection, cached for the session.
   A deleted account keeps its grey disc even when a photo is known,
   for the reason msgAvatarHTML() gives: a name with no account behind
   it must not look like every other name. */
function noteAvatarHTML(n,cid){
  const gone=!n.author_id;
  const map=cid?avatarsFor(cid):null;
  const url=(!gone&&n.author_id&&map)?map[n.author_id]:'';
  if(url) return `<span class="msg-avatar has-photo"><img src="${esc(url)}" alt="" loading="lazy"/></span>`;
  return `<span class="msg-avatar${gone?' gone':''}">${esc(msgInitial(n.author_name||(n.author_id&&currentUser&&n.author_id===currentUser.id?(userProfile&&(userProfile.display_name||userProfile.username)):'')||'?'))}</span>`;
}

function noteRowHTML(n,activityId,cid){
  const gone=!n.author_id;
  const who=noteWho(n);
  const when=`${msgDayLabel(n.created_at)} · ${msgClock(n.created_at)}`;

  return `<div class="note-row">
    <div class="note-meta">
      ${noteAvatarHTML(n,cid)}
      <span class="note-who${gone?' gone':''}">${esc(who)}</span>
      ${gone?'<span class="msg-gone">Deleted account</span>':''}
      <span class="note-when">${esc(when)}</span>
      <button class="note-menu" onclick="openNoteMenu('${esc(n.id)}','${esc(activityId)}')"
        aria-label="Note options">${icon('ellipsis','ic-xs')}</button>
    </div>
    <div class="note-body">${esc(n.body)}</div>
  </div>`;
}

function onNoteInput(){
  const el=$('adNoteInput');
  if(!el) return;
  el.style.height='auto';
  el.style.height=Math.min(el.scrollHeight,140)+'px';
  el.style.overflowY=el.scrollHeight>140?'auto':'hidden';
  const go=$('adNoteGo');
  if(go) go.classList.toggle('show',!!el.value.trim());
}
function onNoteKey(e){
  /* Return sends; Shift+Return is a new line. A note is usually one
     sentence, and reaching for a button to commit it is the friction
     that stops people writing them at all. */
  if(e.key==='Enter'&&!e.shiftKey){
    e.preventDefault();
    const box=$('adNotes');
    if(box&&box.dataset.for) submitActivityNote(box.dataset.for);
  }
}

/* ==============================================================
   WRITING

   Through dbInsert, so a note written offline is queued and replayed
   like every other write. applyOp() ignores tables it does not
   cache, which is right — notes are not in the snapshot.
   ============================================================== */
async function addNote(activityId,body){
  const text=(body||'').trim();
  if(!text||!activityId) return{error:{message:'Nothing to add'}};
  if(!notesReady()) return{error:{message:'Notes need supabase/messages.sql to be run first'}};

  return dbInsert('activity_notes',{
    activity_id:activityId,
    author_id:currentUser.id,
    /* Snapshotted, exactly as a message's sender_name is, so the log
       still reads as a conversation once an account is gone. */
    author_name:(userProfile&&(userProfile.display_name||userProfile.username))||'Someone',
    body:text,
  });
}

async function submitActivityNote(activityId){
  const el=$('adNoteInput');
  if(!el) return;
  const text=el.value.trim();
  if(!text){ shakeEl(el); return; }

  el.value='';onNoteInput();
  const{error,offline}=await addNote(activityId,text);
  if(error){
    console.error('submitActivityNote:',error);
    showToast(error.message||'Couldn’t add that note.');
    el.value=text;onNoteInput();
    return;
  }
  if(offline){ showToast('Offline — this note will sync'); }
  renderActivityNotes(activityId);
}

function openNoteMenu(id,activityId){
  const items=[
    {label:'Copy note',icon:'link',onSelect:()=>copyNote(id)},
    /* Shown to everyone: RLS is what actually decides, and a button
       that is refused says so in a toast. Hiding it on a guess would
       need the activity's owner here, which is a query this sheet
       does not otherwise make. */
    {label:'Delete note',icon:'trash',role:'destructive',
      onSelect:()=>deleteNote(id,activityId)},
  ];
  showActionSheet({title:'Note',items});
}

async function copyNote(id){
  const box=$('adNotesFull');
  const row=box&&box.querySelector(`[onclick*="${id}"]`);
  const body=row&&row.closest('.note-row')?row.closest('.note-row').querySelector('.note-body'):null;
  try{
    await navigator.clipboard.writeText(body?body.textContent:'');
    showToast('Copied');
  }catch(e){ showToast('Couldn’t copy that'); }
}

async function deleteNote(id,activityId){
  const{error}=await dbDelete('activity_notes',{id});
  if(error){
    console.error('deleteNote:',error);
    showToast(error.message||'Couldn’t delete that note.');
    return;
  }
  renderActivityNotes(activityId);
}

/* ==============================================================
   FROM A MESSAGE TO A NOTE

   The reason the whole feature is worth building. A decision reached
   in a conversation — "ok, the 14th then" — is exactly the thing
   that should end up on the activity, and the alternative is reading
   the message, opening the activity, and retyping what it said.

   The entry is attributed to whoever is doing the filing, not to the
   original author, and it says where it came from. Attributing it to
   the sender would put words in their mouth: they wrote a message,
   not a note, and the decision to promote it was somebody else's.
   ============================================================== */
async function addMessageToNotes(m,activityId){
  const who=msgSenderLabel(m.sender_id,m.sender_name);
  const text=(m.body||'').trim();
  if(!text){ showToast('That message has no text to add'); return; }

  const{error}=await addNote(activityId,`${who}: ${text}`);
  if(error){
    console.error('addMessageToNotes:',error);
    showToast(error.message||'Couldn’t add that note.');
    return;
  }
  showToast('Added to notes',"Open",()=>openActDetail(activityId));
}

/* ==============================================================
   THE FIELD ON THE NEW / EDIT ACTIVITY SHEET

   A note typed while creating or editing an activity becomes the
   log's first entry. It is written AFTER the activity itself, and
   deliberately not as part of that write: they are different rows in
   different tables, and a note that fails must not take the activity
   down with it — the user typed a name and a date, and losing those
   because a note could not be filed would be the worse failure.

   Hidden entirely without the migration, exactly as the reminder row
   is hidden without remind_at.
   ============================================================== */
function resetActivityNoteField(){
  const row=$('aNotesRow'),el=$('aNotes');
  if(row) row.style.display=notesReady()?'':'none';
  if(el){ el.value='';el.style.height=''; }
}

/* Called by commitSaveActivity() once the activity exists. Silent on
   success; a failure says so but does not undo the save. */
async function flushActivityNoteField(activityId){
  const el=$('aNotes');
  if(!el||!activityId||!notesReady()) return;
  const text=el.value.trim();
  el.value='';
  if(!text) return;
  const{error}=await addNote(activityId,text);
  if(error){
    console.warn('flushActivityNoteField:',error);
    showToast('Saved, but the note couldn’t be added');
  }
}
