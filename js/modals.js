/* ==============================================================
   MODALS — sheet open/close, the action sheet used for overflow
   menus and destructive confirms, the photo lightbox, and the
   toast.

   iOS confirms destructive actions with an action sheet rather
   than a dialog, so showConfirm() below builds one instead of
   the old fixed confirmation modal.
   ============================================================== */

function openModal(id){$(id).classList.add('open');setBodyScrollLock(true);}
function closeModal(id){$(id).classList.remove('open');setBodyScrollLock(false);}

/* Tapping the dimmed area behind a sheet dismisses it. */
document.querySelectorAll('.modal-overlay').forEach(o=>{
  o.addEventListener('click',e=>{
    if(e.target===o){o.classList.remove('open');setBodyScrollLock(false);}
  });
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if($('lightbox').classList.contains('open')){closeLightbox();return;}
    if($('actionSheet').classList.contains('open')){closeActionSheet();return;}
    document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open'));
    setBodyScrollLock(false);
  }
  if($('lightbox').classList.contains('open')){
    if(e.key==='ArrowLeft') lbStep(-1);
    if(e.key==='ArrowRight') lbStep(1);
  }
});

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
function confirmDeleteActivity(id,name){
  showConfirm({
    title:'Delete Activity',
    message:name?`"${name}" will be permanently deleted.`:'This cannot be undone.',
    confirmLabel:'Delete',
    onConfirm:async()=>{closeModal('actDetailSheet');await delActivity(id);},
  });
}

/* ==============================================================
   LIGHTBOX
   ============================================================== */
let lbPhotos=[],lbIdx=0;
function openLB(photos,startIdx){
  if(typeof photos==='string') photos=[photos];
  lbPhotos=photos;lbIdx=startIdx||0;
  lbShow();
  $('lightbox').classList.add('open');
  setBodyScrollLock(true);
}
function lbShow(){
  $('lbImg').src=lbPhotos[lbIdx];
  $('lbCounter').textContent=lbPhotos.length>1?`${lbIdx+1} of ${lbPhotos.length}`:'';
  $('lbPrev').style.display=lbPhotos.length>1?'flex':'none';
  $('lbNext').style.display=lbPhotos.length>1?'flex':'none';
}
function lbStep(dir){
  lbIdx=(lbIdx+dir+lbPhotos.length)%lbPhotos.length;
  lbShow();
}
function closeLightbox(){
  $('lightbox').classList.remove('open');lbPhotos=[];lbIdx=0;
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
  /* A mostly-vertical drag is a dismiss gesture, not a page flip. */
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
