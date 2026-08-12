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
function mapActivity(row){
  try{
    let photos=[];
    if(row.photos){photos=Array.isArray(row.photos)?row.photos:typeof row.photos==='string'?JSON.parse(row.photos):[];}
    let links=[];
    if(row.links){links=Array.isArray(row.links)?row.links:typeof row.links==='string'?JSON.parse(row.links):[];}
    return{id:row.id,listId:row.collection_id,name:row.name,description:row.description||'',
      targetDate:row.target_date||null,priority:row.priority||'medium',links,
      completed:!!row.date_completed,completedDate:row.date_completed||null,
      completionNotes:row.experience_notes||'',photos,location:row.location||'',
      locationLat:row.location_lat||null,locationLng:row.location_lng||null,
      remindAt:row.remind_at||null,remindNote:row.reminder_note||'',createdAt:row.created_at};
  }catch(e){console.error('mapActivity error:',e,row);return{id:row.id,listId:row.collection_id,name:row.name||'',description:'',targetDate:null,priority:'medium',links:[],completed:!!row.date_completed,completedDate:row.date_completed||null,completionNotes:'',photos:[],location:'',locationLat:null,locationLng:null,remindAt:null,remindNote:'',createdAt:row.created_at};}
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

async function fetchCollections(){
  if(!currentUser)return[];
  const{data,error}=await sb.from('Collections').select('*').eq('user_id',currentUser.id).order('created_at',{ascending:false});
  if(error){console.error('fetchCollections:',error);return[];}
  return data.map(mapCollection);
}
async function fetchActivitiesFor(collectionId){
  const{data,error}=await sb.from('Activities').select('*').eq('collection_id',collectionId).order('created_at',{ascending:true});
  if(error){console.error('fetchActivities:',error);return[];}
  return data.map(mapActivity);
}
async function fetchAllActivities(collections){
  if(!collections) collections=await fetchCollections();
  if(!collections.length)return[];
  const ids=collections.map(c=>c.id);
  const{data,error}=await sb.from('Activities').select('*').in('collection_id',ids);
  if(error){console.error('fetchAllActivities:',error);return[];}
  return data.map(mapActivity);
}
async function fetchActivity(id){
  const{data,error}=await sb.from('Activities').select('*').eq('id',id).single();
  if(error){console.error('fetchActivity:',error);return null;}
  return mapActivity(data);
}
async function fetchCollection(id){
  const{data,error}=await sb.from('Collections').select('*').eq('id',id).single();
  if(error){console.error('fetchCollection:',error);return null;}
  return mapCollection(data);
}
async function updateCollectionStats(collectionId){
  const acts=await fetchActivitiesFor(collectionId);
  await sb.from('Collections').update({
    number_activities:acts.length,
    activites_completed:acts.filter(a=>a.completed).length
  }).eq('id',collectionId);
}
