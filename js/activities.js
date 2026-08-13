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
async function quickAddActivity(){
  const input=$('composerInput');
  if(!input)return;
  const name=input.value.trim();
  if(!name){shakeEl(input);return;}

  input.value='';
  onComposerInput();
  input.disabled=true;

  const{error}=await sb.from('Activities').insert({name,collection_id:curListId});
  input.disabled=false;

  if(error){
    console.error('quickAddActivity:',error);
    input.value=name;                       /* give the text back */
    showToast(error.message||'Couldn’t add that.');
    input.focus();
    return;
  }
  invalidateActivities();
  await updateCollectionStats(curListId);
  await refreshAfterChange();
  /* Re-render replaced the composer, so put the caret back for the
     next one. */
  focusComposer();
}

/* "Details" on the composer — carry whatever was typed into the
   full sheet rather than making the user retype it. */
function openNewActivityFromComposer(){
  const input=$('composerInput');
  const typed=input?input.value.trim():'';
  if(input){input.value='';onComposerInput();}
  openNewActivity(typed);
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
  const{error}=await sb.from('Activities')
    .update({date_completed: null})
    .eq('id',id);
  if(error){
    console.error('toggleComplete:',error);
    showToast(error.message||'Couldn’t update that.');
    return;
  }
  invalidateActivities();
  await updateCollectionStats((a&&a.listId)||curListId);
  await refreshAfterChange();
}

/* ==============================================================
   COMPLETING SOMETHING

   One sheet does the whole job: the date, and — behind a disclosure —
   where it happened, how it went, and the photos and video.

   It used to be two. A date-only sheet completed the activity, and
   attaching anything to it meant closing that, reopening the activity,
   and finding "Add photos & notes" three taps down. The moment you have
   the photos is the moment you tick the thing off, so they belong in
   the same sheet.

   The extras stay collapsed on a fresh completion, which is what keeps
   the one-tap flow one tap: press the check, press Done. The disclosure
   sits right under the date for the times you do want to write
   something. Nothing is written until Save either way, so an accidental
   tap still costs a Cancel rather than a wrong date to find later.

   Reopening from the date pill in the activity sheet lands in the same
   place, with the extras already open if any of them are in use.
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
  renderThumbs();

  $('compSheetTitle').textContent=compNew?'Accomplished':'Edit';
  $('compSaveBtn').textContent=compNew?'Done':'Save';
  /* Extras already in use open themselves, so editing never hides what
     is there. A fresh completion always starts collapsed. */
  setCompMore(!compNew&&!!(a.location||a.completionNotes||upMedia.length));
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

function setCompMore(open){
  $('compMore').classList.toggle('open',open);
  $('compMoreToggle').setAttribute('aria-expanded',open?'true':'false');
  $('compMoreLabel').textContent=open?'Fewer details':'Add photos, video & notes';
}
function toggleCompMore(){
  setCompMore(!$('compMore').classList.contains('open'));
}

async function confirmComplete(){
  if(!compId)return;
  const name=$('compName').value.trim();
  if(!name){shakeEl($('compName'));$('compName').focus();return;}
  const btn=$('compSaveBtn');btn.disabled=true;
  const{error}=await sb.from('Activities').update({
    name,
    date_completed:$('compDate').value||todayISO(),
    location:$('compLoc').value.trim()||null,
    location_lat:parseFloat($('compLocLat').value)||null,
    location_lng:parseFloat($('compLocLng').value)||null,
    experience_notes:$('compNotes').value.trim()||null,
    photos:denormMedia(upMedia)
  }).eq('id',compId);
  btn.disabled=false;
  if(error){
    console.error('confirmComplete:',error);
    showToast(error.message||'Couldn’t save.');
    return;
  }
  const wasNew=compNew,src=compSrc,list=compList;
  closeModal('compSheet');
  compId=null;
  invalidateActivities();
  await updateCollectionStats(list||curListId);
  if(wasNew){ confetti(); showToast('Accomplished'); }
  else showToast('Saved');
  refreshAfterChange(src);
}

/* ==============================================================
   FULL ACTIVITY SHEET (create / edit)
   Everything past the name is behind a disclosure, so the common
   case is one field.
   ============================================================== */
/* targetListId is where a *new* activity will be filed. Inside a
   collection it is that collection; opened from Home it is whatever the
   user picks in the sheet's List row. */
let targetListId=null;

