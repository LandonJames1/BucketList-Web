/* ==============================================================
   API — all Supabase reads/writes for collections + activities
   Row mappers translate snake_case DB columns into the camelCase
   shapes the rest of the app expects.
   ============================================================== */

function mapCollection(row){
  try{
    return{id:row.id,name:row.name,description:row.description||'',cover:row.cover_image||'',
      /* Who owns it. Only meaningful once shared lists are enabled, but
         carried always so the UI never has to branch on whether the
         field exists — a collection you do not own is one you can leave
         but not delete, and cannot re-share. See js/sharing.js. */
      ownerId:row.user_id||null,
      createdAt:row.created_at};
  }catch(e){console.error('mapCollection error:',e,row);return{id:row.id,name:row.name||'',description:'',cover:'',ownerId:null,createdAt:row.created_at};}
}
/* The `photos` column is a JSON array holding two shapes at once, and
   code that reads it must tolerate both:

     "https://…/x.jpg"            a photo (or a legacy base64 data URL)
     {type:'video',url,poster}    a video, with a still frame for thumbs

   Photos stayed bare strings so every row written before videos existed
   still reads correctly, and so `a.photos` keeps meaning "the images" for
   the thumbnails, map pins and grid cards that only ever wanted one.
   `a.media` is the full ordered list, which is what the completion sheet
   and the lightbox walk. See js/media.js. */
function normMedia(list){
  return (list||[]).map(m=>{
    if(typeof m==='string') return{type:'photo',url:m,poster:''};
    if(m&&m.url) return{type:m.type==='video'?'video':'photo',url:m.url,poster:m.poster||''};
    return null;
  }).filter(Boolean);
}
/* Back to the storage shape: photos collapse to plain strings. */
function denormMedia(media){
  return (media||[]).map(m=>m.type==='video'?{type:'video',url:m.url,poster:m.poster||''}:m.url);
}

function mapActivity(row){
  try{
    let raw=[];
    if(row.photos){raw=Array.isArray(row.photos)?row.photos:typeof row.photos==='string'?JSON.parse(row.photos):[];}
    let links=[];
    if(row.links){links=Array.isArray(row.links)?row.links:typeof row.links==='string'?JSON.parse(row.links):[];}
    const media=normMedia(raw);
    return{id:row.id,listId:row.collection_id,listIds:[row.collection_id].filter(Boolean),
      name:row.name,
      targetDate:row.target_date||null,priority:row.priority||'medium',links,
      completed:!!row.date_completed,completedDate:row.date_completed||null,
      completionNotes:row.experience_notes||'',
      media,
      /* Images only, in order — what a thumbnail or a map pin wants. A
         video contributes its poster frame if it has one. */
      photos:media.map(m=>m.type==='video'?m.poster:m.url).filter(Boolean),
      location:row.location||'',
      locationLat:row.location_lat||null,locationLng:row.location_lng||null,
      /* Undefined without the column, which reads as false — exactly
         the behaviour we want before supabase/home.sql is run. */
      locationIsHome:row.location_is_home===true,
      /* 'easy' | 'medium' | 'hard', or null — which is what a row
         written before supabase/difficulty.sql looks like, and what an
         activity the model declined to judge looks like too. Nothing
         reads it as a default; the UI simply draws nothing. */
      difficulty:row.difficulty||null,
      remindAt:row.remind_at||null,remindNote:row.reminder_note||'',createdAt:row.created_at};
  }catch(e){console.error('mapActivity error:',e,row);return{id:row.id,listId:row.collection_id,listIds:[row.collection_id].filter(Boolean),name:row.name||'',targetDate:null,priority:'medium',links:[],completed:!!row.date_completed,completedDate:row.date_completed||null,completionNotes:'',media:[],photos:[],location:'',locationLat:null,locationLng:null,locationIsHome:false,difficulty:null,remindAt:null,remindNote:'',createdAt:row.created_at};}
}

/* ==============================================================
   WHICH LIST AN ACTIVITY IS IN

   Exactly one: `collection_id`. There was briefly an
   `extra_collection_ids` array beside it letting one activity sit in
   several lists at once; it is gone, in the app and in the table (see
   supabase/single-list.sql). Everything downstream still reads
   `a.listIds`, which is now a one-element array — keeping the shape
   means the callers that ask "is this activity in that list?" did not
   all have to be rewritten, and `listIds[0]` and `listId` can never
   disagree.

   Back to the storage shape, so every save path splits it the same
   way. */
