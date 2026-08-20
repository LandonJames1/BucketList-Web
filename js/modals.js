/* ==============================================================
   MODALS — sheet open/close, the action sheet used for overflow
   menus and destructive confirms, the photo lightbox, and the
   toast.

   iOS confirms destructive actions with an action sheet rather
   than a dialog, so showConfirm() below builds one instead of
   the old fixed confirmation modal.
   ============================================================== */

function openModal(id){
  const el=$(id);
  /* A sheet keeps its scrollTop between openings, so once you have
     scrolled one down — to reach the buttons at the bottom of the
     activity sheet, say — every later opening starts there and whatever
     is at the top is silently missing. That is why the activity sheet
     looked like it had no title: it was scrolled past it, and the
     grabber is position:absolute so the sheet still looked like it was
     at the top. Reset before showing. */
  el.querySelectorAll('.sheet-body').forEach(b=>{b.scrollTop=0;});
  el.classList.add('open');
  setBodyScrollLock(true);
}
function closeModal(id){
  $(id).classList.remove('open');
  releasePickerRoom(null);
  setBodyScrollLock(false);
  afterSheetClosed(id);
}

/* ==============================================================
   GOING BACK TO THE SHEET YOU CAME FROM

   A sheet opened from another sheet should return to it when it is
   done, however it was dismissed — Save, Cancel, the scrim, Escape, or
   a swipe down. Registering the return here rather than on the Save
   button is what makes all five paths behave the same; hanging it off
   Save alone meant Cancel dropped you on the bare page.

   Every dismissal therefore has to go through closeModal() or call
   afterSheetClosed() itself — see the swipe handler in gestures.js.
   Returns fire once and are then forgotten, so a sheet reopened by
   hand does not inherit the last one's.
   ============================================================== */
const _sheetReturns={};

function onSheetClose(id,fn){ _sheetReturns[id]=fn; }

function afterSheetClosed(id){
  const fn=_sheetReturns[id];
  if(!fn)return;
  delete _sheetReturns[id];
  /* Immediately: the returning sheet has to be on screen while the one
     being dismissed slides away. A delay left the bare page showing for
     a quarter second, which read as everything disappearing. */
  fn();
}

/* Leaving the screen entirely cancels any pending return — a tab tap
   must not resurrect a sheet on the page it just left. */
function clearSheetReturns(){
  Object.keys(_sheetReturns).forEach(k=>delete _sheetReturns[k]);
}

/* Tapping the dimmed area behind a sheet dismisses it. */
document.querySelectorAll('.modal-overlay').forEach(o=>{
  o.addEventListener('click',e=>{
    if(e.target===o) closeModal(o.id);
  });
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if($('lightbox').classList.contains('open')){closeLightbox();return;}
    if($('actionSheet').classList.contains('open')){closeActionSheet();return;}
    document.querySelectorAll('.modal-overlay.open').forEach(m=>closeModal(m.id));
  }
  if($('lightbox').classList.contains('open')){
    if(e.key==='ArrowLeft') lbStep(-1);
    if(e.key==='ArrowRight') lbStep(1);
  }
});

/* ==============================================================
   ROOM FOR A DATE PICKER

   A native date picker opens as a panel anchored to its field, and the
   browser will happily run it off the bottom of the window. Every date
   field in this app lives in a bottom-anchored sheet, which is the
   worst case for it: the reminder sheet is short, so its field sits low
   and the calendar had nowhere to go.

   The picker's own placement is the browser's business and cannot be
   set from here. What can be controlled is how much room the field has
   underneath it — so when a date field is focused with less than a
   picker's height below it, the sheet is given that much extra
   scrollable space and scrolled by the same amount, lifting the field
   up the screen. The space is a ::after spacer rather than padding, so
   nothing has to know the sheet's real padding to undo it.

   It only fires when the room is genuinely missing, and is released as
   soon as the field is done with.
   ============================================================== */
const PICKER_ROOM=310;

function ensurePickerRoom(el){
  const body=el.closest('.sheet-body');
  if(!body)return;
  releasePickerRoom(body);
  /* Measure after the release, or a previous spacer skews the result. */
  requestAnimationFrame(()=>{
    const gap=window.innerHeight-el.getBoundingClientRect().bottom;
    if(gap>=PICKER_ROOM)return;
    /* Clamped, because the sheet may still be sliding in — it is
       tappable before it has settled, so a field focused mid-animation
       measures from wherever the sheet had got to and would otherwise
       ask for a spacer the size of the whole screen. */
    const need=Math.min(PICKER_ROOM,Math.ceil(PICKER_ROOM-gap));
    body.style.setProperty('--picker-room',need+'px');
    body.classList.add('has-picker-room');
    /* The sheet may grow to its max-height first, which moves the field
       up on its own; scroll by whatever is still missing. */
    requestAnimationFrame(()=>{
      const left=PICKER_ROOM-(window.innerHeight-el.getBoundingClientRect().bottom);
      if(left>0) body.scrollTop+=left;
    });
  });
}

