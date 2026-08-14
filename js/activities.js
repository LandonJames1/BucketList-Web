/* ==============================================================
   ACTIVITIES — the add / complete / edit / delete flows.

   Two speeds, deliberately:
     - Quick:  type a name in the composer and press return;
               tap the circle to complete. No sheet either way.
     - Full:   the activity sheet, for when details matter.
   ============================================================== */

/* ==============================================================
   QUICK ADD  (composer → insert with just a name)
   ============================================================== */
/* The composer is a way to START an activity, not a way to file one.

   Nothing anywhere in the app inserts an activity without showing this
   sheet first. That is a deliberate reversal: the composer used to
   insert on Return with only a name, which was the fastest path in the
   app and also the one that produced its worst rows — no priority, no
   real target date, no location, so the thing never surfaced in Up Next
   and never appeared on the map. An idea captured into a hole is not
   captured.

   Nothing on the sheet is required beyond the name, so this still costs
   one extra tap (Save) rather than any actual filling-in — but the
   fields are in front of the user at the one moment they are thinking
   about the thing, which is the only moment they will ever bother.

   The duplicate check lives in saveActivity(), so there is none here —
   checking twice would ask the same question on the way in and on the
   way out. */
function quickAddActivity(){
  const input=$('composerInput');
  if(!input)return;
  const name=input.value.trim();
  if(!name){shakeEl(input);return;}
  /* Cleared before the sheet opens: the name lives in the sheet from
     here on, and leaving a copy behind means it can be filed twice. */
  input.value='';
  onComposerInput();
  openNewActivity(name);
}

/* ==============================================================
   ONE-TAP COMPLETE
   Toggling only writes date_completed, so un-completing never
   destroys the notes and photos attached to a past completion —
   re-completing brings them straight back.
   ============================================================== */
async function toggleComplete(id,isDone){
  /* Completing asks for the date first — the activity is not marked
     accomplished until that sheet is saved, so cancelling leaves it
     alone rather than filing it under a guess. Un-completing is still
     immediate: there is nothing to ask.

     The source is deliberately not hardcoded here. This is reachable
     from the activity sheet, which opens over *any* screen, so pinning
     it to 'detail' redrew the collection page while the user was
     looking at Up Next. */
  if(!isDone){ openCompletedDate(id); return; }
  const a=await fetchActivity(id);
  const{error}=await dbUpdate('Activities',{date_completed:null},{id});
  if(error){
    console.error('toggleComplete:',error);
    showToast(error.message||'Couldn’t update that.');
    return;
  }
  await updateCollectionStats((a&&a.listId)||curListId);
  await refreshAfterChange();
}

/* ==============================================================
   COMPLETING SOMETHING

   One sheet does the whole job, and every field is on it: the name,
   the date, where it happened, the photos and video, and how it went.

   It used to be two sheets. A date-only sheet completed the activity,
   and attaching anything to it meant closing that, reopening the
   activity, and finding "Add photos & notes" three taps down. The
   moment you have the photos is the moment you tick the thing off, so
   they belong in the same sheet.

   The photos and notes then spent a while behind a disclosure on this
   sheet, which was the same mistake one level in — the collapsed half
   held the single thing people most want to attach, and a collapsed
   field is one most people never open. It is all on screen now. That
   costs the two-tap flow nothing: check, then Done, still works
   without touching anything in between.

   Nothing is written until Save, so an accidental tap still costs a
   Cancel rather than a wrong date to find later.
   ============================================================== */
let compId=null,compSrc=null,compList=null,compNew=false;

