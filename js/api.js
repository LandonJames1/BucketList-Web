/* ==============================================================
   API — all Supabase reads/writes for collections + activities
   Row mappers translate snake_case DB columns into the camelCase
   shapes the rest of the app expects.
   ============================================================== */

function mapCollection(row){
  try{
    return{id:row.id,name:row.name,description:row.description||'',cover:row.cover_image||'',createdAt:row.created_at};
  }catch(e){console.error('mapCollection error:',e,row);return{id:row.id,name:row.name||'',description:'',cover:'',createdAt:row.created_at};}
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
    return{id:row.id,listId:row.collection_id,name:row.name,description:row.description||'',
      targetDate:row.target_date||null,priority:row.priority||'medium',links,
      completed:!!row.date_completed,completedDate:row.date_completed||null,
      completionNotes:row.experience_notes||'',
      media,
      /* Images only, in order — what a thumbnail or a map pin wants. A
         video contributes its poster frame if it has one. */
      photos:media.map(m=>m.type==='video'?m.poster:m.url).filter(Boolean),
      location:row.location||'',
      locationLat:row.location_lat||null,locationLng:row.location_lng||null,
      remindAt:row.remind_at||null,remindNote:row.reminder_note||'',createdAt:row.created_at};
  }catch(e){console.error('mapActivity error:',e,row);return{id:row.id,listId:row.collection_id,name:row.name||'',description:'',targetDate:null,priority:'medium',links:[],completed:!!row.date_completed,completedDate:row.date_completed||null,completionNotes:'',media:[],photos:[],location:'',locationLat:null,locationLng:null,remindAt:null,remindNote:'',createdAt:row.created_at};}
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

function invalidateCollections(){_cCollections=null;_pCollections=null;}
function invalidateActivities(){_cActivities=null;_pActivities=null;}
function invalidateAll(){invalidateCollections();invalidateActivities();}

/* True when a screen can paint without waiting on the network — used to
   skip the spinner, so a cached screen never flashes empty. */
function cacheWarm(){return !!(_cCollections&&_cActivities);}

async function fetchCollections(){
  if(!currentUser)return[];
  if(_cCollections)return _cCollections;
  if(_pCollections)return _pCollections;
  _pCollections=(async()=>{
    const{data,error}=await sb.from('Collections').select('*')
      .eq('user_id',currentUser.id).order('created_at',{ascending:false});
    _pCollections=null;
    if(error){console.error('fetchCollections:',error);return[];}
    _cCollections=data.map(mapCollection);
    return _cCollections;
  })();
  return _pCollections;
}

async function fetchAllActivities(collections){
  if(_cActivities)return _cActivities;
  if(_pActivities)return _pActivities;
  _pActivities=(async()=>{
    const cols=collections||await fetchCollections();
    if(!cols.length){_pActivities=null;_cActivities=[];return _cActivities;}
    const{data,error}=await sb.from('Activities').select('*')
      .in('collection_id',cols.map(c=>c.id));
    _pActivities=null;
    if(error){console.error('fetchAllActivities:',error);return[];}
    _cActivities=data.map(mapActivity);
    return _cActivities;
  })();
  return _pActivities;
}

/* One collection's activities, oldest first — the order the detail
   screen's query used to return. Filtered from the shared cache. */
async function fetchActivitiesFor(collectionId){
  const all=await fetchAllActivities();
  return all.filter(a=>a.listId===collectionId)
            .sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
}

async function fetchActivity(id){
  if(_cActivities){
    const hit=_cActivities.find(a=>a.id===id);
    if(hit)return hit;
  }
  const{data,error}=await sb.from('Activities').select('*').eq('id',id).single();
  if(error){console.error('fetchActivity:',error);return null;}
  return mapActivity(data);
}
async function fetchCollection(id){
  if(_cCollections){
    const hit=_cCollections.find(c=>c.id===id);
    if(hit)return hit;
  }
  const{data,error}=await sb.from('Collections').select('*').eq('id',id).single();
  if(error){console.error('fetchCollection:',error);return null;}
  return mapCollection(data);
}

async function updateCollectionStats(collectionId){
  if(!collectionId)return;
  /* Stats are derived from rows that have just changed, so read past the
     cache — the caller invalidates around this, but the order in which
     they do it is not something this function should depend on. */
  const{data,error}=await sb.from('Activities').select('id,date_completed')
    .eq('collection_id',collectionId);
  if(error){console.error('updateCollectionStats:',error);return;}
  await sb.from('Collections').update({
    number_activities:data.length,
    activites_completed:data.filter(r=>r.date_completed).length
  }).eq('id',collectionId);
  invalidateCollections();
}

/* Drop everything and pull fresh. Used when the app comes back to the
   foreground or the network returns, where another device may have
   written since the cache was filled. */
async function revalidate(){
  if(!currentUser)return;
  invalidateAll();
  const lists=await fetchCollections();
  await fetchAllActivities(lists);
}