function listFieldsFor(ids){
  const id=(ids||[]).filter(Boolean)[0];
  return id?{collection_id:id}:null;
}

/* ==============================================================
   REMINDERS CAPABILITY

   remind_at is a column this app added after the fact, and the schema
   lives in someone else's Supabase project — there is no migration step
   here that could guarantee it exists. So probe for it once and let the
   rest of the app ask `remindersReady()` rather than blowing up on an
   insert. Until the column is added the reminder UI simply doesn't
   appear; nothing else is affected.

   To enable it, run this once in the Supabase SQL editor:
     alter table "Activities" add column if not exists remind_at date;
   ============================================================== */
let _remindReady=null;

async function probeRemindColumn(){
  try{
    const{error}=await sb.from('Activities').select('remind_at,reminder_note').limit(1);
    /* 42703 is Postgres "undefined_column". */
    _remindReady=!error;
    if(error) console.info('[reminders] remind_at column not present — reminder UI hidden. '+
      'Run: alter table "Activities" add column if not exists remind_at date;');
  }catch(e){ _remindReady=false; }
  return _remindReady;
}
function remindersReady(){ return _remindReady===true; }

/* ==============================================================
   "THIS ACTIVITY IS AT HOME"

   A boolean on the activity, set only when its location was chosen
   with the Home shortcut. It exists so that changing your home address
   moves the activities that meant *home* and nothing else.

   WHY THIS IS NOT A TEXT MATCH. The obvious implementation is to find
   activities whose `location` equals the old home address and rewrite
   them. That is wrong, and wrong in the worst way this app has:
   silently. If Home is "Denver, Colorado" and the user separately
   searched for and picked Denver for a hike — because the hike is in
   Denver, not because they live there — then moving house to Austin
   would drag the hike to Austin too. Nothing on screen would say so.
   That is the same class of defect as the stale-coordinates bug the
   geoFor contract exists to close, so it is not worth trading a
   migration to avoid.

   The flag records *intent*, which text cannot. Picking Home means "my
   home, whatever that is"; picking a place that happens to be the same
   town means that town, permanently.

   Optional like everything else here — without the column, changing
   your home address updates nothing and the app says so once.
   ============================================================== */
let _homeFlagReady=null;

async function probeHomeFlag(){
  try{
    const{error}=await sb.from('Activities').select('location_is_home').limit(1);
    _homeFlagReady=!error;
    if(error) console.info('[home] no location_is_home column — activities set to Home will not '+
      'follow a change of home address. Run supabase/home.sql.');
  }catch(e){ _homeFlagReady=false; }
  return _homeFlagReady;
}
function homeFlagReady(){ return _homeFlagReady===true; }

/* ==============================================================
   HOW HARD IT IS

   Same shape, same reason: `difficulty` is added by
   supabase/difficulty.sql and the app has to work without it. Probed
   once at sign-in; without the column the value is never sent, so an
   insert cannot fail for anyone who has not run the migration.
   ============================================================== */
let _difficultyReady=null;

async function probeDifficulty(){
  try{
    const{error}=await sb.from('Activities').select('difficulty').limit(1);
    _difficultyReady=!error;
    if(error) console.info('[difficulty] no difficulty column — activities will not be rated '+
      'or sortable by how hard they are. Run supabase/difficulty.sql.');
  }catch(e){ _difficultyReady=false; }
  return _difficultyReady;
}
function difficultyReady(){ return _difficultyReady===true; }

/* ==============================================================
   THE CACHE

   Two queries back the entire app: every collection, and every
   activity in them. Both are held here for the session, so switching
   tabs re-renders from memory instead of going back to the network —
   which is what made moving between screens feel like a page load.

   Rules, in order of importance:

   1. **Any local write must invalidate.** Every mutation site calls
      invalidateActivities() / invalidateCollections(). Miss one and the
      screen renders stale rows until something else happens to refetch.
   2. **In-flight requests are shared.** Home renders four sections from
      the same two fetches, and the old code let them race into four
      duplicate round trips. A pending promise is handed to every caller.
   3. **A failed request is never cached.** An error returns [] as it
      always did, but leaves the cache empty so the next call retries
      rather than pinning an empty list for the session.
   4. **fetchActivitiesFor() filters the shared cache** rather than
      issuing its own query. That is what makes entering a collection
      free — it used to fetch the same rows twice over, since
      renderDetail() and renderActivitiesList() each called it.

   The app is single-user and writes only from this client, so a
   session-length cache is safe. `revalidate()` covers the one case it
   is not: the same account open on another device. It is called when
   the app is foregrounded and when the network comes back.
   ============================================================== */