async function openComp(id,source){
  const a=await fetchActivity(id);
  if(!a)return;
  compId=id;
  compSrc=source||curPage;
  compList=a.listId;
  compNew=!a.completed;
  upMedia=[...(a.media||[])];

  $('compName').value=a.name;
  /* Defaults to the stored date, or today for anything completed
     before the app recorded one. */
  $('compDate').value=a.completedDate||todayISO();
  $('compDate').max=todayISO();          /* you cannot have done it yet */
  $('compLoc').value=a.location||'';
  $('compLocLat').value=a.locationLat||'';
  $('compLocLng').value=a.locationLng||'';
  $('compNotes').value=a.completionNotes||'';
  /* Clear any chip left over from the last activity completed this
     session, and un-stick a dismissal so it can be offered again for
     this one. See suggestLocationFromPhoto() in js/media.js. */
  resetLocationSuggestion();
  renderThumbs();

  $('compSheetTitle').textContent=compNew?'Accomplished':'Edit';
  $('compSaveBtn').textContent=compNew?'Done':'Save';
  openModal('compSheet');
}

/* The name the check button and the date pill call. Completing and
   correcting a date are the same sheet now. */
function openCompletedDate(id,source){ return openComp(id,source); }

/* Opened *from* the activity sheet, which is the only place both the
   Edit button and the date pill live. Registering the return before
   opening means every way out of the edit sheet — Save, Cancel, the
   scrim, Escape, a swipe down — lands you back where you started rather
   than on the bare page behind it. */
function openCompFrom(id){
  closeModal('actDetailSheet');
  onSheetClose('compSheet',()=>openActDetail(id));
  return openComp(id);
}

async function confirmComplete(){
  if(!compId)return;
  const name=$('compName').value.trim();
  if(!name){shakeEl($('compName'));$('compName').focus();return;}
  const btn=$('compSaveBtn');btn.disabled=true;
  const{error,offline}=await dbUpdate('Activities',{
    name,
    date_completed:$('compDate').value||todayISO(),
    location:$('compLoc').value.trim()||null,
    location_lat:parseFloat($('compLocLat').value)||null,
    location_lng:parseFloat($('compLocLng').value)||null,
    experience_notes:$('compNotes').value.trim()||null,
    photos:denormMedia(upMedia)
  },{id:compId});
  btn.disabled=false;
  if(error){
    console.error('confirmComplete:',error);
    showToast(error.message||'Couldn’t save.');
    return;
  }
  const wasNew=compNew,src=compSrc,list=compList;
  closeModal('compSheet');
  compId=null;
  await updateCollectionStats(list||curListId);
  if(wasNew){ confetti(); showToast(offline?'Accomplished — will sync later':'Accomplished'); }
  else showToast(offline?'Saved — will sync later':'Saved');
  refreshAfterChange(src);
}

/* ==============================================================
   FULL ACTIVITY SHEET (create / edit)

   Every field is on screen at once. There used to be a "More options"
   disclosure holding notes and links; it went the way of the one that
   used to hold Location, and for the same reason — a field nobody
   opens is a field nobody fills in. Target date and list share a line
   (.fg-pair), which is what buys the room for that.
   ============================================================== */
/* Where the activity being edited will be filed, in order — the first
   entry is its home list. Inside a collection that starts as just that
   collection; opened from Home it is whatever the user picks in the
   sheet's List row.

   An array rather than a single id because an activity can belong to
   any number of lists (supabase/multilist.sql). `targetListId` is kept
   as a read-only alias for the home list, since that is the one thing
   most of the code around here wants.

   Without the migration the picker stays single-select and this never
   holds more than one id, so every path through it is the path it was
   before. */
let targetListIds=[],targetListId=null;

function setTargetLists(ids){
  targetListIds=(ids||[]).filter(Boolean).filter((id,i,a)=>a.indexOf(id)===i);
  targetListId=targetListIds[0]||null;
}

