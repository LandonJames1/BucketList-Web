/* ==============================================================
   OFFLINE — read from disk, write to a queue, sync on reconnect.

   Before this, "offline" meant the shell loaded and every list was
   empty: sw.js caches the app's own files but Supabase is on
   NEVER_CACHE_HOSTS, so there was nothing to show and nothing you
   could do. That is the wrong failure for an app whose whole purpose
   is catching an idea the moment it arrives — ideas arrive on planes
   and in tunnels.

   Two halves:

     1. A snapshot of the two queries that back the app, kept in
        IndexedDB and read when the network cannot answer.
     2. A durable queue of writes, replayed in order when it can.

   ---- Why this is simpler than it looks ----

   Collections.id and Activities.id are **uuid** columns, so this
   client can mint a row's permanent id itself with crypto.randomUUID()
   and insert it explicitly. That single fact removes the hardest part
   of offline sync: there are no temporary ids, so nothing has to be
   rewritten when a queued insert finally lands, and a row created
   offline can be edited, completed and deleted — by id — before it
   has ever reached the server. Ids are minted for online writes too,
   so the two paths are the same code.

   ---- What it deliberately does not do ----

   No conflict resolution. Last write wins, which is correct for a
   library one person curates from their own devices. Shared lists
   (js/sharing.js) widen that a little, and the honest answer there is
   still last-write-wins — two people editing the same activity's name
   in the same minute is not a case worth a merge algorithm.

   Media is the one thing that cannot be queued: a 5MB video in
   IndexedDB waiting on a flush is a different feature. Photos taken
   offline fall back to inline base64 (what the app did before the
   storage bucket existed) and video is refused with an explanation.
   See js/media.js.
   ============================================================== */

const OFFLINE_DB='bucketlist';
const OFFLINE_DB_VERSION=1;
const STORE_SNAPSHOT='snapshot';
const STORE_QUEUE='queue';

/* ==============================================================
   INDEXEDDB

   Wrapped rather than pulled in as a library: this needs a key/value
   store and an append-only log, which is about forty lines of the
   raw API and no dependency.

   Every call degrades to null/false rather than throwing. Private
   browsing modes and locked-down embedded webviews refuse IndexedDB
   outright, and the app has to keep working exactly as it did before
   when they do.
   ============================================================== */
let _idb=null,_idbPromise=null,_idbBroken=false;

function idbOpen(){
  if(_idb) return Promise.resolve(_idb);
  if(_idbBroken) return Promise.resolve(null);
  if(_idbPromise) return _idbPromise;

  _idbPromise=new Promise(resolve=>{
    let req;
    try{ req=indexedDB.open(OFFLINE_DB,OFFLINE_DB_VERSION); }
    catch(e){ _idbBroken=true; resolve(null); return; }

    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE_SNAPSHOT))
        db.createObjectStore(STORE_SNAPSHOT,{keyPath:'key'});
      if(!db.objectStoreNames.contains(STORE_QUEUE))
        db.createObjectStore(STORE_QUEUE,{keyPath:'seq',autoIncrement:true});
    };
    req.onsuccess=()=>{ _idb=req.result; _idbPromise=null; resolve(_idb); };
    req.onerror=()=>{
      console.warn('[offline] IndexedDB unavailable:',req.error);
      _idbBroken=true;_idbPromise=null;resolve(null);
    };
    /* Another tab holding an old version open. Nothing to do but
       carry on without persistence. */
    req.onblocked=()=>{ _idbBroken=true;_idbPromise=null;resolve(null); };
  });
  return _idbPromise;
}

function idbRun(store,mode,fn){
  return idbOpen().then(db=>{
    if(!db) return null;
    return new Promise(resolve=>{
      let tx;
      try{ tx=db.transaction(store,mode); }
      catch(e){ resolve(null); return; }
      const req=fn(tx.objectStore(store));
      tx.onabort=tx.onerror=()=>resolve(null);
      if(req) req.onsuccess=()=>resolve(req.result);
      else tx.oncomplete=()=>resolve(true);
    });
  }).catch(e=>{ console.warn('[offline] idb:',e); return null; });
}

const idbGet   =(store,key)=>idbRun(store,'readonly', s=>s.get(key));
const idbAll   =store=>idbRun(store,'readonly', s=>s.getAll());
const idbPut   =(store,val)=>idbRun(store,'readwrite',s=>s.put(val));
const idbDelete=(store,key)=>idbRun(store,'readwrite',s=>s.delete(key));
const idbClear =store=>idbRun(store,'readwrite',s=>s.clear());