let _cCollections=null,_cActivities=null;
let _pCollections=null,_pActivities=null;

/* ==============================================================
   THE CACHE BELONGS TO ONE ACCOUNT

   This is a security boundary, not an optimisation, and it is here
   rather than in auth.js on purpose: the cache lives in this file, so
   the check that it is being handed to the right person has to live
   here too. Anything else relies on every present and future sign-in
   path remembering to clear it, and that is exactly what failed.

   WHAT WENT WRONG. Every cache in the app is per-account, but the only
   thing that ever cleared them was the Sign Out button. So any sign-in
   that happened afterwards in the same page load — a new sign-up, a
   different account, or a sign-in after the session had lapsed and
   onAuthStateChange had quietly shown the login screen — was served
   the previous account's rows out of memory. A brand-new account made
   it worse rather than better: it has no disk snapshot, so
   primeFromSnapshot() returned false, so showApp()'s `if(warm)`
   skipped revalidate(), so nothing ever refreshed it. The new account
   saw the old one's lists, activities, notes and photos for the whole
   session.

   It was a client-side leak — RLS still refused every write, and a
   reload cleared it — but the rows were on screen, which is the part
   that matters.

   THE FIX. The cache records whose rows it holds. Every entry point
   that can read or fill it calls this first, and a mismatch wipes
   everything rather than answering. Signing in as someone else can no
   longer show their predecessor's data even if some future code path
   forgets to reset anything at all.

   Note it deliberately does NOT touch the on-disk snapshot: that is
   already keyed by user id (see snapKey in offline.js), and a session
   lapsing on a train is not a reason to destroy someone's offline
   copy. Explicit sign-out still clears it.
   ============================================================== */
let _cacheUserId=null;

function cacheOwnerCheck(){
  const uid=(currentUser&&currentUser.id)||null;
  if(uid===_cacheUserId) return;
  /* Straight to the variables rather than through invalidateAll(): this
     runs on the way into every read, and it must not depend on which
     of the invalidators happens to cover which field. */
  _cCollections=_cActivities=_pCollections=_pActivities=null;
  _collectionsScope=null;
  if(_cacheUserId!==null)
    console.warn('[api] account changed — dropping the cache held for',_cacheUserId);
  _cacheUserId=uid;
}

/* Which scope the cached collections were fetched under: true if RLS
   was doing the scoping (sharing on), false if the client-side user_id
   filter was, null if they came off the disk snapshot and are correct
   by construction.

   probeSharing() reads this. It runs in parallel with the first render
   and used to invalidate unconditionally when it came back true, on
   the assumption that the cache must be holding the narrower
   owned-only set — which forced a second full fetch of both tables on
   every cold launch. Now it can tell the difference. */
let _collectionsScope=null;
function collectionsScope(){return _collectionsScope;}

function invalidateCollections(){_cCollections=null;_pCollections=null;_collectionsScope=null;}
function invalidateActivities(){_cActivities=null;_pActivities=null;}
function invalidateAll(){invalidateCollections();invalidateActivities();}

/* True when a screen can paint without waiting on the network — used to
   skip the spinner, so a cached screen never flashes empty. */
function cacheWarm(){cacheOwnerCheck();return !!(_cCollections&&_cActivities);}

/* Synchronous reads of whatever is already in hand.

   Duplicate detection sits in the middle of the quick-add path, and
   the whole point of that path is that it costs nothing — so it can
   read what is cached but must never wait on a fetch. An empty array
   here means "nothing to compare against", which degrades to the old
   behaviour of adding without checking rather than to a stall. */
function cachedActivities(){cacheOwnerCheck();return _cActivities||[];}
function cachedCollections(){cacheOwnerCheck();return _cCollections||[];}