async function openNewActivity(prefillName){
  editingActId=null;aLinks=[];
  setTargetLists(curListId?[curListId]:[]);
  await renderActListPicker();
  $('aName').value=prefillName||'';
  $('aDesc').value='';$('aLoc').value='';$('aLocLat').value='';$('aLocLng').value='';
  resetLocationGuess(true);
  resetDateOptions();
  $('aDate').value=DEFAULT_TARGET_DATE;
  setPriorityChoice('medium');
  $('aDateCustom').value='';onTargetDateChange();
  renderTagChips('aLinks');
  setRemindField(null,'');
  $('actSheetTitle').textContent='New Activity';
  $('actSaveBtn').textContent='Add';
  openModal('actSheet');
  /* A name that arrived from a composer was never typed into this
     field, so `change` will not fire for it — and that is the most
     common way an activity is created. Ask now instead. Deliberately
     not awaited: the sheet is usable while the answer is in flight,
     and the fill lands in an empty field if it lands at all. */
  if(prefillName) maybeGuessLocation();
  setTimeout(()=>$('aName').focus(),320);
}
async function openEditAct(id){
  const a=await fetchActivity(id);if(!a)return;
  editingActId=id;
  setTargetLists(a.listIds&&a.listIds.length?a.listIds:[a.listId]);
  await renderActListPicker();
  $('aName').value=a.name;$('aDesc').value=a.description||'';
  $('aLoc').value=a.location||'';$('aLocLat').value=a.locationLat||'';$('aLocLng').value=a.locationLng||'';
  resetLocationGuess(false);
  /* An activity saved before "Someday"/"No date" were retired still
     carries that value. Put it back as an option for this one row, so
     opening the sheet and hitting Save cannot silently change the
     user's data — but keep it off the menu for everything else. */
  resetDateOptions();
  if(isCustomDate(a.targetDate)){
    $('aDate').value=CUSTOM_DATE;
    $('aDateCustom').value=a.targetDate;
  } else {
    if(a.targetDate&&!dateOptionExists(a.targetDate)) addLegacyDateOption(a.targetDate);
    $('aDate').value=a.targetDate||DEFAULT_TARGET_DATE;
    $('aDateCustom').value='';
  }
  onTargetDateChange();
  setPriorityChoice(a.priority||'medium');
  aLinks=[...(a.links||[])];
  renderTagChips('aLinks');
  setRemindField(a.remindAt,a.remindNote);
  $('actSheetTitle').textContent='Edit Activity';
  $('actSaveBtn').textContent='Save';
  openModal('actSheet');
}
/* The List row only appears when there is a choice to make: editing an
   existing activity, or creating one from outside a collection.

   It goes multi-select once the schema can hold more than one list —
   the label then reads "Lists" and the value "Kyoto +2". The single
   select is not a fallback that was left lying around: without
   extra_collection_ids there is genuinely one choice to make, and a
   sheet offering a multi-select that silently keeps only the first
   answer would be worse than not offering it. */
async function renderActListPicker(){
  const row=$('actListRow');
  if(!row)return;
  const lists=await fetchCollections();
  if(!lists.length){row.style.display='none';return;}
  row.style.display='';

  /* Anything the activity was in that this user can no longer see — a
     shared list they left — is dropped rather than shown as a blank
     row, and would otherwise be written straight back on Save. */
  const known=new Set(lists.map(l=>l.id));
  setTargetLists(targetListIds.filter(id=>known.has(id)));
  if(!targetListIds.length) setTargetLists([lists[0].id]);

  const multi=multiListReady();
  $('actListLabel').textContent=multi?'Lists':'List';
  renderActListValue(lists);

  /* The handler goes on the button, not on the .fg around it: the group
     also holds the label, and tapping a label should do nothing. */
  $('actListBtn').onclick=()=>openListPicker({
    multi,
    title:multi?'Lists':'Add to List',
    /* .lp-sub is a single ellipsised line by design, so this has to be
       short. The Done button and the checkmarks already say it is
       multi-select, and the HOME badge explains itself — all the
       subtitle has to add is that more than one is allowed. */
    subtitle:multi?'Pick as many lists as you like.':'',
    currentId:targetListId,
    currentIds:targetListIds,
    onPick:picked=>{
      setTargetLists(Array.isArray(picked)?picked:[picked]);
      if(!targetListIds.length) setTargetLists([lists[0].id]);
      renderActListValue(lists);
    },
  });
}