function releasePickerRoom(body){
  const targets=body?[body]:[...document.querySelectorAll('.sheet-body.has-picker-room')];
  targets.forEach(b=>{
    b.classList.remove('has-picker-room');
    b.style.removeProperty('--picker-room');
  });
}

document.addEventListener('focusin',e=>{
  const el=e.target;
  if(el.tagName==='INPUT'&&el.type==='date') ensurePickerRoom(el);
},true);
document.addEventListener('focusout',e=>{
  const el=e.target;
  if(el.tagName==='INPUT'&&el.type==='date'){
    /* Let the picker's own dismissal settle before the sheet moves. */
    setTimeout(()=>{ if(document.activeElement!==el) releasePickerRoom(null); },120);
  }
},true);

/* ==============================================================
   ACTION SHEET

   showActionSheet({title, message, items:[{label, icon, role,
   checked, onSelect}], cancelLabel})

   role: 'destructive' tints it red; 'cancel' is added automatically.
   Handlers are held in a module-level array rather than inlined as
   strings, so items can close over real values.
   ============================================================== */
let _asHandlers=[];

function showActionSheet(opts){
  const el=$('actionSheet');
  const items=opts.items||[];
  _asHandlers=items.map(i=>i.onSelect);

  let head='';
  if(opts.title||opts.message){
    head=`<div class="as-heading">${opts.title?`<strong>${esc(opts.title)}</strong>`:''}${opts.message?esc(opts.message):''}</div>`;
  }
  const body=items.map((i,idx)=>{
    const cls=['as-item'];
    if(i.role==='destructive') cls.push('destructive');
    /* A checkable item reserves a leading checkmark slot so the labels
       stay aligned whether or not they are selected. */
    const check=i.checked!==undefined?`<span class="as-check">${icon('check','ic-sm')}</span>`:'';
    return `<button class="${cls.join(' ')}"${i.checked!==undefined?` aria-checked="${!!i.checked}"`:''} onclick="_asPick(${idx})">${check}${i.icon?icon(i.icon,'ic-sm'):''}<span>${esc(i.label)}</span></button>`;
  }).join('');

  el.querySelector('.as-panel').innerHTML=
    `<div class="as-group">${head}${body}</div>`+
    `<div class="as-group"><button class="as-item cancel" onclick="closeActionSheet()">${esc(opts.cancelLabel||'Cancel')}</button></div>`;

  el.classList.add('open');
  setBodyScrollLock(true);
}
function _asPick(idx){
  const fn=_asHandlers[idx];
  closeActionSheet();
  /* Let the dismissal animation start before the handler runs, so a
     handler that opens another sheet does not fight this one. */
  if(fn) setTimeout(fn,180);
}
function closeActionSheet(){
  $('actionSheet').classList.remove('open');
  _asHandlers=[];
  setBodyScrollLock(false);
}
$('actionSheet').addEventListener('click',e=>{
  if(e.target===$('actionSheet')) closeActionSheet();
});

/* Destructive confirmation, iOS-style: the red verb is the action
   sheet's first item, Cancel is the escape. */
function showConfirm({title,message,confirmLabel,onConfirm}){
  showActionSheet({
    title,message,
    items:[{label:confirmLabel||'Delete',role:'destructive',onSelect:onConfirm}],
  });
}

/* ==============================================================
   DELETE ENTRY POINTS
   ============================================================== */
function confirmDeleteCollection(){
  showConfirm({
    title:'Delete Collection',
    message:'This deletes the collection and all of its activities. This cannot be undone.',
    confirmLabel:'Delete Collection',
    onConfirm:()=>delList(curListId),
  });
}
/* `inLists` is how many lists the activity belongs to. It changes what
   this warning has to say: deleting from inside one list, when the
   activity is also in three others, destroys it in all four — and the
   user is standing on a screen that shows them one. Saying so is the
   difference between a confirmation and a trap. Removing it from just
   this list is the other button on the sheet. */
function confirmDeleteActivity(id,name,inLists){
  const many=inLists>1;
  showConfirm({
    title:'Delete Activity',
    message:(name?`"${name}" will be permanently deleted`:'This cannot be undone')+
      (many?`, and removed from all ${inLists} lists it is in.`:'.'),
    confirmLabel:many?'Delete Everywhere':'Delete',
    onConfirm:async()=>{closeModal('actDetailSheet');await delActivity(id);},
  });
}