/* ==============================================================
   PATCHING THE CACHE INSTEAD OF DROPPING IT

   Every mutation used to end with invalidateActivities(), which meant
   the re-render that followed it went back to the network for the
   whole table — a full select over every activity, photos included,
   to reflect one row the client had just written and already knew the
   final shape of.

   applyOp() in js/offline.js has to compute the new row set anyway,
   for the on-disk snapshot. These take that same result and re-derive
   the in-memory cache from it, so a completion or an edit redraws
   from memory with no round trip at all.

   Two rules:

   1. Raw PostgREST rows in, exactly as the snapshot holds them, so
      mapActivity()/mapCollection() stay the only thing that knows
      column names. Handing these mapped rows would fork that.
   2. **A cold cache is left cold.** If nothing has been fetched yet
      there is nothing to keep in step, and priming it here would make
      cacheWarm() true off the back of a single write — telling every
      screen it can skip its spinner when the rows have never been
      loaded. Falling through to the invalidate is a no-op in that
      case, which is the correct answer.
   ============================================================== */
function primeActivities(rawRows){
  cacheOwnerCheck();
  if(!_cActivities||!Array.isArray(rawRows)) return false;
  /* Scoped to the collections actually visible, the same way
     fetchAllActivities() scopes its own result — the snapshot can
     outlive a list being deleted or left. */
  const ids=new Set((_cCollections||[]).map(c=>c.id));
  _cActivities=rawRows.filter(r=>!ids.size||rowInAnyList(r,ids)).map(mapActivity);
  _pActivities=null;
  return true;
}
function primeCollections(rawRows){
  cacheOwnerCheck();
  if(!_cCollections||!Array.isArray(rawRows)) return false;
  _cCollections=rawRows.map(mapCollection);
  _pCollections=null;
  return true;
}

/* ==============================================================
   PAINTING BEFORE THE NETWORK ANSWERS

   Used once, at boot. readRows() only reaches for the on-disk
   snapshot when the network cannot answer, which is right for a
   single fetch but wrong for a cold launch: a complete copy of the
   user's data is sitting in IndexedDB and the app was waiting on two
   serialised round trips before drawing anything.

   So Home paints from disk and revalidate() refreshes behind it.
   Returns false when there is no snapshot — a genuinely first-ever
   launch, which still has to wait.
   ============================================================== */
async function primeFromSnapshot(){
  if(!currentUser) return false;
  cacheOwnerCheck();
  try{
    const[cols,acts]=await Promise.all([
      snapshotLoad('collections'),
      snapshotLoad('activities'),
    ]);
    if(!cols||!cols.length) return false;
    _cCollections=cols.map(mapCollection);
    const ids=new Set(_cCollections.map(c=>c.id));
    _cActivities=(acts||[]).filter(r=>rowInAnyList(r,ids)).map(mapActivity);
    return true;
  }catch(e){
    console.warn('primeFromSnapshot:',e);
    return false;
  }
}

/* ==============================================================
   READING A TABLE

   One helper behind both fetches, because both need the same
   three-way answer:

     online + ok      use it, and write it to the offline snapshot
     offline          read the snapshot; never touch the network, so
                      a tunnel costs nothing rather than a timeout
     online + failed  fall back to the snapshot too. A request that
                      fails while navigator.onLine is true is the
                      common case on a bad connection, and it is
                      exactly when showing the last known rows beats
                      showing none.

   `null` means "genuinely nothing to show" and stays uncached, so
   the next call retries — rule 3 of the cache, unchanged.
   ============================================================== */
/* Only the columns something actually reads, never select('*').

   `Activities.description` is dead (see CLAUDE.md, Back end) and can
   hold a paragraph on every row; `category_tag` and the two
   denormalised count columns are unread. Pulling them on every launch,
   every foreground and every reconnect was real egress for nothing.

   ⚠️ The optional columns cannot be gated on their probes: those fire
   un-awaited from showApp() and the first fetch races them, so a cold
   launch would silently omit remind_at / location_is_home / difficulty
   and reminders would vanish from the first paint. They are asked for
   unconditionally instead, and a PostgREST 400 for a column that does
   not exist falls back to the core list — remembered per kind, so the
   failure costs one extra request per session and not one per fetch. */