/* One list is named; several are counted.

   "Kyoto Trip +2" was here first and it was wrong in the one place it
   mattered: this row is half of a .fg-pair, so on a 320px screen it
   has room for about ten characters, and what got ellipsised away was
   the "+2" — the only part saying anything the user did not already
   know. "3 lists" always fits, never truncates, and matches what the
   activity sheet's own section says ("In 3 lists"). Which three is one
   tap away, in the picker this row opens. */
function renderActListValue(lists){
  const n=targetListIds.length;
  if(n>1){ $('actListName').textContent=`${n} lists`; return; }
  const home=lists.find(l=>l.id===targetListId);
  $('actListName').textContent=home?home.name:'Choose';
}

/* Target dates offered to new activities. Retired values live only in
   existing rows — see addLegacyDateOption. */
const DEFAULT_TARGET_DATE='This Year';
const CUSTOM_DATE='__custom__';   /* sentinel; never stored */
const LEGACY_DATE_LABELS={'Before I Die':'Someday','':'No date'};

/* Show the date field only when "on a specific date" is chosen. */
function onTargetDateChange(){
  const custom=$('aDate').value===CUSTOM_DATE;
  $('aDateCustomRow').style.display=custom?'':'none';
  if(custom&&!$('aDateCustom').value){
    /* Seed with a month out rather than today: a target you have already
       reached is not a target. */
    const d=new Date();d.setMonth(d.getMonth()+1);
    $('aDateCustom').value=d.toISOString().split('T')[0];
  }
}

/* The select holds either a preset band or the CUSTOM_DATE sentinel;
   this turns that plus the date field into the value actually stored. */
function readTargetDate(){
  const v=$('aDate').value;
  if(v!==CUSTOM_DATE) return v||null;
  return $('aDateCustom').value||null;
}

function dateOptionExists(v){
  return [...$('aDate').options].some(o=>o.value===v);
}
function resetDateOptions(){
  [...$('aDate').options].forEach(o=>{ if(o.dataset.legacy) o.remove(); });
}
function addLegacyDateOption(v){
  const o=document.createElement('option');
  o.value=v;
  o.textContent=LEGACY_DATE_LABELS[v]||v;
  o.dataset.legacy='1';
  $('aDate').appendChild(o);
}

/* ==============================================================
   PRIORITY

   A native <select> cannot show what each level looks like, and the
   colour is the thing you actually read back in the lists — so the
   control is three swatched options instead. The chosen value is kept
   in a hidden #aPri input so saveActivity() still just reads
   $('aPri').value; anything that sets the priority must come through
   here, or the buttons and the value drift apart.
   ============================================================== */
function setPriorityChoice(p){
  const v=PRIORITY_RANK[p]!==undefined?p:'medium';
  $('aPri').value=v;
  const seg=$('aPriSeg');
  if(!seg)return;
  seg.querySelectorAll('.pri-opt').forEach(b=>{
    const on=b.dataset.pri===v;
    b.classList.toggle('active',on);
    b.setAttribute('aria-checked',on?'true':'false');
  });
}

/* The reminder row only exists once the remind_at column does. */
function setRemindField(value,note){
  const row=$('aRemindRow');
  if(!row)return;
  if(!remindersReady()){row.style.display='none';return;}
  row.style.display='';
  $('aRemind').value=value||'';
  $('aRemindNote').value=note||'';
  updateRemindRow();
}