/* ==============================================================
   THE SNAPSHOT

   Raw PostgREST rows, not the camelCase shapes the UI uses. Storing
   what the server actually sent keeps mapActivity()/mapCollection()
   the single place that knows the column names — a mapper change
   then applies to cached rows too, instead of silently disagreeing
   with them until the next online load.

   Keyed by user, so signing in as someone else on a shared device
   cannot show the previous account's lists.
   ============================================================== */
function snapKey(kind){
  return kind+':'+((currentUser&&currentUser.id)||'anon');
}

async function snapshotSave(kind,rows){
  if(!Array.isArray(rows)) return;
  await idbPut(STORE_SNAPSHOT,{key:snapKey(kind),rows,at:Date.now()});
}

async function snapshotLoad(kind){
  const rec=await idbGet(STORE_SNAPSHOT,snapKey(kind));
  return rec&&Array.isArray(rec.rows)?rec.rows:null;
}

/* When the snapshot was last refreshed from the network, so the UI
   can say how stale it is rather than presenting old rows as live. */
async function snapshotAge(kind){
  const rec=await idbGet(STORE_SNAPSHOT,snapKey(kind));
  return rec&&rec.at?Date.now()-rec.at:null;
}

async function snapshotClear(){
  await idbClear(STORE_SNAPSHOT);
}

/* ==============================================================
   THE QUEUE
   ============================================================== */
let _queueCount=0,_flushing=null;

/* Counts only what the signed-in account can actually send. The banner
   reads off this, and another user's stranded writes are not something
   to tell this one they have waiting — flushQueue() will not send them
   either. Ops with no uid predate the field and count as ours. */
async function queueLoadCount(){
  const all=await idbAll(STORE_QUEUE);
  const uid=(currentUser&&currentUser.id)||null;
  _queueCount=all?all.filter(op=>!op.uid||op.uid===uid).length:0;
  updateSyncUI();
  return _queueCount;
}
function pendingWrites(){ return _queueCount; }

async function queueWrite(op){
  /* Stamped with whose write it is. The queue is one shared store —
     unlike the snapshot, which is keyed by user — so without this a
     different account signing in on the same device would pick up the
     previous one's unsent writes and replay them under its own
     session. RLS refuses them, so flushQueue() would then drop them as
     unreplayable and the original owner would lose the work silently.
     See the owner check in flushQueue(). */
  const ok=await idbPut(STORE_QUEUE,{...op,uid:(currentUser&&currentUser.id)||null,at:Date.now()});
  if(ok===null){
    /* No persistence available. The write is lost on reload, which is
       worth saying out loud rather than pretending it is safe. */
    showToast('Saved on this screen only — offline storage is unavailable');
    return false;
  }
  _queueCount++;
  updateSyncUI();
  return true;
}

/* ==============================================================
   WRITING

   dbInsert / dbUpdate / dbDelete are what every mutation site calls
   instead of sb.from(...).insert/update/delete. Each returns the
   familiar {error} shape, plus `offline:true` when the write was
   queued rather than sent, so a caller can adjust its toast.

   A queued write is applied to the snapshot immediately, which is
   what makes the app feel normal offline: the row appears, the check
   ticks, the list count moves. The queue then makes it true.
   ============================================================== */

/* A failure to reach the server, as opposed to the server refusing.
   Only the first should queue: a row rejected by a constraint or by
   RLS will be rejected again on replay, forever. */
function isNetworkError(e){
  if(!navigator.onLine) return true;
  if(!e) return false;
  const msg=((e.message||'')+' '+(e.details||'')).toLowerCase();
  return e instanceof TypeError ||
         msg.includes('failed to fetch') ||
         msg.includes('networkerror') ||
         msg.includes('network request failed') ||
         msg.includes('load failed') ||
         msg.includes('timeout') ||
         e.code==='ECONNREFUSED';
}

/* Rows get their id and timestamp here rather than from the server,
   so an offline insert is a real, addressable row the instant it is
   made — see the header. */