const SELECT_FULL={
  collections:'id,created_at,name,description,cover_image,user_id',
  activities:'id,created_at,collection_id,name,target_date,priority,date_completed,'+
             'experience_notes,photos,links,location,location_lat,location_lng,'+
             'remind_at,reminder_note,location_is_home,difficulty'
};
const SELECT_CORE={
  collections:SELECT_FULL.collections,
  activities:'id,created_at,collection_id,name,target_date,priority,date_completed,'+
             'experience_notes,photos,links,location,location_lat,location_lng'
};
const _selectNarrow={};
function selectCols(kind){
  return (_selectNarrow[kind]?SELECT_CORE:SELECT_FULL)[kind]||'*';
}
/* A missing column is a 42703 / "column ... does not exist" 400. Anything
   else (a network drop, RLS) must NOT narrow the select, or one bad
   connection would cost the session its optional columns. */
function isMissingColumn(e){
  const m=((e&&(e.code||''))+' '+(e&&e.message||'')).toLowerCase();
  return m.includes('42703')||m.includes('does not exist');
}

async function readRows(kind,table,build){
  if(navigator.onLine){
    try{
      let{data,error}=await build(sb.from(table).select(selectCols(kind)));
      if(error&&isMissingColumn(error)&&!_selectNarrow[kind]){
        _selectNarrow[kind]=true;
        console.info('readRows('+table+'): optional column missing, narrowing select');
        ({data,error}=await build(sb.from(table).select(selectCols(kind))));
      }
      if(error)throw error;
      /* Persisting is not allowed to hold up the render. */
      snapshotSave(kind,data);
      return data;
    }catch(e){
      console.warn('readRows('+table+') falling back to cache:',e);
    }
  }
  const rows=await snapshotLoad(kind);
  if(rows) return rows;
  return null;
}

async function fetchCollections(){
  if(!currentUser)return[];
  cacheOwnerCheck();
  if(_cCollections)return _cCollections;
  if(_pCollections)return _pCollections;
  const shared=sharingReady();
  _pCollections=(async()=>{
    const rows=await readRows('collections','Collections',q=>
      /* With shared lists enabled the visible set is owned + joined,
         and RLS is what decides it — so the client-side owner filter
         has to come off or a shared list is fetched and then thrown
         away. Without sharing, the filter stays exactly as it was.
         Neither is a security boundary; RLS is. See js/sharing.js. */
      shared
        ? q.order('created_at',{ascending:false})
        : q.eq('user_id',currentUser.id).order('created_at',{ascending:false}));
    _pCollections=null;
    if(!rows) return [];
    _cCollections=rows.map(mapCollection);
    _collectionsScope=shared;
    return _cCollections;
  })();
  return _pCollections;
}

/* Is this raw row in any list the user can currently see?

   The client-side counterpart of the RLS policy, and it has to exist
   even where RLS is doing the scoping: it is also what
   filters the *snapshot*, which has no policies on it at all and can
   outlive a collection being deleted or left. */
function rowInAnyList(row,idSet){
  return idSet.has(row.collection_id);
}

async function fetchAllActivities(collections){
  cacheOwnerCheck();
  if(_cActivities)return _cActivities;
  if(_pActivities)return _pActivities;
  _pActivities=(async()=>{
    const cols=collections||await fetchCollections();
    if(!cols.length){_pActivities=null;_cActivities=[];return _cActivities;}
    const ids=cols.map(c=>c.id);
    const idSet=new Set(ids);
    const rows=await readRows('activities','Activities',q=>q.in('collection_id',ids));
    _pActivities=null;
    if(!rows) return [];
    _cActivities=rows.filter(r=>rowInAnyList(r,idSet)).map(mapActivity);
    return _cActivities;
  })();
  return _pActivities;
}

/* One collection's activities, oldest first — the order the detail
   screen's query used to return. Filtered from the shared cache.

   Matches through listIds rather than comparing collection_id, so the
   one place that decides what "in this list" means is mapActivity(). */
async function fetchActivitiesFor(collectionId){
  /* One of the three derived lists — its membership is a difficulty
     rating, not a collection_id. See js/smartlists.js. */
  if(isSmartList(collectionId)) return smartActivitiesFor(collectionId);
  const all=await fetchAllActivities();
  return all.filter(a=>a.listIds.includes(collectionId))
            .sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
}

/* Both of these go through the shared cache rather than straight to a
   single-row query. That is what makes them work offline — the cache
   is snapshot-backed — and it also means a row created offline, which
   exists nowhere but the snapshot, is findable by id like any other. */