async function saveActivity(){
  const name=$('aName').value.trim();
  if(!name){shakeEl($('aName'));$('aName').focus();return;}
  /* "Specific date" with no date is not a choice. */
  if($('aDate').value===CUSTOM_DATE&&!$('aDateCustom').value){
    shakeEl($('aDateCustom'));$('aDateCustom').focus();return;
  }
  const fields={
    name,
    description:$('aDesc').value.trim()||null,
    location:$('aLoc').value.trim()||null,
    location_lat:parseFloat($('aLocLat').value)||null,
    location_lng:parseFloat($('aLocLng').value)||null,
    target_date:readTargetDate(),
    priority:$('aPri').value,
    links:aLinks
  };
  /* Only send the column if the database actually has it, or every
     insert fails for people who have not run the migration. */
  if(remindersReady()){
    fields.remind_at=$('aRemind').value||null;
    /* A note with no date has nothing to fire it, so drop it too. */
    fields.reminder_note=fields.remind_at?($('aRemindNote').value.trim()||null):null;
  }

  /* The fields are read off the sheet before the duplicate check, not
     after: the check can open a sheet on top of this one, and a value
     captured on the far side of that would be read from a form the
     user may have moved on from.

     An edit is checked too, but only against a name that actually
     changed — otherwise saving an untouched activity would report it
     as a duplicate of every near-miss in the library. `excludeId`
     keeps it from matching itself. */
  const before=editingActId?await fetchActivity(editingActId):null;
  const renamed=!before||fuzzyNorm(before.name)!==fuzzyNorm(name);
  if(!renamed) return commitSaveActivity(fields,before);
  dupeGuard({name,location:fields.location||'',excludeId:editingActId||null},
    ()=>commitSaveActivity(fields,before));
}

/* The two list columns, ready to merge into a write — or nothing at
   all when the sheet's choice matches what is already stored, so an
   edit that did not touch the lists does not rewrite them.

   extra_collection_ids is left off entirely without the migration.
   Sending a column the table does not have fails the whole insert,
   which is why the probe exists. See probeMultiList() in js/api.js. */
function listFieldsFor(ids){
  const{collection_id,extra_collection_ids}=splitListIds(ids);
  if(!collection_id) return null;
  return multiListReady()?{collection_id,extra_collection_ids}:{collection_id};
}

async function commitSaveActivity(fields,before){
  const btn=$('actSaveBtn');btn.disabled=true;
  try{
    /* An edit can move an activity between collections, so every end
       needs its stats rebuilt — the ones it left and the ones it landed
       in. Reading the old row before the write is the only way to know
       where it was. */
    let offline=false;
    if(editingActId){
      const wasIn=(before&&before.listIds)||[];
      const nowIn=targetListIds.length?targetListIds:wasIn;
      const cols=listFieldsFor(nowIn);
      /* Only written when the set actually changed. An untouched edit
         must not rewrite these — with the migration absent, `cols`
         holds collection_id alone and writing it back would silently
         strip an activity out of every list but its home. */
      const moved=cols&&(wasIn.length!==nowIn.length||wasIn.some((id,i)=>id!==nowIn[i]));
      if(moved) Object.assign(fields,cols);

      const r=await dbUpdate('Activities',fields,{id:editingActId});
      if(r.error)throw r.error;
      offline=!!r.offline;
      /* The union of both sets: a list gained needs recounting, and so
         does one it was taken out of. */
      new Set([...wasIn,...nowIn]).forEach(id=>updateCollectionStats(id));
    } else {
      const cols=listFieldsFor(targetListIds.length?targetListIds:(curListId?[curListId]:[]));
      if(!cols){showToast('Create a list first');return;}
      Object.assign(fields,cols);
      const r=await dbInsert('Activities',fields);
      if(r.error)throw r.error;
      offline=!!r.offline;
      (targetListIds.length?targetListIds:[curListId]).forEach(id=>updateCollectionStats(id));
    }
    closeModal('actSheet');
    if(offline) showToast('Saved — will sync when you’re back online');
    /* Whatever screen is actually showing owns the row that changed.
       This used to fall back to Home for everything that was not the
       detail screen, so editing from Up Next redrew a page the user was
       not on and left the edited row stale in front of them. */
    refreshAfterChange();
  }catch(err){
    console.error('saveActivity:',err);
    showToast(err.message||'Couldn’t save.');
  }finally{ btn.disabled=false; }
}

/* Take an activity out of one list without destroying it. Not
   confirmed, and deliberately so: nothing is lost, the activity is
   still in its other lists, and it is put back by opening it from any
   of them and ticking this list again. A confirmation on a reversible
   action teaches people to dismiss confirmations.

   It refuses to empty the set. An activity in no list is reachable
   from nowhere in the app — it would still be in the database, still
   on the map, and impossible to find. */
