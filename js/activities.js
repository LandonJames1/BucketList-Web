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
  await updateCollectionStats(curListId);
  await renderDetail();
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
  const nowDone=!isDone;
  const{error}=await sb.from('Activities')
    .update({date_completed: nowDone ? todayISO() : null})
    .eq('id',id);
  if(error){
    console.error('toggleComplete:',error);
    showToast(error.message||'Couldn’t update that.');
    return;
  }
  await updateCollectionStats(curListId);
  await renderDetail();
  if(nowDone){
    confetti();
    /* One tap files it as today, which is right nearly always. The
       toast is the way back for the times it is not — an offer, so the
       fast path stays one tap. */
    showToast('Accomplished','Set date',()=>openCompletedDate(id));
  }
}

/* ==============================================================
   COMPLETION DATE

   Completing writes today. This is the only place that is editable
   on its own, without going through the photos-and-notes sheet — the
   common correction is "I did this on Saturday", not "let me write
   about it".
   ============================================================== */
let compDateId=null;

async function openCompletedDate(id){
  const a=await fetchActivity(id);
  if(!a)return;
  compDateId=id;
  $('compDateName').textContent=a.name;
  /* Defaults to the stored date, or today for anything completed
     before the app recorded one. */
  $('compDateOnly').value=a.completedDate||todayISO();
  $('compDateOnly').max=todayISO();     /* you cannot have done it yet */
  openModal('compDateSheet');
}

async function saveCompletedDate(){
  if(!compDateId)return;
  const val=$('compDateOnly').value||todayISO();
  const btn=$('compDateSaveBtn');btn.disabled=true;
  const{error}=await sb.from('Activities')
    .update({date_completed:val}).eq('id',compDateId);
  btn.disabled=false;
  if(error){
    console.error('saveCompletedDate:',error);
    showToast(error.message||'Couldn\u2019t save that.');
    return;
  }
  closeModal('compDateSheet');
  compDateId=null;
  showToast('Date updated');
  refreshAfterChange();
}

/* Whichever screen is showing owns the rows that just changed. */
function refreshAfterChange(){
  if(curPage==='home') renderHome();
  else if(curPage==='upnext') renderUpNext();
  else if(curPage==='done') renderDone();
  else if(curPage==='detail') renderDetail();
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
  $('aDate').value=DEFAULT_TARGET_DATE;$('aPri').value='medium';
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
  $('aPri').value=a.priority||'medium';
  aLinks=[...(a.links||[])];
  renderTagChips('aLinks');
  setRemindField(a.remindAt,a.remindNote);
  /* Open the extra fields straight away when any of them are in use. */
  setMoreFields(!!(a.description||a.location||a.remindAt||a.remindNote||(a.links&&a.links.length)));
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

/* The reminder field only exists once the remind_at column does. */
function setRemindField(value,note){
  const row=$('aRemindRow');
  if(!row)return;
  if(!remindersReady()){row.style.display='none';return;}
  row.style.display='';
  $('aRemind').value=value||'';
  $('aRemindNote').value=note||'';
  $('aRemindClear').style.display=value?'':'none';
}
function clearRemindField(){
  $('aRemind').value='';
  $('aRemindNote').value='';
  $('aRemindClear').style.display='none';
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
    if(editingActId){
      const{error}=await sb.from('Activities').update(fields).eq('id',editingActId);
      if(error)throw error;
    } else {
      const dest=targetListId||curListId;
      if(!dest){showToast('Create a list first');return;}
      fields.collection_id=dest;
      const{error}=await sb.from('Activities').insert(fields);
      if(error)throw error;
      await updateCollectionStats(dest);
    }
    if(editingActId) await updateCollectionStats(targetListId||curListId);
    closeModal('actSheet');
    /* Re-render whichever screen the user is actually looking at. */
    if(curPage==='detail') renderDetail(); else renderHome();
  }catch(err){
    console.error('saveActivity:',err);
    showToast(err.message||'Couldn’t save.');
  }finally{ btn.disabled=false; }
}

async function delActivity(id){
  const{error}=await sb.from('Activities').delete().eq('id',id);
  if(error){
    console.error('delActivity:',error);
    showToast(error.message||'Couldn’t delete.');
    return;
  }
  await updateCollectionStats(curListId);
  renderDetail();
  showToast('Deleted');
}