async function fetchActivity(id){
  const all=await fetchAllActivities();
  const hit=all.find(a=>a.id===id);
  if(hit)return hit;
  if(!navigator.onLine)return null;
  const{data,error}=await sb.from('Activities').select('*').eq('id',id).single();
  if(error){console.warn('fetchActivity:',error);return null;}
  return mapActivity(data);
}
async function fetchCollection(id){
  /* Synthesised rather than fetched: there is no row behind it, and
     fetchCollections() deliberately never returns one — which is what
     makes a smart list impossible to file an activity into. */
  if(isSmartList(id)) return smartCollection(smartTier(id));
  const all=await fetchCollections();
  const hit=all.find(c=>c.id===id);
  if(hit)return hit;
  if(!navigator.onLine)return null;
  const{data,error}=await sb.from('Collections').select('*').eq('id',id).single();
  if(error){console.warn('fetchCollection:',error);return null;}
  return mapCollection(data);
}

/* ==============================================================
   COLLECTION STATS — OFF THE CRITICAL PATH

   number_activities / activites_completed are written but never read:
   every count the UI shows is derived client-side from the fetched
   activities. They are denormalised columns waiting for a use.

   They were nonetheless costing two serialised round trips on **every
   single mutation** — a select to recount, an update to store it —
   both awaited before the screen was allowed to redraw. Completing one
   activity was five round trips end to end, three of which existed to
   maintain numbers nothing displays.

   So this no longer blocks. It returns immediately, does the work
   detached, and coalesces repeated calls for the same collection so
   ticking off five things in a row is one recount rather than five.
   Callers can keep awaiting it; there is just nothing to wait for.

   It also no longer calls invalidateCollections(). That was the fourth
   round trip: dropping the collections cache to reflect a column no
   screen reads forced the very next render to refetch the whole table.
   ============================================================== */
const STATS_DEBOUNCE_MS=1200;
let _statsTimers={};

function updateCollectionStats(collectionId){
  /* When there is no network there is nothing to gain by queueing this:
     it would put a round trip's worth of ops in the sync queue for a
     number nothing displays, and it is recomputed from scratch the next
     time this runs online anyway. */
  if(!collectionId||!navigator.onLine) return Promise.resolve();

  clearTimeout(_statsTimers[collectionId]);
  _statsTimers[collectionId]=setTimeout(()=>{
    delete _statsTimers[collectionId];
    recountCollection(collectionId).catch(e=>console.warn('updateCollectionStats:',e));
  },STATS_DEBOUNCE_MS);

  return Promise.resolve();
}

/* Sign-out drops anything still pending. A recount that fires after the
   session has gone is a guaranteed 401, and it belongs to an account
   that is no longer signed in. */
function cancelPendingStats(){
  Object.values(_statsTimers).forEach(clearTimeout);
  _statsTimers={};
}

async function recountCollection(collectionId){
  /* Stats are derived from rows that have just changed, so read past
     the cache rather than depending on when the caller invalidated. */
  const{data,error}=await sb.from('Activities').select('id,date_completed')
    .eq('collection_id',collectionId);
  if(error){console.warn('recountCollection:',error);return;}
  await sb.from('Collections').update({
    number_activities:data.length,
    activites_completed:data.filter(r=>r.date_completed).length
  }).eq('id',collectionId);
}

/* Drop everything and pull fresh. Used when the app comes back to the
   foreground or the network returns, where another device may have
   written since the cache was filled.

   Anything queued goes FIRST. Refetching with unsent writes still in
   the queue would overwrite the local snapshot with server rows that
   do not have them yet — the user would watch their offline additions
   vanish, and then reappear a moment later when the flush landed. */
/* How often a foreground or a reconnect is allowed to refetch both
   tables. It used to be every time, and an app that is foregrounded a
   dozen times an afternoon re-downloaded the whole library a dozen
   times — which is most of where the egress went. Five minutes is well
   under how often somebody else's edit needs to show up, and the write
   that would matter most (this device's own) is applied to the cache
   locally anyway.

   The queue flush is deliberately OUTSIDE the throttle: a queued write
   must sync the moment the network is back, whatever the refetch does. */
const REVALIDATE_MS=5*60*1000;
let _lastRevalidate=0;
function resetRevalidateThrottle(){ _lastRevalidate=0; }

async function revalidate(force){
  if(!currentUser)return;
  await flushQueue();
  if(!force&&Date.now()-_lastRevalidate<REVALIDATE_MS)return;
  _lastRevalidate=Date.now();
  invalidateAll();
  const lists=await fetchCollections();
  await fetchAllActivities(lists);
}
