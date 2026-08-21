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
  startNewActivity(name);
}

/* ==============================================================
   ONE QUESTION BEFORE THE SHEET

   An activity arrives two ways round: something you mean to do, and
   something you have just done and want on the record. The second had
   no path at all — you had to create the plan and immediately complete
   it, which is two sheets and a fiction in between. A helicopter ride
   taken on a whim is exactly the thing this app is for, and it was the
   thing it was worst at.

   So every *human* way in asks first. Deliberately not inside
   openNewActivity() itself: a link import (handOffSingle) and the bulk
   sheet land there too, and both are plans by construction, so the
   question would have only one answer.

   New Activity is first because it is the overwhelmingly common
   answer, and this costs the fast path a tap — the composers were
   tuned so capture costs one extra tap and it is now two. Keeping the
   common answer under the thumb is what makes that bearable.
   ============================================================== */
function startNewActivity(prefillName){
  showActionSheet({
    message:'Is this something you want to do, or something you’ve already done?',
    items:[
      {label:'New Activity',       icon:'plus',
       onSelect:()=>openNewActivity(prefillName)},
      {label:'Completed Activity', icon:'check-circle',
       onSelect:()=>openCompDraft(prefillName)},
    ],
  });
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
/* compNew   — this save is the moment it becomes accomplished.
   compDraft — there is no row yet; Save inserts one.
   They are separate because a draft is both new AND needs its name
   editable, and compNew alone used to decide the name's shape too. */
let compId=null,compSrc=null,compList=null,compNew=false,compDraft=false;
/* The list the open activity was in when the sheet opened. Only used to
   tell "the user moved it" from "the user never touched that row", so an
   untouched edit does not rewrite collection_id at all. Same guard
   commitSaveActivity() uses. */
let compListsBefore=[];

async function openComp(id,source){
  const a=await fetchActivity(id);
  if(!a)return;
  compId=id;
  compSrc=source||curPage;
  compList=a.listId;
  compNew=!a.completed;
  compDraft=false;
  upMedia=[...(a.media||[])];
  /* Seeded from the row so the Lists row can move it. compListsBefore
     is what confirmComplete() compares against to decide whether the
     list columns are written at all. */
  setTargetLists([a.listId]);
  compListsBefore=[...targetListIds];

  $('compName').value=a.name;
  /* Defaults to the stored date, or today for anything completed
     before the app recorded one. */
  $('compDate').value=a.completedDate||todayISO();
  $('compDate').max=todayISO();          /* you cannot have done it yet */
  $('compLoc').value=a.location||'';
  $('compLocLat').value=a.locationLat||'';
  $('compLocLng').value=a.locationLng||'';
  /* Stored location and stored coordinates are resolved by
     construction; mark them so re-saving does not re-geocode. */
  if(a.location&&a.locationLat!=null) locGeoMark($('compLoc')); else delete $('compLoc').dataset.geoFor;
  locSetHome('compLoc',a.locationIsHome);
  $('compNotes').value=a.completionNotes||'';
  /* Clear any chip left over from the last activity completed this
     session, and un-stick a dismissal so it can be offered again for
     this one. See suggestLocationFromPhoto() in js/media.js. */
  resetLocationSuggestion();
  renderThumbs();
  renderCompListRow();

  compShowPane('main');
  $('compSheetTitle').textContent=compNew?'Accomplished':'Edit';
  $('compSaveBtn').textContent=compNew?'Done':'Save';
  openModal('compSheet');
}

/* ==============================================================
   LOGGING SOMETHING ALREADY DONE

   The same sheet with no row behind it. It is the right form already —
   name, date, place, photos, how it went — and everything the sheet
   enforces still applies, the mandatory photo above all: something
   worth adding after the fact is something you have a picture of.

   The one field it has to grow is the list. An activity in no list is
   in the database, on the map, and reachable from nowhere.
   ============================================================== */
async function openCompDraft(prefillName){
  compId=null;
  compSrc=curPage;
  compList=curListId||null;
  compNew=true;                 /* it is being accomplished right now */
  compDraft=true;
  upMedia=[];

  setTargetLists(curListId?[curListId]:[]);
  compListsBefore=[];

  $('compName').value=prefillName||'';
  $('compDate').value=todayISO();
  $('compDate').max=todayISO();
  $('compLoc').value='';$('compLocLat').value='';$('compLocLng').value='';
  $('compNotes').value='';
  resetLocationSuggestion();
  renderThumbs();
  await renderCompListRow();

  compShowPane('main');
  $('compSheetTitle').textContent='Accomplished';
  $('compSaveBtn').textContent='Add';
  openModal('compSheet');
  /* After the sheet has finished sliding in, as everywhere else — a
     field focused mid-animation drags the keyboard up against a sheet
     that is still moving. */
  if(!prefillName) setTimeout(()=>$('compName').focus(),320);
}

/* Shares targetListIds with the activity sheet: the two are never open
   at once, and sharing it means listFieldsFor() works unchanged. */
async function renderCompListRow(){
  const row=$('compListCard');
  if(!row)return;

  const lists=await fetchCollections();
  /* No lists at all is handled at Save, the same way the activity sheet
     handles it — there is nothing useful to draw here. */
  if(!lists.length){row.style.display='none';return;}
  row.style.display='';

  const known=new Set(lists.map(l=>l.id));
  setTargetLists(targetListIds.filter(id=>known.has(id)));
  /* An activity that already exists must always be in at least one
     list, so an edit falls back to the first. A NEW one created from
     outside a collection deliberately does not: filing it into
     whichever list happens to sort first is a silent, wrong answer the
     user never gave, and the one they wanted is one tap away. The row
     reads "Choose" and saveActivity() refuses until it is answered. */
  if(!targetListIds.length&&editingActId) setTargetLists([lists[0].id]);

  $('compListLabel').textContent='List';
  renderActListValue(lists,'compListName');

  /* On the button, not the group: the group also holds the label, and
     tapping a label should do nothing. Same as renderActListPicker(). */
  $('compListBtn').onclick=()=>openListPicker({
    title:'Add to List',
    currentId:targetListId,
    onPick:picked=>{
      setTargetLists([picked]);
      if(!targetListIds.length) setTargetLists([lists[0].id]);
      renderActListValue(lists,'compListName');
    },
  });
}

/* ==============================================================
   MEDIA IS REQUIRED TO MARK SOMETHING ACCOMPLISHED

   A completion with nothing attached to it is a date. The photo or
   the clip is the thing you come back for, and it is also what gives
   the activity a cover, a grid card and a map pin — so the one moment
   the user certainly has it is the one moment to ask.

   **Only on the way in.** `compNew` gates it, so an activity completed
   before this rule existed — or one whose media was all removed
   afterwards — can still be edited and saved. Enforcing it on the edit
   pass would strand those rows: their owner could not save a
   correction to the date or the notes without first finding a photo of
   something they did years ago.

   Called from renderThumbs() (js/media.js), which every change to
   upMedia ends in, so the hint and the qualifier cannot drift out of
   step with the tiles.
   ============================================================== */
function updateMediaRequirement(){
  const hint=$('compMediaHint');
  renderCompMediaCard();
  /* Only while it is unmet — a rule restated over a grid that already
     satisfies it is nagging. */
  if(hint) hint.hidden=!(compNew&&!upMedia.length);
}

/* ==============================================================
   THE MEDIA CARD AND ITS PAGE

   The card names the cover and counts the rest, exactly as the Links
   card on the activity sheet does. Empty, it has no page worth
   opening, so it opens the picker instead — one tap either way.
   ============================================================== */
function renderCompMediaCard(){
  const thumb=$('compMediaThumb'),sum=$('compMediaSummary'),chev=$('compMediaChev');
  if(!sum)return;
  const n=upMedia.length,cover=coverIndex();
  if(thumb) thumb.innerHTML=n&&upMedia[cover]?mediaTileHTML(upMedia[cover]):icon('camera');
  if(thumb) thumb.classList.toggle('has-media',!!n);
  sum.textContent=!n?'Add a photo or video'
    :n===1?'1 item':`Cover +${n-1} more`;
  if(chev) chev.innerHTML=icon(n?'chevron-right':'plus');
  const back=$('compMediaBack');
  if(back&&!back.innerHTML) back.innerHTML=icon('chevron-left','ic-sm')+'Back';
}

/* Nothing attached yet means the page would be an empty grid and an Add
   button, which is the picker with a step in front of it. */
function openCompMedia(){
  if(!upMedia.length&&!_mediaPending){ $('photoInput').click(); return; }
  compShowPane('media');
}

function compShowPane(which){
  const panes={main:'compPaneMain',media:'compPaneMedia'};
  Object.keys(panes).forEach(k=>{
    const el=$(panes[k]); if(el) el.classList.toggle('active',k===which);
  });
  const body=document.querySelector('#compSheet .sheet-body');
  if(body) body.scrollTop=0;
}

/* The whole row opens the picker: on desktop the native calendar glyph
   is the only part of a date input a click opens it from, and that
   glyph is hidden here because the row already leads with one. */
function openCompDatePicker(){
  const el=$('compDate'); if(!el)return;
  el.focus();
  if(el.showPicker){ try{ el.showPicker(); }catch(e){} }
}

/* The name the check button and the date pill call. Completing and
   correcting a date are the same sheet now. */
function openCompletedDate(id,source){ return openComp(id,source); }

/* Opened *from* the activity sheet, which is the only place both the
   Edit button and the date pill live. Registering the return before
   opening means every way out of the edit sheet — Save, Cancel, the
   scrim, Escape, a swipe down — lands you back where you started rather
   than on the bare page behind it. */
/* Same contract as openCompFrom(), for the edit sheet: every way out of
   it — Save, Cancel, the scrim, Escape, a swipe down — lands back on the
   activity sheet it was opened from, freshly re-read so the edit shows. */
/* The detail sheet is deliberately LEFT OPEN underneath. Closing it
   first meant the edit sheet slid away over a bare page and the detail
   sheet slid back in a beat later, so Save and Cancel both flashed the
   screen behind — where the notes page, which only swaps panes inside
   one sheet, is seamless. #actSheet sits at a higher z-index so it
   covers the sheet it was opened from, and the return re-renders that
   sheet in place rather than re-presenting it. */
function openEditActFrom(id){
  onSheetClose('actSheet',()=>openActDetail(id));
  return openEditAct(id);
}

/* The detail sheet is deliberately LEFT OPEN underneath, exactly as
   openEditActFrom() leaves it: closing it first meant Save and Cancel
   both slid this sheet away over a bare page, with the detail sheet
   sliding back a beat later. #compSheet sits at a higher z-index so it
   covers it, and the return re-renders it in place. */
function openCompFrom(id){
  onSheetClose('compSheet',()=>openActDetail(id));
  return openComp(id);
}

async function confirmComplete(){
  if(!compId&&!compDraft)return;
  const name=$('compName').value.trim();
  if(!name){shakeEl($('compName'));$('compName').focus();return;}
  /* At least one photo or video, on the way in only — see
     updateMediaRequirement() for why the edit pass is exempt. An upload
     still running is a different answer from none: the user has already
     done the thing being asked for. */
  if(compNew&&!upMedia.length){
    if(_mediaPending){ showToast('Still adding that — one moment.'); return; }
    const sec=$('compMediaSec');
    shakeEl(sec);
    sec.scrollIntoView({block:'center',behavior:'smooth'});
    showToast('Add a photo or video to mark this accomplished.');
    return;
  }
  /* A draft is a brand-new activity, so it meets the location
     requirement like every other add. An edit of something already
     completed is exempt — see A LOCATION IS REQUIRED in location.js
     for why the edit pass is not the place to enforce a new rule. */
  if(compDraft&&!await requireLocation('compLoc',null,$('compSaveBtn'))) return;

  const fields={
    name,
    date_completed:$('compDate').value||todayISO(),
    location:$('compLoc').value.trim()||null,
    location_lat:parseFloat($('compLocLat').value)||null,
    location_lng:parseFloat($('compLocLng').value)||null,
    experience_notes:$('compNotes').value.trim()||null,
    photos:denormMedia(upMedia),
    ...homeFieldsFor('compLoc'),
  };

  /* A draft is an add, so it goes through the same gate every other add
     path does. Read off the sheet first, as saveActivity() does: the
     check can open a sheet on top of this one, and a value captured on
     the far side of that would come from a form the user has moved on
     from. */
  if(compDraft){
    dupeGuard({name,location:fields.location||''},()=>commitCompDraft(fields));
    return;
  }

  /* The Lists row can move the activity from here, which matters most
     for a completed one — the activity sheet hides "Edit details" once
     something is done, so this is the only way to refile it. Written
     only when the set actually changed, for the reason on
     compListsBefore. */
  const wasIn=compListsBefore.length?compListsBefore:[compList].filter(Boolean);
  const nowIn=targetListIds.length?targetListIds:wasIn;
  const cols=listFieldsFor(nowIn);
  const moved=cols&&(wasIn.length!==nowIn.length||wasIn.some((id,i)=>id!==nowIn[i]));
  if(moved) Object.assign(fields,cols);

  const btn=$('compSaveBtn');btn.disabled=true;
  const{error,offline}=await dbUpdate('Activities',fields,{id:compId});
  btn.disabled=false;
  if(error){
    console.error('confirmComplete:',error);
    showToast(error.message||'Couldn’t save.');
    return;
  }
  const wasNew=compNew,src=compSrc;
  closeModal('compSheet');
  compId=null;
  /* Both ends: a list gained needs recounting and so does one it was
     taken out of. */
  new Set([...wasIn,...nowIn,curListId].filter(Boolean)).forEach(id=>updateCollectionStats(id));
  if(wasNew){ confetti(); showToast(offline?'Accomplished — will sync later':'Accomplished'); }
  else showToast(offline?'Saved — will sync later':'Saved');
  refreshAfterChange(src);
}

/* The insert half of confirmComplete(). The id is minted client-side by
   dbInsert/stampRow, so this queues and replays like any other write —
   a helicopter ride logged on the flight home syncs when you land. */
async function commitCompDraft(fields){
  const lists=targetListIds.length?targetListIds:(curListId?[curListId]:[]);
  const cols=listFieldsFor(lists);
  if(!cols){showToast('Create a list first');return;}

  const btn=$('compSaveBtn');btn.disabled=true;
  /* Nothing about a plan applies to something already done: there is no
     target left to reach, and priority is about what to do next — the
     app draws neither on a completed activity. They are written as the
     column defaults rather than left out so the row matches every other
     one in the table. */
  const row=Object.assign({target_date:null,priority:'medium',links:[]},fields,cols);
  const{error,offline,rows}=await dbInsert('Activities',row);
  btn.disabled=false;
  if(error){
    console.error('commitCompDraft:',error);
    showToast(error.message||'Couldn’t save.');
    return;
  }
  const src=compSrc;
  closeModal('compSheet');
  compDraft=false;compId=null;
  lists.forEach(id=>updateCollectionStats(id));
  confetti();
  showToast(offline?'Accomplished — will sync later':'Accomplished');
  const newId=rows&&rows[0]&&rows[0].id;
  if(!revealNewActivity(lists[0],newId)) refreshAfterChange(src);
}

/* Where an add lands. Saving used to close the sheet and leave you on
   whatever screen you typed the name into — usually Home, which does
   not show the row you just wrote, so the one thing you wanted to see
   was the one thing you had to go and find. So an add ends on the list
   it was filed in, with the activity's own sheet open on top of it.
   Returns false when it has nothing to open, so the caller can fall
   back to the ordinary redraw. */
function revealNewActivity(listId,id){
  if(!listId||!id) return false;
  nav('detail',listId);
  /* Not onSheetClose(): closeModal() has already fired this sheet's
     return. The delay is the sheet's dismissal animation. */
  setTimeout(()=>openActDetail(id),240);
  return true;
}

/* ==============================================================
   FULL ACTIVITY SHEET (create / edit)

   Every field is on screen at once. There used to be a "More options"
   disclosure holding notes and links; it went the way of the one that
   used to hold Location, and for the same reason — a field nobody
   opens is a field nobody fills in. Target date and list share a line
   (.fg-pair), which is what buys the room for that.

   The notes field itself is gone too, and not because of the
   disclosure. "Why is this on your list?" is the wrong question at the
   moment of capture: the answer is the activity's name, so the field
   sat empty on nearly every row while still costing the sheet a block
   of height. What you thought about the thing afterwards has a place
   already — "How it went" on the completion sheet. The `description`
   column is still on the table and nothing writes it any more; see the
   note in CLAUDE.md before putting anything back.
   ============================================================== */
/* Which list the activity being edited will be filed in. Inside a
   collection that is that collection; opened from Home it is whatever
   the user picks in the sheet's List row.

   Still an array holding at most one id, and deliberately so: an
   activity used to be able to sit in several lists at once, and the
   shape is what lets every caller that walked the set carry on
   unchanged now that the set is always one long. setTargetLists()
   is the only writer, and it is where the cap lives — so there is
   exactly one line to change if that decision is ever revisited. */
let targetListIds=[],targetListId=null;

function setTargetLists(ids){
  targetListIds=(ids||[]).filter(Boolean).slice(0,1);
  targetListId=targetListIds[0]||null;
}

/* Why the sheet opened the way it did. The only caller that passes a
   message is a screenshot import that could not be read — rather than
   parking the user on a card explaining the failure, the sheet they were
   heading for anyway opens and says so in a line. Cleared on every open,
   so nothing leaks into the next activity. */
function setActivityNotice(msg){
  const box=$('actNotice');
  if(!box)return;
  if(!msg){ box.hidden=true; box.innerHTML=''; return; }
  box.innerHTML=`${icon('camera','ic-sm')}<span>${esc(msg)}</span>`;
  box.hidden=false;
}

async function openNewActivity(prefillName,notice){
  editingActId=null;aLinks=[];
  setActivityNotice(notice);
  setTargetLists(curListId?[curListId]:[]);
  await renderActListPicker();
  $('aName').value=prefillName||'';
  $('aLoc').value='';$('aLocLat').value='';$('aLocLng').value='';
  delete $('aLoc').dataset.geoFor;   /* nothing here belongs to the last activity */
  locSetHome('aLoc',false);
  resetLocationGuess(true);
  resetDateOptions();
  $('aDate').value=DEFAULT_TARGET_DATE;
  setPriorityChoice('medium');
  $('aDateCustom').value='';onTargetDateChange();
  renderTagChips('aLinks');
  /* The notes log belongs to the activity, so the field here is only
     ever "write the first entry" — it never shows what is already
     there. See notes.js. */
  resetActivityNoteField();
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
  setActivityNotice('');       /* never carries over from a failed import */
  setTargetLists([a.listId]);
  await renderActListPicker();
  $('aName').value=a.name;
  $('aLoc').value=a.location||'';$('aLocLat').value=a.locationLat||'';$('aLocLng').value=a.locationLng||'';
  if(a.location&&a.locationLat!=null) locGeoMark($('aLoc')); else delete $('aLoc').dataset.geoFor;
  /* Preserve the Home link across an edit that never touches the
     location — without this, saving would quietly sever it. */
  locSetHome('aLoc',a.locationIsHome);
  resetLocationGuess(false);
  /* An activity saved before "Someday"/"No date" were retired still
     carries that value. Put it back as an option for this one row, so
     opening the sheet and hitting Save cannot silently change the
     user's data — but keep it off the menu for everything else. */
  resetDateOptions();
  /* A stored date that is exactly what a band resolves to today reopens
     as that band, so picking "Next year" and coming back does not land
     the user in the specific-date field. bandForStored() matches
     exactly, so re-saving writes back the identical value. */
  const band=bandForStored(a.targetDate);
  if(band){
    $('aDate').value=band;
    $('aDateCustom').value='';
  } else if(isCustomDate(a.targetDate)){
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
  /* Empty on an edit too: the log is append-only and is read on the
     activity detail sheet. Filling this with the existing entries
     would invite them to be rewritten, which is the one thing a log
     must not allow. */
  resetActivityNoteField();
  setRemindField(a.remindAt,a.remindNote);
  $('actSheetTitle').textContent='Edit Activity';
  $('actSaveBtn').textContent='Save';
  openModal('actSheet');
}
/* The List row only appears when there is a choice to make: editing an
   existing activity, or creating one from outside a collection.

   Always single-select. An activity belongs to exactly one list. */
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
  /* An activity that already exists must always be in at least one
     list, so an edit falls back to the first. A NEW one created from
     outside a collection deliberately does not: filing it into
     whichever list happens to sort first is a silent, wrong answer the
     user never gave, and the one they wanted is one tap away. The row
     reads "Choose" and saveActivity() refuses until it is answered. */
  if(!targetListIds.length&&editingActId) setTargetLists([lists[0].id]);

  $('actListLabel').textContent='List';
  renderActListValue(lists);

  /* The handler goes on the button, not on the .fg around it: the group
     also holds the label, and tapping a label should do nothing. */
  $('actListBtn').onclick=()=>openListPicker({
    title:'Add to List',
    currentId:targetListId,
    onPick:picked=>{
      setTargetLists([picked]);
      renderActListValue(lists);
    },
  });
}

/* The chosen list's name, or "Choose" when there isn't one yet.

   Shared with the completion sheet's draft mode, which passes its own
   element id — the wording is the same on both, and two copies would be
   two things to keep in step. */
function renderActListValue(lists,elId){
  const el=$(elId||'actListName');
  if(!el)return;
  const home=lists.find(l=>l.id===targetListId);
  el.textContent=home?home.name:'Choose';
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
   this turns that plus the date field into the value actually stored.
   A band is resolved to the date it means *now* on the way out — see
   MAKING A BAND HOLD STILL in utils.js — so nothing downstream has to
   know it was ever a band. */
function readTargetDate(){
  const v=$('aDate').value;
  if(v!==CUSTOM_DATE) return resolveTargetDate(v)||null;
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

/* The Home flag, ready to merge into a write — or nothing at all
   without the column, since sending one the table does not have
   fails the whole insert. Same shape as listFieldsFor(), which lives
   in js/api.js beside the mapper that reads the column back. */
function homeFieldsFor(inputId){
  return homeFlagReady()?{location_is_home:locIsHome(inputId)}:{};
}

async function saveActivity(){
  const name=$('aName').value.trim();
  if(!name){shakeEl($('aName'));$('aName').focus();return;}
  /* "Specific date" with no date is not a choice. */
  if($('aDate').value===CUSTOM_DATE&&!$('aDateCustom').value){
    shakeEl($('aDateCustom'));$('aDateCustom').focus();return;
  }
  /* A location is required, and this is also what turns typed text into
     coordinates — so the fields below are read AFTER it, not before.
     See A LOCATION IS REQUIRED in js/location.js. */
  /* A new activity created from outside a collection has no list until
     the user picks one — see renderActListPicker(). Nothing is filed
     into a list nobody chose. */
  if(!editingActId&&!targetListIds.length){
    const btn=$('actListBtn');
    if(btn){shakeEl(btn);btn.scrollIntoView({block:'center',behavior:'smooth'});}
    showToast('Pick a list first');
    return;
  }
  if(!await requireLocation('aLoc','aLocError',$('actSaveBtn'))) return;
  const fields={
    name,
    location:$('aLoc').value.trim()||null,
    location_lat:parseFloat($('aLocLat').value)||null,
    location_lng:parseFloat($('aLocLng').value)||null,
    target_date:readTargetDate(),
    priority:$('aPri').value,
    links:aLinks,
    /* Whether this location IS home, so changing the home address
       later moves it. See "THIS ACTIVITY IS AT HOME" in api.js. */
    ...homeFieldsFor('aLoc'),
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

async function commitSaveActivity(fields,before){
  const btn=$('actSaveBtn');btn.disabled=true;
  try{
    /* An edit can move an activity between collections, so every end
       needs its stats rebuilt — the ones it left and the ones it landed
       in. Reading the old row before the write is the only way to know
       where it was. */
    let offline=false,noteFor=null;
    if(editingActId){
      const wasIn=(before&&before.listIds)||[];
      const nowIn=targetListIds.length?targetListIds:wasIn;
      const cols=listFieldsFor(nowIn);
      /* Only written when it actually changed, so an untouched edit
         does not rewrite collection_id at all. */
      const moved=cols&&(wasIn.length!==nowIn.length||wasIn.some((id,i)=>id!==nowIn[i]));
      if(moved) Object.assign(fields,cols);

      const r=await dbUpdate('Activities',fields,{id:editingActId});
      if(r.error)throw r.error;
      offline=!!r.offline;
      noteFor=editingActId;
      /* The union of both sets: a list gained needs recounting, and so
         does one it was taken out of. */
      new Set([...wasIn,...nowIn]).forEach(id=>updateCollectionStats(id));
    } else {
      const cols=listFieldsFor(targetListIds);
      if(!cols){showToast('Create a list first');return;}
      Object.assign(fields,cols);
      const r=await dbInsert('Activities',fields);
      if(r.error)throw r.error;
      offline=!!r.offline;
      /* The id was minted client-side by stampRow(), so the note can be
         filed against it immediately — even offline, where the activity
         itself is still sitting in the write queue. */
      noteFor=r.rows&&r.rows[0]&&r.rows[0].id;
      targetListIds.forEach(id=>updateCollectionStats(id));
    }
    /* After the activity, never as part of it: they are separate rows
       in separate tables, and a note that fails must not take the
       activity down with it. Not awaited — nothing on screen is
       waiting for it. */
    if(noteFor) flushActivityNoteField(noteFor);
    closeModal('actSheet');
    if(offline) showToast('Saved — will sync when you’re back online');
    /* A new activity lands on its list with its sheet open — see
       revealNewActivity(). An edit stays where it was: the user is
       already looking at the row they changed. */
    if(!editingActId&&revealNewActivity(targetListIds[0],noteFor)) return;
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

/* The completed sheet's photo stage: one container that fades between
   the media on its own. The interval stops itself once the stage has
   left the DOM, so nothing has to be torn down by hand. */
let adStageTimer=null;
function adStageIndex(){
  const st=document.querySelector('.ad-stage');if(!st)return 0;
  return [...st.querySelectorAll('.ad-slide')].findIndex(s=>s.classList.contains('on'))||0;
}
function startAdStage(){
  clearInterval(adStageTimer);adStageTimer=null;
  const st=document.querySelector('.ad-stage');if(!st)return;
  const sl=st.querySelectorAll('.ad-slide'),dots=st.querySelectorAll('.ad-dots i');
  if(sl.length<2)return;
  let n=0;
  adStageTimer=setInterval(()=>{
    if(!document.body.contains(st)){clearInterval(adStageTimer);adStageTimer=null;return;}
    sl[n].classList.remove('on');dots[n]&&dots[n].classList.remove('on');
    n=(n+1)%sl.length;
    sl[n].classList.add('on');dots[n]&&dots[n].classList.add('on');
  },3500);
}

/* The countdown block on a pending activity's plate. dateInfo() gives
   one string; the plate wants it split into a numeral and its unit, so
   "18 days left" reads as 18 over DAYS. Anything that is not a count —
   a specific date, "Someday", an open band — falls through as one
   `.open` label at the same size, because a smaller mono fallback made
   the two read as different kinds of thing. */
function countdownParts(di){
  const m=/^(\d+\+?)\s+(\w+)/.exec(di.label||'');
  if(m) return{big:m[1],unit:m[2],open:false};
  return{big:di.label||'—',unit:'target',open:true};
}

async function openActDetail(id){
  const a=await fetchActivity(id);if(!a)return;
  editingActId=null;
  /* Pending activities carry the notes log inline. It used to be
     fetched behind the open sheet, which meant the section appeared a
     beat after everything else and shoved the sheet's contents around
     as it landed. The fetch starts here instead, in parallel with the
     collections read, and is awaited before anything is painted — so
     the sheet opens once, complete. */
  const inlineNotes=!a.completed&&notesReady();
  const notesP=inlineNotes?fetchNotes(a.id):null;
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

     Both states carry the same pair of full-width badges — state and
     date when it is done, priority and deadline when it is not — and
     the name is centred over them on a completed activity, where the
     sheet is a record rather than a plan. */
  /* Pending activities split the sheet in two: Details and Notes.
     The notes log needs room to be worked in, and it was competing
     with the photos and the action buttons for the same screen. A
     completed activity has no notes tab at all — the record is the
     photos and "How it went". The bar sits above the title, and the
     Notes pane carries neither title nor badges. */

  let h='';
  /* The pending sheet is one scrolling pane plus a notes page that
     replaces it — no tab bar. The notes section on the details pane
     is a preview and is entirely a button; tapping it opens the page,
     which is where the composer lives. */
  /* Pending activities are a stack of pages inside one sheet: the
     details, the notes log, and the links. The wrapper therefore opens
     for every pending activity, not only when the notes migration is
     in place — links are a page regardless. */
  const panes=!a.completed;
  if(panes) h+=`<div class="ad-pane active" id="adPaneDetails">`;
  /* A completed activity's actions are docked at the foot of the sheet
     in one row, the same shape the pending sheet uses — so the record
     itself (title, photos and words) starts at the top. */
  /* No tab bar on a pending activity. The B-13 layout puts the notes
     log inline, directly under the reference cards — see "PENDING
     ACTIVITY SHEET" in detail.css. */
  if(a.completed){
    h+=`<div class="ad-head">
      <div class="ad-title centered">${esc(a.name)}</div>
      <div class="ad-badges">
        <button class="badge ad-datebtn" onclick="openCompFrom('${a.id}')">
          ${icon('calendar','ic-xs')}${esc(a.completedDate?fmtDate(a.completedDate,true):'Set date')}
        </button>
        ${a.location?`<span class="badge ad-locbadge">${icon('pin','ic-xs')}<span>${esc(a.location)}</span></span>`:''}
      </div></div>`;
  } else {
    /* Pending: the plate, then the plan as chips, then a card per
       reference field. See "PENDING ACTIVITY SHEET" in detail.css. */
    const cd=countdownParts(di);
    const pri=a.priority||'medium';
    const target=a.targetDate
      ? (isCustomDate(a.targetDate)?fmtDate(a.targetDate,true):a.targetDate)
      : '';
    h+=`<div class="ad-plate">
      <div class="ad-plate-main">
        ${lists.length?`<p class="t-eyebrow">${esc(lists[0].name)}</p>`:''}
        <div class="ad-title">${esc(a.name)}</div>
      </div>
      <div class="ad-cdown${cd.open?' open':''}">
        <b>${esc(cd.big)}</b><span>${esc(cd.unit)}</span>
      </div></div>`;
    h+=`<div class="ad-chips">
      <span class="ad-chip c-${pri}"><small>Priority</small>${cap(pri)}</span>
      ${target?`<span class="ad-chip c-target"><small>Target</small><b>${esc(target)}</b></span>`:''}
      <span class="ad-chip c-remind"><small>Remind</small>${a.remindAt?esc(fmtDate(a.remindAt)):'None'}</span>
    </div>`;
    if(a.location){
      h+=`<div class="ad-place c-where">
        <span class="ad-place-disc">${icon('pin')}</span>
        <div class="ad-place-body">
          <span class="ad-place-k">Where</span>
          <div class="ad-place-v">${esc(a.location)}</div>
        </div>
        <span class="ad-place-chev">${icon('chevron-right')}</span></div>`;
    }
    /* ONE Links card, whatever the count. A card per link turned an
       activity with four references into four near-identical blocks
       pushing everything else down the sheet — and none of them was
       editable. The card names the first link, counts the rest, and is
       a button onto the Links page, exactly as the notes preview is.
       Empty reads "None": a field that vanishes when empty leaves the
       sheet saying nothing about whether it was ever filled in. */
    adLinks=[...(a.links||[])];adLinksFor=a.id;
    h+=`<div class="ad-place c-link" id="adLinkCard" role="button" tabindex="0"
      onclick="openActLinks()">
      <span class="ad-place-disc">${icon('link')}</span>
      <div class="ad-place-body">
        <span class="ad-place-k">Links</span>
        <div class="ad-place-v" id="adLinkSummary">${esc(adLinkSummary())}</div>
      </div>
      <span class="ad-place-chev">${icon('chevron-right')}</span></div>`;
    /* The log, inline, below the reference cards. Rendered from notes
       already in hand — see the fetch at the top of this function. */
    if(inlineNotes) h+=`<div class="ad-nsec" id="adNotes" data-for="${esc(a.id)}"
      role="button" tabindex="0" onclick="openActNotes()"></div>`;
  }

  h+=`<div class="ad-head">`;

  /* MEDIA IS SHOWN ONLY WHILE THE ACTIVITY IS ACCOMPLISHED.

     Marking something not-done writes only `date_completed` — the
     media stays on the row untouched (see ONE-TAP COMPLETE above) and
     openComp() reads it straight back into `upMedia`, so completing it
     again brings every photo and video back exactly as it was. It is
     hidden here rather than deleted because the pending sheet is a
     plan: a record of having done the thing has no place on it. */
  if(a.completed&&media.length){
    /* One large stage that fades between the media on its own, and
       opens the lightbox when tapped. */
    h+=`<div class="ad-stage" onclick="openLB(${mediaArg},adStageIndex())">
      ${media.map((m,i)=>`<div class="ad-slide${i?'':' on'}">${mediaTileHTML(m)}</div>`).join('')}
      ${media.length>1?`<div class="ad-dots">${media.map((_,i)=>
        `<i class="${i?'':'on'}"></i>`).join('')}</div>`:''}
    </div>`;
  } else if(a.completed&&media.length===1){
    h+=`<div class="ad-hero-wrap" onclick="openLB(${mediaArg},0)">
      ${mediaTileHTML(media[0],'ad-hero')}</div>`;
  } else if(a.completed&&media.length>1){
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
  const mediaCount=(()=>{const ph=media.filter(m=>m.type!=='video').length,
    vd=media.length-ph,parts=[];
    if(ph)parts.push(ph+(ph===1?' photo':' photos'));
    if(vd)parts.push(vd+(vd===1?' video':' videos'));
    return parts.join(', ');})();
  if(a.completed&&a.completionNotes){
    h+=`<div class="ad-section ad-note-sec"><div class="ad-section-label ad-note-head">How it went${
      mediaCount?`<span class="ad-count">${mediaCount}</span>`:''}</div>
      <div class="ad-note prose">${esc(a.completionNotes)}</div></div>`;
  }
  /* The notes log. A placeholder now and filled in behind the sheet by
     renderActivityNotes(), because it is a round trip and nothing else
     on this sheet should wait for it — the photos and the buttons are
     what the sheet is about.

     It sits directly under the media rather than down with location
     and links: on a shared list this is the working state of the plan,
     which is the reason somebody opened the activity at all. Reference
     fields go below it. */

  /* Which lists it is in, but only once that is news. At one list the
     answer is the screen you came from, and a section restating it on
     every activity in the app would be noise on the overwhelming
     majority of them. At two or more it is the only place the app says
     so, and it is what makes the feature visible at all. */
  /* Location and links are the two tinted cards up on the plate for a
     pending activity, so only a completed one repeats them here. */
  if(a.completed&&a.links&&a.links.length){
    h+=`<div class="ad-section"><div class="ad-section-label">Links</div>
      <div class="group ad-links" style="margin:0">${a.links.map(l=>
        `<a class="ad-link" href="${esc(l)}" target="_blank" rel="noopener">
           ${icon('link','ic-sm')}<span>${esc(l.replace(/^https?:\/\//,''))}</span>
         </a>`).join('')}</div></div>`;
  }

  /* Every action lives in the dock at the foot of the sheet, or in the
     bar at the top of a completed one — nothing is left in the flow.
     There used to be a "remove from this list" button here, for an
     activity that was also in other lists; it went with multi-list. */

  /* The notes page and the links page. Same scroller, swapped in by
     openActNotes()/openActLinks(); each has its own back bar, and each
     composer rides the dock. */
  if(panes){
    h+=`</div>`;
    if(inlineNotes) h+=`<div class="ad-pane" id="adPaneNotes">
      <div class="ad-navbar">
        <button class="ad-back" onclick="adShowPane('details')">${icon('chevron-left','ic-sm')}Back</button>
        <span class="ad-navtitle">Notes</span>
      </div>
      <div class="ad-notes-pane" id="adNotesFull"></div>
    </div>`;
    h+=`<div class="ad-pane" id="adPaneLinks">
      <div class="ad-navbar">
        <button class="ad-back" onclick="adShowPane('details')">${icon('chevron-left','ic-sm')}Back</button>
        <span class="ad-navtitle">Links</span>
      </div>
      <div class="ad-links-pane" id="adLinksFull"></div>
    </div>`;
  }

  $('actDetailBody').innerHTML=h;

  /* The dock is a sibling of the scroller, not part of it, so it is
     pinned to the foot of the sheet and inset by the same gutters as
     everything above it. Both states get one: edit / not-done /
     delete when it is completed, and the pending trio otherwise. */
  const dock=$('actDetailDock');
  dock.hidden=false;
  dock.innerHTML=a.completed?`
    <div class="ad-dock-view">
      <button class="ad-dock-disc red" aria-label="Delete"
        onclick="confirmDeleteActivity('${a.id}','${esc(a.name).replace(/'/g,'&#39;')}')">
        ${icon('trash')}</button>
      <button class="ad-dock-disc" aria-label="Mark as not done"
        onclick="closeModal('actDetailSheet');toggleComplete('${a.id}',true)">${icon('undo')}</button>
      <button class="btn btn-filled btn-block" onclick="openCompFrom('${a.id}')">
        ${icon('pencil')}Edit
      </button>
    </div>`:`
    <div class="ad-dock-view" id="adDockActions">
      <button class="ad-dock-disc red" aria-label="Delete"
        onclick="confirmDeleteActivity('${a.id}','${esc(a.name).replace(/'/g,'&#39;')}')">
        ${icon('trash')}</button>
      <button class="ad-dock-disc" aria-label="Edit details"
        onclick="openEditActFrom('${a.id}')">${icon('pencil')}</button>
      <button class="btn btn-green btn-block"
              onclick="closeModal('actDetailSheet');toggleComplete('${a.id}',false)">
        ${icon('check')}Mark accomplished
      </button>
    </div>
    ${panes?`<div class="ad-dock-view" id="adDockLink" hidden>
      <div class="note-add">
        <input id="adLinkInput" type="url" inputmode="url" autocomplete="off"
          autocapitalize="off" spellcheck="false" placeholder="Paste a URL"
          onkeydown="onLinkKey(event)" />
        <button class="note-add-go show" onclick="addActLink()"
          aria-label="Add link">${icon('plus','ic-sm')}</button>
      </div></div>`:''}
    ${inlineNotes?`<div class="ad-dock-view" id="adDockNote" hidden>
      <div class="note-add">
        <textarea id="adNoteInput" rows="1" maxlength="1000"
          placeholder="Add a note…" autocapitalize="sentences"
          oninput="onNoteInput()" onkeydown="onNoteKey(event)"></textarea>
        <button class="note-add-go" id="adNoteGo" onclick="submitActivityNote('${esc(a.id)}')"
          aria-label="Add note">${icon('plus','ic-sm')}</button>
      </div></div>`:''}`;

  /* Painted before the sheet is shown, so nothing moves once it is
     open. The avatars still land behind it — a face arriving a moment
     after the words changes no layout. */
  if(inlineNotes){
    /* The avatars are awaited HERE too, not repainted behind the open
       sheet. Painting twice re-wrote the section's innerHTML a beat
       after it was on screen, which is the flash this was supposed to
       have fixed. The map is cached per collection, so only the first
       activity opened in a list pays for it at all. */
    const cid=noteCollectionId(a.id);
    const [notes]=await Promise.all([notesP,cid?loadConversationAvatars(cid):null]);
    paintActivityNotes(a.id,notes,cid);
  }

  openModal('actDetailSheet');
  startAdStage();
}

/* The notes page replaces the details pane rather than sitting beside
   it: the log needs the whole sheet to be worked in, and the dock
   swaps the action bar for the composer so there is only ever one
   thing at the foot of the sheet. */
function openActNotes(){ adShowPane('notes'); }
function closeActNotes(){ adShowPane('details'); }
function openActLinks(){ renderActLinks(); adShowPane('links'); }

/* One switch for all three pages, so a page added later cannot forget
   to hide somebody else's dock. */
function adShowPane(which){
  const panes={details:'adPaneDetails',notes:'adPaneNotes',links:'adPaneLinks'};
  Object.keys(panes).forEach(k=>{
    const el=$(panes[k]); if(el) el.classList.toggle('active',k===which);
  });
  const docks={details:'adDockActions',notes:'adDockNote',links:'adDockLink'};
  Object.keys(docks).forEach(k=>{
    const el=$(docks[k]); if(el) el.hidden=(k!==which);
  });
  const body=$('actDetailBody');
  if(body) body.scrollTop=0;
}

/* ==============================================================
   THE LINKS PAGE

   Links used to be a chip field on the create/edit sheet, which meant
   they could only be added at the moment of capture — exactly when
   nobody has them — and a reference added later cost a full edit pass.
   They are a page on the activity itself now, written one at a time
   like notes, and the write is a single `links` column update rather
   than anything the edit sheet has to know about.
   ============================================================== */
let adLinks=[],adLinksFor=null;

/* What the card on the details page says. One link named, the rest
   counted — the same trade the Lists row makes. */
function adLinkSummary(){
  if(!adLinks.length) return 'None';
  const first=adLinks[0].replace(/^https?:\/\//,'');
  return adLinks.length>1?`${first} +${adLinks.length-1} more`:first;
}

function renderActLinks(){
  const box=$('adLinksFull');
  if(!box)return;
  box.innerHTML=adLinks.length
    ? adLinks.map((l,i)=>`<div class="link-row">
        <a href="${esc(l)}" target="_blank" rel="noopener">
          ${icon('link','ic-sm')}<span>${esc(l.replace(/^https?:\/\//,''))}</span></a>
        <button class="link-del" onclick="removeActLink(${i})"
          aria-label="Remove link">${icon('x','ic-xs')}</button>
      </div>`).join('')
    : `<div class="note-empty"><p>No links yet</p></div>`;
  const sum=$('adLinkSummary');
  if(sum) sum.textContent=adLinkSummary();
}

function onLinkKey(e){ if(e.key==='Enter'){e.preventDefault();addActLink();} }

function addActLink(){
  const f=$('adLinkInput');if(!f)return;
  let v=f.value.trim();
  if(!v)return;
  if(!/^https?:\/\//i.test(v)) v='https://'+v;
  if(!adLinks.includes(v)) adLinks.push(v);
  f.value='';
  renderActLinks();
  saveActLinks();
}

function removeActLink(i){
  adLinks.splice(i,1);
  renderActLinks();
  saveActLinks();
}

/* Written straight through — the page has no Save, the way the notes
   log has none. Not awaited by anything on screen; a failure puts the
   stored value back so the page cannot claim a link it does not have. */
async function saveActLinks(){
  if(!adLinksFor)return;
  const id=adLinksFor,next=[...adLinks];
  const r=await dbUpdate('Activities',{links:next},{id});
  if(r.error){
    showToast('Couldn’t save that link');
    const a=await fetchActivity(id);
    if(a&&adLinksFor===id){adLinks=[...(a.links||[])];renderActLinks();}
    return;
  }
  /* The edit sheet carries the links through untouched on Save, so the
     copy it is holding has to keep up. */
  if(editingActId===id) aLinks=[...next];
  refreshAfterChange();
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

  /* The conversation is reachable from here as well as from the
     Messages tab, because those are the two places people look for it:
     the hub when they are catching up, the list when they are already
     looking at the thing being discussed. Only shown where there is
     actually a conversation — a list nobody else is in has nobody to
     talk to. See js/messages.js. */
  if(listHasConversation(curListId)){
    items.splice(3,0,{label:'Messages',icon:'message',
      onSelect:()=>openConversationForList(curListId)});
  }
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
  /* Both the lit segment and the sort label live in the control row,
     which renderDetail() now builds once per collection — so the two
     things that change without it are updated in one place. */
  syncDetailControls();
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
  syncDetailControls();
  /* Order means nothing to a map, so there is nothing to redraw there —
     and a re-render would zoom it back out from under the user, the
     same trap setFilter() sidesteps. */
  if(curView==='map') return;
  renderActivitiesList();
}