function stampRow(values){
  const row={...values};
  /* uuidv4() rather than crypto.randomUUID() directly: that one is
     undefined outside a secure context, so over plain http on a LAN
     address — how you test on a phone — every insert would otherwise
     be handed a non-uuid and rejected by Postgres. See js/utils.js. */
  if(!row.id) row.id=uuidv4();
  if(!row.created_at) row.created_at=new Date().toISOString();
  /* Loud here rather than cryptic three layers down. This is the only
     place a client-minted id reaches the database. */
  if(!isUuid(row.id)) console.error('[offline] refusing to send a non-uuid id:',row.id);
  return row;
}

async function dbInsert(table,values){
  const rows=(Array.isArray(values)?values:[values]).map(stampRow);
  const op={table,action:'insert',rows};

  if(navigator.onLine){
    const{error}=await sb.from(table).insert(rows);
    if(!error){ await applyOp(op); return{error:null,rows}; }
    if(!isNetworkError(error)) return{error};
  }
  await queueWrite(op);
  await applyOp(op);
  return{error:null,offline:true,rows};
}

async function dbUpdate(table,values,match){
  const op={table,action:'update',values,match};

  if(navigator.onLine){
    let q=sb.from(table).update(values);
    Object.entries(match).forEach(([k,v])=>{q=q.eq(k,v);});
    const{error}=await q;
    if(!error){ await applyOp(op); return{error:null}; }
    if(!isNetworkError(error)) return{error};
  }
  await queueWrite(op);
  await applyOp(op);
  return{error:null,offline:true};
}

async function dbDelete(table,match){
  const op={table,action:'delete',match};

  if(navigator.onLine){
    let q=sb.from(table).delete();
    Object.entries(match).forEach(([k,v])=>{q=q.eq(k,v);});
    const{error}=await q;
    if(!error){ await applyOp(op); return{error:null}; }
    if(!isNetworkError(error)) return{error};
  }
  await queueWrite(op);
  await applyOp(op);
  return{error:null,offline:true};
}

/* ==============================================================
   APPLYING A WRITE LOCALLY

   Runs for online writes too, not only queued ones. Keeping the
   snapshot in step on every write means a device that goes offline
   mid-session already holds everything it has done this session,
   without having to refetch first.

   The in-memory cache in api.js is invalidated rather than patched:
   it is derived from these rows, and one place deciding what a row
   looks like is worth more than saving a re-map.
   ============================================================== */
const OFFLINE_KIND={Collections:'collections',Activities:'activities'};

function rowMatches(row,match){
  return Object.entries(match).every(([k,v])=>row[k]===v);
}

async function applyOp(op){
  const kind=OFFLINE_KIND[op.table];
  if(!kind) return;                      /* push_subscriptions, Users — not cached */

  const rows=await snapshotLoad(kind);

  /* No snapshot and no network: a first-ever launch offline, or a
     launch offline after a sign-out cleared it. There is nothing to
     patch, and without this the row the user just created would be
     written to the queue and then vanish from the screen — the next
     read has no server to ask and no snapshot to fall back on. Seeding
     with the new rows is the only thing that could be shown, and it is
     the truth as far as this device knows it. */
  if(!rows&&!navigator.onLine&&op.action==='insert'){
    await snapshotSave(kind,op.rows);
  }

  /* No snapshot at all, or no IndexedDB. There is nothing to patch,
     but the cache below still has to be dealt with — skipping it when
     persistence is unavailable would leave the screen showing the row
     as it was before the write, which is the one failure this whole
     file exists to avoid. */
  let next=null;
  if(rows){
    next=rows;
    if(op.action==='insert'){
      /* Replayed inserts must not double up if the first attempt in fact
         reached the server. Keyed on id, which we minted. */
      const have=new Set(rows.map(r=>r.id));
      next=rows.concat(op.rows.filter(r=>!have.has(r.id)));
    } else if(op.action==='update'){
      next=rows.map(r=>rowMatches(r,op.match)?{...r,...op.values}:r);
    } else if(op.action==='delete'){
      next=rows.filter(r=>!rowMatches(r,op.match));
    }
    await snapshotSave(kind,next);
  }

  /* The row set was just computed for the snapshot, so hand it to the
     in-memory cache too rather than dropping that cache and making the
     re-render fetch the whole table back to learn something this
     client already knows. See the note on primeActivities() in api.js.

     Priming is refused on a cold cache, and it cannot happen at all
     with no snapshot to compute from — both fall through to the
     invalidate, which is the old behaviour and still correct. */
  const primed=next && (kind==='activities'
    ? primeActivities(next)
    : primeCollections(next));
  if(primed) return;

  if(kind==='activities') invalidateActivities();
  else invalidateCollections();
}