async function openNewActivity(prefillName){
  editingActId=null;aLinks=[];
  targetListId=curListId||null;
  await renderActListPicker();
  $('aName').value=prefillName||'';
  $('aDesc').value='';$('aLoc').value='';$('aLocLat').value='';$('aLocLng').value='';
  resetDateOptions();
  $('aDate').value=DEFAULT_TARGET_DATE;
  setPriorityChoice('medium');
  $('aDateCustom').value='';onTargetDateChange();
  renderTagChips('aLinks');
  setRemindField(null,'');
  setMoreFields(false);
  $('actSheetTitle').textContent='New Activity';
  $('actSaveBtn').textContent='Add';
  openModal('actSheet');
  setTimeout(()=>$('aName').focus(),320);
}
async function openEditAct(id){
  const a=await fetchActivity(id);if(!a)return;
  editingActId=id;
  targetListId=a.listId;
  await renderActListPicker();
  $('aName').value=a.name;$('aDesc').value=a.description||'';
  $('aLoc').value=a.location||'';$('aLocLat').value=a.locationLat||'';$('aLocLng').value=a.locationLng||'';
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
  /* Open the extra fields straight away when any of them are in use. */
  /* Location and the reminder are top-level fields now, so they no
     longer decide whether the disclosure opens. */
  setMoreFields(!!(a.description||(a.links&&a.links.length)));
  $('actSheetTitle').textContent='Edit Activity';
  $('actSaveBtn').textContent='Save';
  openModal('actSheet');
}
/* The List row only appears when there is a choice to make: editing an
   existing activity, or creating one from outside a collection. */
async function renderActListPicker(){
  const row=$('actListRow');
  if(!row)return;
  const lists=await fetchCollections();
  if(!lists.length){row.style.display='none';return;}
  row.style.display='';
  if(!targetListId) targetListId=lists[0].id;
  const cur=lists.find(l=>l.id===targetListId)||lists[0];
  targetListId=cur.id;
  $('actListName').textContent=cur.name;
  row.onclick=()=>openListPicker({
    currentId:targetListId,
    onPick:id=>{
      const picked=lists.find(l=>l.id===id);
      if(!picked)return;
      targetListId=picked.id;
      $('actListName').textContent=picked.name;
    },
  });
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

function setMoreFields(open){
  $('actMore').classList.toggle('open',open);
  $('actMoreToggle').setAttribute('aria-expanded',open?'true':'false');
  $('actMoreLabel').textContent=open?'Fewer options':'More options';
}
function toggleMoreFields(){
  setMoreFields(!$('actMore').classList.contains('open'));
}

async function saveActivity(){
  const name=$('aName').value.trim();
  if(!name){shakeEl($('aName'));$('aName').focus();return;}
  /* "Specific date" with no date is not a choice. */
  if($('aDate').value===CUSTOM_DATE&&!$('aDateCustom').value){
    setMoreFields($('actMore').classList.contains('open'));
    shakeEl($('aDateCustom'));$('aDateCustom').focus();return;
  }
  const btn=$('actSaveBtn');btn.disabled=true;
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
  try{
    /* An edit can move an activity between collections, so both ends
       need their stats rebuilt — the one it left and the one it landed
       in. Reading the old row before the write is the only way to know
       where it was. */
    const before=editingActId?await fetchActivity(editingActId):null;
    if(editingActId){
      if(targetListId&&before&&targetListId!==before.listId) fields.collection_id=targetListId;
      const{error}=await sb.from('Activities').update(fields).eq('id',editingActId);
      if(error)throw error;
      invalidateActivities();
      await updateCollectionStats(targetListId||before.listId);
      if(before&&targetListId&&targetListId!==before.listId)
        await updateCollectionStats(before.listId);
    } else {
      const dest=targetListId||curListId;
      if(!dest){showToast('Create a list first');return;}
      fields.collection_id=dest;
      const{error}=await sb.from('Activities').insert(fields);
      if(error)throw error;
      invalidateActivities();
      await updateCollectionStats(dest);
    }
    closeModal('actSheet');
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

async function delActivity(id){
  const a=await fetchActivity(id);
  const{error}=await sb.from('Activities').delete().eq('id',id);
  if(error){
    console.error('delActivity:',error);
    showToast(error.message||'Couldn’t delete.');
    return;
  }
  invalidateActivities();
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
  const delBtn=`<button class="btn btn-destructive btn-block"
      onclick="confirmDeleteActivity('${a.id}','${esc(a.name).replace(/'/g,'&#39;')}')">
      ${icon('trash')}Delete
    </button>`;

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
        ${delBtn}
      </div>`;

  $('actDetailBody').innerHTML=h;
  openModal('actDetailSheet');
}

/* ==============================================================
   COLLECTION OVERFLOW MENU  (the ⋯ in the nav bar)
   Holds everything the old hero row spelled out as five buttons.
   ============================================================== */
function openCollectionMenu(){
  showActionSheet({
    items:[
      {label:'List',  icon:'rows',        checked:curView==='list', onSelect:()=>setView('list')},
      {label:'Grid',  icon:'square-grid', checked:curView==='grid', onSelect:()=>setView('grid')},
      {label:'Map',   icon:'map',         checked:curView==='map',  onSelect:()=>setView('map')},
      {label:'Add Many at Once', icon:'plus',    onSelect:openBulkAdd},
      {label:'Edit List',        icon:'pencil',  onSelect:openEditList},
      {label:'Delete List',      icon:'trash',   role:'destructive', onSelect:confirmDeleteCollection},
    ],
  });
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