/* ==============================================================
   LIST PICKER

   One sheet, used everywhere an activity needs to be assigned to a
   collection: the Home composer and the activity sheet's List row.

   Both used showActionSheet(), which stacks a 57px full-width button
   per list — readable at three lists, an unusable tower at twenty. This
   scrolls, shows a cover thumbnail per row so lists are recognisable at
   a glance, and only shows a search field once there are enough lists
   for scanning to be slower than typing.

   ---- Two modes ----

   Single: tapping a row picks it and closes. `onPick` gets an id.

   Multi (`multi:true`): rows toggle, the bar grows a Done button, and
   `onPick` gets an **ordered array** of ids. The order is the thing to
   preserve — the first entry is the activity's home list, which is the
   one every part of the app names when it has room for exactly one
   (see activityListIds in js/api.js). So a row being re-checked goes
   to the end rather than back where it was, and unchecking the first
   promotes the second.

   The whole set cannot be empty. An activity in no list is reachable
   from nowhere, so the last checked row refuses to uncheck rather than
   silently leaving the sheet in a state Done would have to reject.
   ============================================================== */
let _lpLists=[],_lpOnPick=null,_lpCurrentId=null,_lpMulti=false,_lpPicked=[];

/* openListPicker({subtitle, currentId, currentIds, multi, title, onPick}) */
async function openListPicker(opts){
  opts=opts||{};
  _lpOnPick=opts.onPick||null;
  _lpMulti=!!opts.multi;
  _lpCurrentId=opts.currentId||null;
  _lpPicked=_lpMulti?(opts.currentIds||[]).filter(Boolean).slice():[];

  $('listPickerTitle').textContent=opts.title||(_lpMulti?'Lists':'Add to List');
  const sub=$('listPickerSub');
  if(opts.subtitle){sub.textContent=opts.subtitle;sub.style.display='';}
  else sub.style.display='none';

  /* The Done button only exists in multi mode: with one tap per choice
     there is nothing to confirm, and a sheet that closes itself must
     not also offer a button that closes it. */
  $('listPickerDone').style.display=_lpMulti?'':'none';
  $('listPickerDoneSpacer').style.display=_lpMulti?'none':'';

  if(!cacheWarm()) $('listPickerRows').innerHTML='<div class="spinner"></div>';
  openModal('listPickerSheet');

  _lpLists=await fetchCollections();

  /* Search earns its place only when there is enough to search. */
  const needsSearch=_lpLists.length>7;
  $('listPickerSearchWrap').style.display=needsSearch?'':'none';
  $('listPickerSearch').value='';
  renderListPickerRows();
  if(needsSearch) setTimeout(()=>$('listPickerSearch').focus(),340);
}

function renderListPickerRows(){
  const box=$('listPickerRows');
  const el=$('listPickerSearch');
  const term=(el&&$('listPickerSearchWrap').style.display!=='none'?el.value:'').trim().toLowerCase();
  const rows=term?_lpLists.filter(l=>l.name.toLowerCase().includes(term)):_lpLists;

  if(!rows.length){
    box.innerHTML=`<div class="lp-empty">${term?'No lists match that.':'No lists yet.'}</div>`;
    return;
  }
  box.innerHTML=rows.map(l=>{
    const at=_lpMulti?_lpPicked.indexOf(l.id):-1;
    const on=_lpMulti?at>=0:l.id===_lpCurrentId;
    /* Only in multi mode, and only once there is more than one, is
       "which is the home list" a question worth answering on screen —
       it is what a row's chip says elsewhere in the app, so the sheet
       has to say which one it will be. */
    const home=_lpMulti&&at===0&&_lpPicked.length>1
      ?'<span class="lp-home">Home</span>':'';
    return `<button class="lp-row${on?' current':''}" onclick="listPickerPick('${l.id}')">
       <img class="lp-cover" src="${esc(coverFor(l))}" alt="" loading="lazy"/>
       <span class="lp-name">${esc(l.name)}</span>
       ${home}
       <span class="lp-check">${icon('check')}</span>
     </button>`;
  }).join('');
}

function listPickerPick(id){
  if(_lpMulti){
    const at=_lpPicked.indexOf(id);
    if(at<0) _lpPicked.push(id);
    else if(_lpPicked.length>1) _lpPicked.splice(at,1);
    else { shakeEl($('listPickerRows')); return; }   /* the last one stays */
    renderListPickerRows();
    return;
  }
  const fn=_lpOnPick;
  closeModal('listPickerSheet');
  if(fn) setTimeout(()=>fn(id),160);
}