/* ==============================================================
   FLUSHING

   Replayed strictly in order — an insert followed by an update of
   the same row has to arrive that way round.

   The distinction that matters is which failures stop the queue. A
   network failure stops it and keeps everything, to be retried. A
   rejection stops nothing: the row is gone, or a policy refuses it,
   and replaying it on every future reconnect would wedge the queue
   permanently behind an op that can never succeed. Those are dropped
   and logged.
   ============================================================== */
async function flushQueue(){
  if(_flushing) return _flushing;
  if(!navigator.onLine||!currentUser) return false;

  _flushing=(async()=>{
    const ops=await idbAll(STORE_QUEUE);
    if(!ops||!ops.length){ _queueCount=0; updateSyncUI(); return false; }

    ops.sort((a,b)=>a.seq-b.seq);
    updateSyncUI(true);
    let sent=0,dropped=0;

    for(const op of ops){
      /* Somebody else's unsent writes. Left exactly where they are —
         not replayed, and emphatically not dropped: they belong to an
         account that may well sign back in on this device, and RLS
         would reject every one of them under this session anyway.
         Ops queued before this field existed have no uid and are
         replayed as before, which is the old behaviour and correct for
         the single-account device they were written on. */
      if(op.uid&&op.uid!==currentUser.id) continue;
      try{
        let error;
        if(op.action==='insert'){
          /* upsert, not insert: if the original attempt actually
             reached the server before the connection dropped, a plain
             insert would fail on the primary key and this op would be
             dropped as a rejection — losing nothing, but noisily. */
          ({error}=await sb.from(op.table).upsert(op.rows,{onConflict:'id'}));
        } else if(op.action==='update'){
          let q=sb.from(op.table).update(op.values);
          Object.entries(op.match).forEach(([k,v])=>{q=q.eq(k,v);});
          ({error}=await q);
        } else {
          let q=sb.from(op.table).delete();
          Object.entries(op.match).forEach(([k,v])=>{q=q.eq(k,v);});
          ({error}=await q);
        }
        if(error) throw error;
        await idbDelete(STORE_QUEUE,op.seq);
        sent++;
      }catch(err){
        if(isNetworkError(err)){
          /* Still offline. Keep everything from here on and try again
             on the next reconnect. */
          await queueLoadCount();
          updateSyncUI();
          return false;
        }
        console.warn('[offline] dropping unreplayable write:',op,err);
        await idbDelete(STORE_QUEUE,op.seq);
        dropped++;
      }
    }

    await queueLoadCount();
    updateSyncUI();
    if(sent) showToast(`Synced ${sent} change${sent===1?'':'s'}`);
    if(dropped) showToast(`${dropped} change${dropped===1?'':'s'} couldn’t be synced`);
    return sent>0;
  })().finally(()=>{ _flushing=null; });

  return _flushing;
}

/* ==============================================================
   THE BANNER

   One line that says what is actually true, rather than the old
   fixed "changes can't be saved" — which is no longer the case and
   was the more alarming half of being offline.
   ============================================================== */
function updateSyncUI(syncing){
  const bar=$('offlineBar');
  if(!bar) return;
  const n=_queueCount;

  if(syncing){
    bar.textContent=`Syncing ${n} change${n===1?'':'s'}…`;
    bar.classList.add('show','syncing');
    return;
  }
  bar.classList.remove('syncing');

  if(!navigator.onLine){
    bar.textContent=n
      ? `Offline — ${n} change${n===1?'':'s'} will sync`
      : 'Offline — showing your last saved data';
    bar.classList.add('show');
    return;
  }
  /* Online with a queue still standing means a flush failed. Say so;
     silently holding writes is how people lose them. */
  if(n){
    bar.textContent=`${n} change${n===1?'':'s'} waiting to sync`;
    bar.classList.add('show');
    return;
  }
  bar.classList.remove('show');
}

/* ==============================================================
   SIGN-OUT

   The snapshot is this account's rows sitting unencrypted on the
   device, so it goes when the session does. The queue does NOT —
   unsent writes belong to the account that made them and are
   replayed when it signs back in.
   ============================================================== */
async function offlineSignOut(){
  await snapshotClear();
}

/* Boot: find out whether anything is waiting, and try to send it. */
async function offlineInit(){
  await queueLoadCount();
  if(navigator.onLine&&_queueCount) flushQueue();
}