/* ==============================================================
   COMPLETION DETAILS
   Reached from an already-completed activity, to attach the
   photos, notes and place. Completing itself needs none of this.
   ============================================================== */
async function openComp(id){
  const a=await fetchActivity(id);if(!a)return;
  completingId=id;
  upPhotos=[...(a.photos||[])];
  $('compName').textContent=a.name;
  $('compLoc').value=a.location||'';
  $('compLocLat').value=a.locationLat||'';
  $('compLocLng').value=a.locationLng||'';
  $('compDate').value=a.completedDate||todayISO();
  $('compNotes').value=a.completionNotes||'';
  renderThumbs();
  openModal('compSheet');
}
async function confirmComplete(){
  if(!completingId)return;
  const btn=$('compSaveBtn');btn.disabled=true;
  const{error}=await sb.from('Activities').update({
    location:$('compLoc').value.trim()||null,
    location_lat:parseFloat($('compLocLat').value)||null,
    location_lng:parseFloat($('compLocLng').value)||null,
    date_completed:$('compDate').value||todayISO(),
    experience_notes:$('compNotes').value.trim()||null,
    photos:upPhotos
  }).eq('id',completingId);
  btn.disabled=false;
  if(error){
    console.error('confirmComplete:',error);
    showToast(error.message||'Couldn’t save.');
    return;
  }
  await updateCollectionStats(curListId);
  closeModal('compSheet');
  renderDetail();
  completingId=null;
}

/* ==============================================================
   ACTIVITY DETAIL SHEET
   ============================================================== */
async function openActDetail(id){
  const a=await fetchActivity(id);if(!a)return;
  editingActId=null;
  const di=dateInfo(a);
  const photos=a.photos||[];
  const photosArg=JSON.stringify(photos).replace(/"/g,'&quot;');

  let h=`<div class="ad-head">
    <div class="ad-title">${esc(a.name)}</div>
    <div class="ad-badges">
      <span class="tag ${a.completed?'tag-done':'tag-'+(a.priority||'medium')}">
        ${a.completed?'Accomplished':cap(a.priority||'medium')}
      </span>
      ${a.completed?`<button class="badge b-done ad-datebtn"
        onclick="closeModal('actDetailSheet');openCompletedDate('${a.id}')">
        ${icon('calendar','ic-xs')}${esc(a.completedDate?fmtDate(a.completedDate):'Set date')}
      </button>`:''}
      ${!a.completed&&di.label?`<span class="badge b-${di.cls}">${esc(di.label)}</span>`:''}
    </div>`;

  if(photos.length===1){
    h+=`<img class="ad-hero" src="${photos[0]}" alt="" onclick="openLB(${photosArg},0)"/>`;
  } else if(photos.length>1){
    h+=`<div class="ad-photos">${photos.map((p,i)=>
      `<img src="${p}" alt="" loading="lazy" onclick="openLB(${photosArg},${i})"/>`).join('')}</div>`;
  }
  h+=`</div>`;

  if(a.location){
    h+=`<div class="ad-section"><div class="ad-section-label">Location</div>
      <div class="ad-note">${esc(a.location)}</div></div>`;
  }
  if(a.completed&&a.completionNotes){
    h+=`<div class="ad-section"><div class="ad-section-label">How it went</div>
      <div class="ad-note prose">${esc(a.completionNotes)}</div></div>`;
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

  /* Actions: the primary one flips completion, then the rest. */
  h+=`<div class="sheet-actions">
    <button class="btn ${a.completed?'btn-gray':'btn-green'} btn-block"
            onclick="closeModal('actDetailSheet');toggleComplete('${a.id}',${a.completed})">
      ${icon(a.completed?'undo':'check')}${a.completed?'Mark as not done':'Mark accomplished'}
    </button>
    ${a.completed?`<button class="btn btn-tinted btn-block" onclick="closeModal('actDetailSheet');openComp('${a.id}')">
      ${icon('camera')}${photos.length||a.completionNotes?'Edit photos &amp; notes':'Add photos &amp; notes'}
    </button>`:''}
    <button class="btn btn-gray btn-block" onclick="closeModal('actDetailSheet');openEditAct('${a.id}')">
      ${icon('pencil')}Edit details
    </button>
    <button class="btn btn-destructive btn-block" onclick="confirmDeleteActivity('${a.id}','${esc(a.name).replace(/'/g,'&#39;')}')">
      ${icon('trash')}Delete
    </button>
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