async function removeActivityFromList(id,listId){
  const a=await fetchActivity(id);
  if(!a)return;
  const rest=(a.listIds||[]).filter(x=>x!==listId);
  if(!rest.length){ showToast('An activity has to be in at least one list.'); return; }

  const cols=listFieldsFor(rest);
  const{error,offline}=await dbUpdate('Activities',cols,{id});
  if(error){
    console.error('removeActivityFromList:',error);
    showToast(error.message||'Couldn’t remove it.');
    return;
  }
  closeModal('actDetailSheet');
  updateCollectionStats(listId);
  if(cols.collection_id!==a.listId) updateCollectionStats(cols.collection_id);
  refreshAfterChange();
  showToast(offline?'Removed — will sync later':'Removed from this list');
}

async function delActivity(id){
  const a=await fetchActivity(id);
  const{error}=await dbDelete('Activities',{id});
  if(error){
    console.error('delActivity:',error);
    showToast(error.message||'Couldn’t delete.');
    return;
  }
  await updateCollectionStats((a&&a.listId)||curListId);
  refreshAfterChange();
  showToast('Deleted');
}

/* ==============================================================
   ACTIVITY DETAIL SHEET
   ============================================================== */
/* Tiles the media grid will draw before it folds the rest behind a
   "+N" tile — two rows of three. */
const AD_GRID_MAX=6;