/* Multi mode only. Cancel and the scrim both leave without calling
   back, so the activity sheet behind this keeps whatever it had. */
function listPickerDone(){
  const fn=_lpOnPick,picked=_lpPicked.slice();
  closeModal('listPickerSheet');
  if(fn) setTimeout(()=>fn(picked),160);
}

/* "New List" just opens the list sheet. The Home composer deliberately
   does not clear its input until an activity is actually filed, so the
   typed name is still sitting there afterwards and one more return
   files it into the list that was just created. */
function listPickerCreateNew(){
  closeModal('listPickerSheet');
  setTimeout(()=>{ openNewList(); },160);
}

/* ==============================================================
   LIGHTBOX
   ============================================================== */
/* Entries are the normalised media shape from api.js —
   {type,url,poster} — so the same viewer handles photos and video. A
   bare string or array of strings is still accepted, since plenty of
   call sites only ever have photo URLs. */
let lbPhotos=[],lbIdx=0;
function openLB(items,startIdx){
  if(typeof items==='string') items=[items];
  lbPhotos=(items||[]).map(m=>typeof m==='string'?{type:'photo',url:m}:m);
  lbIdx=startIdx||0;
  lbShow();
  $('lightbox').classList.add('open');
  setBodyScrollLock(true);
}
function lbShow(){
  const m=lbPhotos[lbIdx]||{type:'photo',url:''};
  const img=$('lbImg'),vid=$('lbVideo');
  const isVideo=m.type==='video';
  /* Whatever is not showing is emptied, not just hidden: a <video> with
     a src keeps buffering, and an <img> holding a large photo keeps it
     decoded. */
  if(isVideo){
    img.style.display='none';img.src='';
    vid.style.display='';vid.src=m.url;
    if(m.poster) vid.poster=m.poster;
  } else {
    vid.pause();vid.removeAttribute('src');vid.load();
    vid.style.display='none';
    img.style.display='';img.src=m.url;
  }
  $('lbCounter').textContent=lbPhotos.length>1?`${lbIdx+1} of ${lbPhotos.length}`:'';
  $('lbPrev').style.display=lbPhotos.length>1?'flex':'none';
  $('lbNext').style.display=lbPhotos.length>1?'flex':'none';
}
function lbStep(dir){
  if(!lbPhotos.length)return;
  lbIdx=(lbIdx+dir+lbPhotos.length)%lbPhotos.length;
  lbShow();
}
function closeLightbox(){
  $('lightbox').classList.remove('open');
  /* Stop playback on the way out, or the audio keeps going over
     whatever screen is underneath. */
  const vid=$('lbVideo');
  if(vid){vid.pause();vid.removeAttribute('src');vid.load();}
  lbPhotos=[];lbIdx=0;
  setBodyScrollLock(false);
}

/* Swipe between photos — the gesture a phone user reaches for first. */
let lbTouchX=null,lbTouchY=null;
$('lightbox').addEventListener('touchstart',e=>{
  if(e.touches.length!==1){lbTouchX=null;return;}
  lbTouchX=e.touches[0].clientX;lbTouchY=e.touches[0].clientY;
},{passive:true});
$('lightbox').addEventListener('touchend',e=>{
  if(lbTouchX===null||!lbPhotos.length)return;
  const t=e.changedTouches[0];
  const dx=t.clientX-lbTouchX,dy=t.clientY-lbTouchY;
  lbTouchX=null;
  /* Dragging on the video is scrubbing its controls, not a gesture. */
  if(e.target&&e.target.closest&&e.target.closest('#lbVideo'))return;
  /* A mostly-vertical drag closes it — the other half of the gesture
     anyone expects from a full-screen viewer, and the reason the
     sideways one checks which axis won first. */
  if(Math.abs(dy)>70&&Math.abs(dy)>Math.abs(dx)){ closeLightbox(); return; }
  if(Math.abs(dx)<40||Math.abs(dx)<Math.abs(dy))return;
  if(lbPhotos.length>1) lbStep(dx<0?1:-1);
},{passive:true});

/* ==============================================================
   TOAST
   ============================================================== */
let toastTimer=null;
function showToast(msg,actionLabel,onAction){
  const el=$('toast');
  el.innerHTML=`<span>${esc(msg)}</span>`;
  if(actionLabel){
    const b=document.createElement('button');
    b.className='toast-btn';b.textContent=actionLabel;
    b.onclick=()=>{el.classList.remove('show');if(onAction)onAction();};
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),onAction?15000:2200);
}
