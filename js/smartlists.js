/* ==============================================================
   THREE LISTS NOBODY EDITS

   Easy, Medium and Hard — one per difficulty tier, on every account,
   there to be browsed when you want an idea rather than a plan:
   "what could I actually do this weekend" is a different question
   from "what is in my Japan list", and nothing answered it.

   ---- They are not rows, and that is the whole design ----

   The obvious build is three real Collections seeded per user and kept
   in step by something that re-files an activity whenever its rating
   changes. That would need an activity to be in two lists at once —
   its own, and its difficulty's — which is exactly the
   `extra_collection_ids` membership the app deliberately removed (see
   ONE ACTIVITY, ONE LIST in api.js). It would also need a backfill, a
   migration, a maintenance job, and a way for all three to drift.

   So these are derived, the same way Home is derived: the list *is*
   the query. An activity's rating is its membership, so there is
   nothing to sync, nothing to seed, nothing to backfill, and the AI
   "filing" it into the right one is just the rating it already wrote
   at capture. Rename the tiers and the lists rename themselves.

   ---- Read-only by construction, not by permission ----

   There is no rule anywhere saying the user may not add to these.
   There is simply nowhere to add: `fetchCollections()` never returns
   them, and that is the one function the list picker, the composers,
   the FAB and every save path read. A destination that is not in that
   array cannot be chosen, so "you cannot add to it" needs no check and
   cannot be forgotten at a new call site.

   What the detail screen suppresses on top of that — the FAB, the
   composer, Edit/Delete/Share — is about not offering controls that
   would do nothing. The activities themselves stay fully live: tap one
   and it opens, complete it, edit it, and it is the same row it is
   everywhere else.
   ============================================================== */

/* Sentinel ids. `smart:` cannot collide with a uuid, so anything
   holding a collection id can carry one of these without a second
   field to say which kind it is — and isUuid() in offline.js rejects
   it outright if one ever reaches a write. */
const SMART_PREFIX='smart:';

/* Order is easiest first, matching the Difficulty sort. The cover is
   pinned per tier rather than derived by coverFor(): these three sit
   together on the Lists tab as a set, and a random-looking trio reads
   as three unrelated lists that happen to be adjacent. */
const SMART_LISTS=[
  {tier:'easy',   name:'Easy',   cover:COVERS[3]},
  {tier:'medium', name:'Medium', cover:COVERS[6]},
  {tier:'hard',   name:'Hard',   cover:COVERS[1]},
];

function isSmartList(id){ return typeof id==='string'&&id.startsWith(SMART_PREFIX); }
function smartTier(id){ return isSmartList(id)?id.slice(SMART_PREFIX.length):''; }

/* The same shape mapCollection() returns, so every reader downstream —
   the banner, the nav title, coverFor(), activityListLabel() — works
   without knowing this is not a row. `smart:true` is the one addition,
   and it is what the read-only checks test rather than re-parsing the
   id. */
function smartCollection(tier){
  const def=SMART_LISTS.find(s=>s.tier===tier);
  if(!def) return null;
  return {id:SMART_PREFIX+tier,name:def.name,description:'',cover:def.cover,
          userId:currentUser?currentUser.id:null,createdAt:'',smart:true};
}
function smartCollections(){ return SMART_LISTS.map(s=>smartCollection(s.tier)); }

/* Un-rated activities are in none of the three. That is deliberate and
   is the same rule the Difficulty sort follows: the model has said
   nothing about them, and a row nobody judged does not belong in a
   list of easy wins. */
async function smartActivitiesFor(id){
  const tier=smartTier(id);
  const all=await fetchAllActivities();
  return all.filter(a=>a.difficulty===tier)
            .sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
}

/* The three cards on the Lists tab. Drawn after the user's own lists
   and before New List: they are a fixture, not something the user
   made, so they do not lead. */
function smartCardsHTML(allActs){
  return smartCollections().map(l=>{
    const tier=smartTier(l.id);
    const acts=allActs.filter(a=>a.difficulty===tier);
    const total=acts.length,done=acts.filter(a=>a.completed).length;
    const pct=total?Math.round(done/total*100):0;
    return `<button class="coll-card" onclick="nav('detail','${l.id}')">
      <img class="coll-card-img" src="${esc(l.cover)}" alt="" loading="lazy"/>
      <div class="coll-card-scrim"></div>
      <div class="coll-card-auto" title="Kept up to date automatically"
           aria-label="Kept up to date automatically">${icon('sparkle','ic-xs')}</div>
      <div class="coll-card-body">
        <div class="coll-card-title">${esc(l.name)}</div>
        <div class="coll-card-meta">
          <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span>${done}/${total}</span>
        </div>
      </div>
    </button>`;
  }).join('');
}

/* The ⋯ menu on a smart list. The view switcher is the only thing on
   it that means anything — Edit, Delete, Share and the conversation
   all act on a row that does not exist. */
function openSmartListMenu(){
  showActionSheet({items:[
    {label:'List',  icon:'rows',        checked:curView==='list', onSelect:()=>setView('list')},
    {label:'Grid',  icon:'square-grid', checked:curView==='grid', onSelect:()=>setView('grid')},
    {label:'Map',   icon:'map',         checked:curView==='map',  onSelect:()=>setView('map')},
  ]});
}
