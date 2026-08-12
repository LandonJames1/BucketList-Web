/* ==============================================================
   MODALS — open/close plumbing, delete confirmation, lightbox
   Also wires the global Escape / overlay-click / arrow-key handlers.
   ============================================================== */

/* setBodyScrollLock lives in nav.js; it also accounts for the mobile menu
   and the lightbox, so a dialog closing never unfreezes the page early. */
function openModal(id){$(id).classList.add('open');setBodyScrollLock(true);}
function closeModal(id){$(id).classList.remove('open');setBodyScrollLock(false);}
document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o){o.classList.remove('open');setBodyScrollLock(false);}}));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open'));closeLightbox();setBodyScrollLock(false);}if(e.key==='ArrowLeft'&&$('lightbox').classList.contains('open'))lbStep(-1);if(e.key==='ArrowRight'&&$('lightbox').classList.contains('open'))lbStep(1);});

/* ==============================================================
   DELETE CONFIRMATION (event delegation)
   ============================================================== */
let pendingDelete=null;
function showDeleteConfirm(type,id){
  pendingDelete={type,id};
  if(type==='collection'){
    $('delConfirmTitle').textContent='Delete Collection';
    $('delConfirmMsg').textContent='This will permanently delete this collection and all its activities. Are you sure?';
  } else {
    $('delConfirmTitle').textContent='Delete Activity';
    $('delConfirmMsg').textContent='This will permanently delete this activity. Are you sure?';
  }
  openModal('deleteConfirmModal');
}
$('delConfirmYes').addEventListener('click',async()=>{
  if(!pendingDelete)return;
  const{type,id}=pendingDelete;
  closeModal('deleteConfirmModal');
  $('delConfirmYes').textContent='Delete';
  if(type==='collection'){
    await delList(id);
  } else if(type==='undo'){
    await sb.from('Activities').update({
      date_completed:null,experience_notes:null,photos:null
    }).eq('id',id);
    if(curListId) await updateCollectionStats(curListId);
    closeModal('detModal');renderDetail();
  } else {
    closeModal('detModal');
    await delActivity(id);
  }
  pendingDelete=null;
});
$('delConfirmNo').addEventListener('click',()=>{closeModal('deleteConfirmModal');pendingDelete=null;});
$('delConfirmClose').addEventListener('click',()=>{closeModal('deleteConfirmModal');pendingDelete=null;});

/* Catch all delete button clicks via event delegation */
document.addEventListener('click',e=>{
  const btn=e.target.closest('[data-delete]');
  if(!btn)return;
  e.stopPropagation();
  const type=btn.dataset.delete;
  const id=btn.dataset.deleteId||curListId;
  showDeleteConfirm(type,id);
});

/* ==============================================================
   LIGHTBOX / GALLERY
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

/* Swipe the gallery on touch — the arrow buttons are the desktop path,
   but a horizontal drag is what a phone user will reach for first. */
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
  /* Ignore mostly-vertical drags so a swipe-down to dismiss still reads
     as vertical rather than flipping the photo. */
  if(Math.abs(dx)<40||Math.abs(dx)<Math.abs(dy))return;
  if(lbPhotos.length>1) lbStep(dx<0?1:-1);
},{passive:true});