async function openActDetail(id){
  const a=await fetchActivity(id);if(!a)return;
  editingActId=null;
  const di=dateInfo(a);
  /* Only the lists this user can see. An activity shared into one of
     theirs is homed in someone else's, and naming a list they have no
     access to would be both meaningless and a small disclosure. */
  const lists=(await fetchCollections()).filter(c=>(a.listIds||[]).includes(c.id));
  const media=a.media||[];
  /* The lightbox walks the full media list, so a video opens in place
     rather than being skipped over. */
  const mediaArg=JSON.stringify(media).replace(/"/g,'&quot;');

  /* The name, then the badges, then the photos. The title leads because
     it is what the sheet is about; the state and the date read as the
     caption under it, and they still sit directly above the media rather
     than being separated from it by anything else.

     The name is centred on a completed activity to sit over the
     symmetric full-width pair of badges; a pending activity's badges are
     small left-aligned chips, so its title stays left. */
  let h=`<div class="ad-head">
    <div class="ad-title${a.completed?' centered':''}">${esc(a.name)}</div>
    <div class="ad-badges${a.completed?' done':''}">
      <span class="tag ${a.completed?'tag-done':'tag-'+(a.priority||'medium')}">
        ${a.completed?'Accomplished':cap(a.priority||'medium')}
      </span>
      ${a.completed?`<button class="badge b-done ad-datebtn"
        onclick="openCompFrom('${a.id}')">
        ${icon('calendar','ic-xs')}${esc(a.completedDate?fmtDate(a.completedDate,true):'Set date')}
      </button>`:''}
      ${!a.completed&&di.label?`<span class="badge b-${di.cls}">${esc(di.label)}</span>`:''}
    </div>`;

  if(media.length===1){
    h+=`<div class="ad-hero-wrap" onclick="openLB(${mediaArg},0)">
      ${mediaTileHTML(media[0],'ad-hero')}</div>`;
  } else if(media.length>1){
    /* Past six the grid runs several rows deep and pushes the notes and
       the actions off the bottom of the sheet, so it is capped at two
       rows: five tiles and a "+N" tile. The extra tile opens the
       lightbox at the first item it is hiding, and the lightbox walks
       the whole list — so nothing is unreachable, it is only folded. */
    const over=media.length>AD_GRID_MAX;
    const shown=over?media.slice(0,AD_GRID_MAX-1):media;
    h+=`<div class="ad-photos">${shown.map((m,i)=>
      `<div class="ad-photo-cell" onclick="openLB(${mediaArg},${i})">${mediaTileHTML(m)}</div>`).join('')}
      ${over?`<button class="ad-photo-cell ad-photo-more"
        onclick="openLB(${mediaArg},${AD_GRID_MAX-1})"
        aria-label="Show all ${media.length} items">
        ${icon('plus','ic-sm')}<span>${media.length-(AD_GRID_MAX-1)}</span>
      </button>`:''}</div>`;
  }
  h+=`</div>`;

  /* What you wrote when you finished it reads with the photos, so it
     sits directly under them — above the location and the notes-from-
     before, which are reference rather than the story. */
  if(a.completed&&a.completionNotes){
    h+=`<div class="ad-section"><div class="ad-section-label">How it went</div>
      <div class="ad-note prose">${esc(a.completionNotes)}</div></div>`;
  }
  /* Which lists it is in, but only once that is news. At one list the
     answer is the screen you came from, and a section restating it on
     every activity in the app would be noise on the overwhelming
     majority of them. At two or more it is the only place the app says
     so, and it is what makes the feature visible at all. */
  if(lists.length>1){
    h+=`<div class="ad-section"><div class="ad-section-label">In ${lists.length} lists</div>
      <div class="ad-lists">${lists.map(l=>
        `<button class="ad-list-chip" onclick="closeModal('actDetailSheet');nav('detail','${l.id}')">
           ${icon('stack','ic-xs')}<span>${esc(l.name)}</span>
         </button>`).join('')}</div></div>`;
  }
  if(a.location){
    h+=`<div class="ad-section"><div class="ad-section-label">Location</div>
      <div class="ad-note">${esc(a.location)}</div></div>`;
  }
  if(a.description){
    h+=`<div class="ad-section"><div class="ad-section-label">Notes</div>
      <div class="ad-note">${esc(a.description)}</div></div>`;
  }
  if(a.targetDate&&!a.completed){
    h+=`<div class="ad-section"><div class="ad-section-label">Target</div>
      <div class="ad-note">${esc(a.targetDate)}</div></div>`;
  }
  if(a.links&&a.links.length){
    h+=`<div class="ad-section"><div class="ad-section-label">Links</div>
      <div class="group ad-links" style="margin:0">${a.links.map(l=>
        `<a class="ad-link" href="${esc(l)}" target="_blank" rel="noopener">
           ${icon('link','ic-sm')}<span>${esc(l.replace(/^https?:\/\//,''))}</span>
         </a>`).join('')}</div></div>`;
  }

  /* Actions: the primary one flips completion, then the rest.

     A completed activity gets ONE edit button, not two. "Edit details"
     is the target date, the priority and the reminder — every one of
     them about what to do next, which a finished thing does not have.
     So it is dropped, and the remaining button carries the name and the
     location alongside the photos and notes it already held. */
  const many=lists.length>1;
  const delBtn=`<button class="btn btn-destructive btn-block"
      onclick="confirmDeleteActivity('${a.id}','${esc(a.name).replace(/'/g,'&#39;')}',${lists.length})">
      ${icon('trash')}${many?'Delete Everywhere':'Delete'}
    </button>`;

  /* An activity in several lists has two different things "get rid of
     it" could mean, and only one of them is destructive. Taking it out
     of the list you are standing in is the one people will actually
     want most of the time, so it gets its own button rather than being
     buried in the Lists row of the edit sheet — and it is grey, not
     red, because nothing is destroyed: the activity, its photos and
     its completion all carry on living in its other lists.

     Shown only when there is a list to remove it from and another list
     for it to survive in. */
  const here=curPage==='detail'&&curListId&&(a.listIds||[]).includes(curListId)?curListId:null;
  const removeBtn=many&&here
    ? `<button class="btn btn-gray btn-block" onclick="removeActivityFromList('${a.id}','${here}')">
         ${icon('x')}Remove From This List
       </button>`
    : '';

  h+= a.completed
    /* Editing is the thing you came here to do once something is done,
       so it takes the full-width row. Un-completing and deleting are
       both corrections — undoing a record rather than adding to one —
       so they share the last row instead of each claiming a full-width
       button of their own. */
    ? `<div class="sheet-actions">
        <button class="btn btn-tinted btn-block" onclick="openCompFrom('${a.id}')">
          ${icon('pencil')}Edit
        </button>
        ${removeBtn}
        <div class="sheet-actions-row">
          <button class="btn btn-gray btn-block"
                  onclick="closeModal('actDetailSheet');toggleComplete('${a.id}',true)">
            ${icon('undo')}Mark as not done
          </button>
          ${delBtn}
        </div>
      </div>`
    /* Still pending: finishing it is the primary action and keeps the
       emphasis of a full-width row of its own. */
    : `<div class="sheet-actions">
        <button class="btn btn-green btn-block"
                onclick="closeModal('actDetailSheet');toggleComplete('${a.id}',false)">
          ${icon('check')}Mark accomplished
        </button>
        <button class="btn btn-gray btn-block" onclick="closeModal('actDetailSheet');openEditAct('${a.id}')">
          ${icon('pencil')}Edit details
        </button>
        ${removeBtn}
        ${delBtn}
      </div>`;

  $('actDetailBody').innerHTML=h;
  openModal('actDetailSheet');
}

/* ==============================================================
   COLLECTION OVERFLOW MENU  (the ⋯ in the nav bar)
   Holds everything the old hero row spelled out as five buttons.
   ============================================================== */
async function openCollectionMenu(){
  const l=await fetchCollection(curListId);
  const mine=ownsCollection(l);

  const items=[
    {label:'List',  icon:'rows',        checked:curView==='list', onSelect:()=>setView('list')},
    {label:'Grid',  icon:'square-grid', checked:curView==='grid', onSelect:()=>setView('grid')},
    {label:'Map',   icon:'map',         checked:curView==='map',  onSelect:()=>setView('map')},
    {label:'Add Many at Once', icon:'plus',   onSelect:openBulkAdd},
    {label:'Edit List',        icon:'pencil', onSelect:openEditList},
  ];
  /* Sharing only appears once the backend supports it — the same rule
     the reminder row follows. See js/sharing.js. */
  if(sharingReady()){
    items.push({label:mine?'Share List':'Sharing',icon:'share',onSelect:openShareList});
  }
  /* A list you joined is not yours to delete. Leaving is the member's
     equivalent and destroys nothing, so it is not marked destructive
     in the same breath as Delete — it is reversible with the link. */
  items.push(mine
    ? {label:'Delete List',icon:'trash',role:'destructive',onSelect:confirmDeleteCollection}
    : {label:'Leave List', icon:'signout',role:'destructive',onSelect:confirmLeaveList});

  showActionSheet({items});
}

function setFilter(f){
  curFilter=f;
  const seg=$('detFilter');
  if(seg) seg.querySelectorAll('button').forEach((b,i)=>
    b.classList.toggle('active',['all','pending','completed'][i]===f));
  /* On the map, just re-filter the markers — a full re-render would
     zoom the map back out from under the user. */
  if(curView==='map'&&actMap){updateMapMarkers();return;}
  renderActivitiesList();
}
function setView(v){
  curView=v;
  if(v!=='map') destroyDetailMap();
  renderActivitiesList();
}

/* ==============================================================
   SORT ORDER  (the control beside the filter on a collection screen)
   ============================================================== */
function openSortMenu(){
  showActionSheet({
    title:'Sort By',
    items:Object.entries(ACT_SORTS).map(([key,s])=>({
      label:s.label,
      checked:curSort===key,
      onSelect:()=>setSort(key),
    })),
  });
}
function setSort(key){
  if(!ACT_SORTS[key]) return;
  curSort=key;
  /* The button carries the current order as its label, so it has to be
     redrawn — but only it. Rebuilding the whole control block would
     take the search field with it and drop focus mid-typing, which is
     the entire reason renderDetail() and renderActivitiesList() are
     separate in the first place. */
  const btn=$('detSortBtn');
  if(btn) btn.outerHTML=sortButtonHTML();
  /* Order means nothing to a map, so there is nothing to redraw there —
     and a re-render would zoom it back out from under the user, the
     same trap setFilter() sidesteps. */
  if(curView==='map') return;
  renderActivitiesList();
}
