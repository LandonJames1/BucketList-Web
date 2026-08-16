/* ==============================================================
   MEDIA — photos and video attached to a completed activity.

   Replaces the old js/photos.js, which could only do photos and only
   as base64.

   ---- Where the bytes live ----

   In Supabase Storage, in a bucket called `media`, one folder per user:

     media/<user id>/<random>.jpg
     media/<user id>/<random>.mp4

   The `Activities.photos` column keeps only URLs. That is the change
   video forced and the app badly needed anyway: photos used to be
   base64 data URLs *inside the row*, so every list render pulled every
   photo down again as part of the JSON, and a handful of them made the
   whole table slow. A phone video is 5–20MB before base64 inflates it
   by another third — there was never a version of that which worked.

   ---- Degrading when the bucket is missing ----

   The schema lives in someone else's Supabase project and there is no
   migration step here that can guarantee the bucket exists, so this
   probes for it once, exactly like api.js probes for `remind_at`:

     - bucket present  → photos and video both upload as files
     - bucket missing  → photos fall back to base64 (what the app did
                         before, so nothing regresses) and video is
                         refused with an explanation rather than
                         failing silently at save time

   To create it, run supabase/storage.sql once. supabase/README.md has
   the steps.

   ---- Shapes ----

   Everything here works on the normalised media entries api.js hands
   out: {type:'photo'|'video', url, poster}. denormMedia() puts them
   back in the column's shape on save.
   ============================================================== */

const MEDIA_BUCKET='media';

/* Video is capped because a phone shoots at a bitrate no one wants to
   wait on over cellular, and there is no transcoding step here. The cap
   is on the file as picked; nothing is re-encoded. */
const MAX_VIDEO_BYTES=100*1024*1024;   /* 100MB — Supabase's default limit */
const MAX_PHOTO_DIM=1600;              /* uploads are files now, so this can
                                          be generous where base64 could not */
const PHOTO_QUALITY=.82;

/* ==============================================================
   CAPABILITY PROBE
   ============================================================== */
let _storageReady=null;

async function probeStorage(){
  try{
    /* list() on a bucket the caller can read succeeds even when empty,
       and 404s when the bucket does not exist. */
    const{error}=await sb.storage.from(MEDIA_BUCKET).list('',{limit:1});
    _storageReady=!error;
    if(error) console.info('[media] no "'+MEDIA_BUCKET+'" storage bucket — '+
      'photos will be stored inline and video is unavailable. '+
      'Run supabase/storage.sql to enable it.');
  }catch(e){ _storageReady=false; }
  return _storageReady;
}
function storageReady(){ return _storageReady===true; }

/* ==============================================================
   UPLOAD
   ============================================================== */

/* Storage keys are random rather than derived from the filename: two
   photos called IMG_0001.jpg from the same camera roll would otherwise
   collide, and the second would silently overwrite the first. */
function mediaKey(ext){
  /* Shares uuidv4() with the row ids — a storage key would tolerate any
     random string, but crypto.randomUUID() is undefined outside a
     secure context and there is no reason to keep a second, weaker
     fallback around for it. See js/utils.js. */
  return `${currentUser.id}/${uuidv4()}.${ext}`;
}

async function uploadBlob(blob,ext,contentType){
  const key=mediaKey(ext);
  const{error}=await sb.storage.from(MEDIA_BUCKET)
    .upload(key,blob,{contentType,cacheControl:'31536000',upsert:false});
  if(error)throw error;
  const{data}=sb.storage.from(MEDIA_BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

/* A data URL back to a Blob, so the same compressed bytes can be either
   uploaded or kept inline depending on what is available. */
function dataURLToBlob(url){
  const [head,b64]=url.split(',');
  const mime=(head.match(/:(.*?);/)||[])[1]||'image/jpeg';
  const bin=atob(b64);
  const buf=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) buf[i]=bin.charCodeAt(i);
  return new Blob([buf],{type:mime});
}

/* ---- Photos ---- */
function compressFile(file,maxD,q){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onerror=()=>reject(new Error('Could not read that image.'));
    r.onload=ev=>compress(ev.target.result,maxD,q,resolve);
    r.readAsDataURL(file);
  });
}

async function uploadPhoto(file){
  const dataUrl=await compressFile(file,MAX_PHOTO_DIM,PHOTO_QUALITY);
  /* Offline is the same answer as a missing bucket: keep the bytes
     inline. The activity row itself is queued by js/offline.js and
     syncs with the photo already embedded in it, so a completion
     written on a plane arrives whole rather than arriving with its
     photos missing. It costs table size, which is the trade the app
     made for years before the bucket existed. */
  if(!storageReady()||!navigator.onLine) return{type:'photo',url:dataUrl,poster:''};
  try{
    const url=await uploadBlob(dataURLToBlob(dataUrl),'jpg','image/jpeg');
    return{type:'photo',url,poster:''};
  }catch(e){
    /* The connection dropped mid-upload. Falling back beats losing the
       photo the user just picked. */
    console.warn('[media] upload failed, keeping photo inline:',e);
    return{type:'photo',url:dataUrl,poster:''};
  }
}

/* ---- Video ----
   A poster frame is grabbed before upload so thumbnails, grid cards and
   map pins have an image to show. Without one a video contributes
   nothing to `a.photos` and the activity looks like it has no media at
   all everywhere except the sheet that plays it. */
function videoPoster(file){
  return new Promise(resolve=>{
    const v=document.createElement('video');
    v.preload='metadata';v.muted=true;v.playsInline=true;
    const url=URL.createObjectURL(file);
    let settled=false;
    const done=result=>{
      if(settled)return;
      settled=true;
      URL.revokeObjectURL(url);
      resolve(result);
    };
    /* A frame that is not the very first one: video often opens on black. */
    v.onloadeddata=()=>{ try{ v.currentTime=Math.min(.6,(v.duration||1)/3); }catch(e){ done(''); } };
    v.onseeked=()=>{
      try{
        const scale=Math.min(1,MAX_PHOTO_DIM/Math.max(v.videoWidth,v.videoHeight));
        const c=document.createElement('canvas');
        c.width=Math.round(v.videoWidth*scale);
        c.height=Math.round(v.videoHeight*scale);
        c.getContext('2d').drawImage(v,0,0,c.width,c.height);
        done(c.toDataURL('image/jpeg',.75));
      }catch(e){ done(''); }
    };
    v.onerror=()=>done('');
    /* Some codecs never fire either event; do not hang the upload on it. */
    setTimeout(()=>done(''),4000);
    v.src=url;
  });
}

async function uploadVideo(file){
  if(!storageReady())
    throw new Error('Video needs the media storage bucket — see supabase/README.md.');
  /* Video has no inline fallback: a phone clip is 5–20MB, and holding
     one in the write queue waiting for a connection is a different
     feature with its own storage budget. Refuse it clearly rather than
     failing at save time. */
  if(!navigator.onLine)
    throw new Error('Video needs a connection. Add it once you’re back online — photos work offline.');
  if(file.size>MAX_VIDEO_BYTES)
    throw new Error('That video is too large. Trim it to under 100MB.');

  const ext=(file.name.split('.').pop()||'mp4').toLowerCase().replace(/[^a-z0-9]/g,'')||'mp4';
  const url=await uploadBlob(file,ext,file.type||'video/mp4');

  let poster='';
  const posterData=await videoPoster(file);
  if(posterData){
    try{ poster=await uploadBlob(dataURLToBlob(posterData),'jpg','image/jpeg'); }
    catch(e){ console.warn('[media] poster upload failed:',e.message); }
  }
  return{type:'video',url,poster};
}

/* ==============================================================
   THE PICKER

   upMedia is the working list for whichever sheet is open. Entries are
   appended as each file finishes, so a slow upload never blocks the
   ones behind it, and each shows a placeholder tile while it runs.
   ============================================================== */
let _mediaPending=0;

async function handleMedia(e){
  const files=Array.from(e.target.files||[]);
  e.target.value='';
  if(!files.length)return;

  /* The first fix found across this batch, if the activity does not
     already have a location. Read here rather than inside uploadPhoto
     because it has to happen against the file *as picked* — that
     function's first act is to run it through a canvas, which strips
     every EXIF tag from the result. See js/exif.js. */
  let geo=null;

  for(const f of files){
    const isVideo=f.type.startsWith('video/');
    if(!isVideo&&!f.type.startsWith('image/'))continue;
    if(!isVideo&&!geo&&needsLocationSuggestion()){
      geo=await exifReadLocation(f);
      /* Silent for the user — a photo with no fix is the normal case,
         not an error — but this feature has too many ways to quietly do
         nothing (wrong format, stripped metadata, no fix, geocoder
         down) to be undebuggable. One line naming which one it was. */
      console.info('[media] photo location:',geo
        ? `${geo.lat.toFixed(4)},${geo.lng.toFixed(4)} from ${f.name}`
        : `none in ${f.name} (${f.type||'unknown type'})`+
          (/^image\/jpe?g$/i.test(f.type||'')?' — no GPS tags in the file'
                                             :' — only JPEG carries readable EXIF here'));
      /* Started the moment the fix is read, NOT after the uploads — the
         reverse lookup is a ~1KB GET and the uploads are megabytes, so
         serialising them behind a video meant the chip appeared seconds
         after the photo it came from. It runs alongside them instead and
         renders whenever it resolves; suggestLocationFromPhoto() re-checks
         needsLocationSuggestion() on the far side of the round trip, so a
         user who typed a place in the meantime still wins. */
      if(geo) suggestLocationFromPhoto(geo);
    }
    _mediaPending++;
    renderThumbs();
    try{
      const entry=isVideo?await uploadVideo(f):await uploadPhoto(f);
      upMedia.push(entry);
    }catch(err){
      console.error('handleMedia:',err);
      showToast(err.message||'Couldn’t add that file.');
    }finally{
      _mediaPending--;
      renderThumbs();
    }
  }

}

function rmMedia(i){ upMedia.splice(i,1); renderThumbs(); }

/* ==============================================================
   WHERE THE PHOTO WAS TAKEN

   An activity with no location never appears on the map, and the
   completion sheet is exactly where that gets missed — you have just
   done the thing, you are attaching the photos of it, and the one
   field that would put it on the map is the one you skip. The photos
   already carry the answer.

   Two rules:

   1. **Only when the field is empty.** A location the user typed, or
      one that came in with an imported link, is never second-guessed
      by a photo's metadata.
   2. **It suggests, it does not fill.** EXIF can be wrong — a photo of
      the poster advertising the thing, a screenshot someone sent you,
      a camera whose clock and fix were both stale. Writing a place
      into the record of something you did, silently, on that evidence
      is worse than not offering it. So it is a chip you tap, which is
      the same rule the import sheet follows for the same reason.

   The dismissal is deliberately sticky for the life of the sheet: an
   offer that has been declined must not come back when the next photo
   is added.
   ============================================================== */
let _photoLocDismissed=false;

/* Called before reading a file, so a photo is not parsed at all when
   its answer could not be used. */
function needsLocationSuggestion(){
  if(_photoLocDismissed) return false;
  const el=$('compLoc');
  /* Not the sheet this runs on — nothing to suggest into. */
  if(!el||!$('compSheet').classList.contains('open')) return false;
  return !el.value.trim();
}

/* Reset by openComp() so a dismissal does not leak into the next
   activity completed in the same session. */
function resetLocationSuggestion(){
  _photoLocDismissed=false;
  _photoLoc=null;
  const box=$('compLocSuggest');
  if(box){ box.hidden=true; box.innerHTML=''; }
}

let _photoLoc=null;

async function suggestLocationFromPhoto(geo){
  /* Re-checked rather than trusted from before the upload: the user
     may have typed a place, or closed the sheet entirely, in the time
     the photos took to go up. */
  if(!needsLocationSuggestion()) return;

  const place=await reverseGeocode(geo.lat,geo.lng);
  if(!place){
    console.info('[media] the photo had a location but the geocoder could not name it');
    return;
  }
  if(!needsLocationSuggestion()) return;

  _photoLoc=place;
  const box=$('compLocSuggest');
  if(!box) return;
  box.innerHTML=`
    <button class="loc-suggest-main" onclick="acceptPhotoLocation()">
      ${icon('pin')}
      <span class="loc-suggest-body">
        <span class="loc-suggest-cap">From your photo</span>
        <span class="loc-suggest-name">${esc(place.display)}</span>
      </span>
    </button>
    <button class="loc-suggest-x" onclick="dismissPhotoLocation()"
            aria-label="Dismiss">${icon('x','ic-xs')}</button>`;
  box.hidden=false;
}

function acceptPhotoLocation(){
  if(!_photoLoc) return;
  $('compLoc').value=_photoLoc.display;
  $('compLocLat').value=_photoLoc.lat;
  $('compLocLng').value=_photoLoc.lng;
  /* Accepted counts as settled: the field is no longer empty, so
     nothing would offer again anyway, but this keeps the chip from
     lingering next to a field it has already filled. */
  dismissPhotoLocation();
}

function dismissPhotoLocation(){
  _photoLocDismissed=true;
  _photoLoc=null;
  const box=$('compLocSuggest');
  if(box){ box.hidden=true; box.innerHTML=''; }
}

/* ==============================================================
   ORDER, AND THEREFORE THE COVER — BY DRAGGING

   The first piece of media is the cover: it is what the activity's row
   thumbnail, its grid card and its map pin all show. So "choose the
   cover" and "reorder" are the same operation — drag a photo to the
   front and it becomes the cover.

   ---- How the drag works ----

   Pointer events, so a mouse and a finger take the same path.

   The tiles wrap onto several rows, which rules out translating things
   by a fixed x offset. Instead the *slots* — the tiles' original
   rectangles, in order — are measured once when the drag starts, and
   every tile is then translated to whichever slot its index currently
   occupies. Wrapping falls out for free: a tile moving from the end of
   one row to the start of the next just gets a different slot rect.

   ---- Not stealing the scroll ----

   These tiles sit in a scrolling sheet that also has swipe-to-dismiss
   on it, so three gestures want the same finger. The drag engages only
   when the intent is unambiguous:

     - moved sideways first  → a reorder, engage immediately
     - moved downward first  → a scroll, let it go
     - held still for 240ms  → a reorder (this is the one that makes
                               multi-row dragging possible, since that
                               needs vertical movement)

   Until it engages, nothing is prevented and the sheet behaves
   normally. `.photo-previews` is listed in ownsVertical() in
   gestures.js so a downward drag on a tile can never dismiss the sheet.
   ============================================================== */

/* Which entry is actually the cover: the first one with an image to
   show. mapActivity() builds a.photos the same way, so the badge here
   cannot disagree with what the rest of the app displays — a video
   whose poster frame failed to capture is skipped by both. */
function coverIndex(){
  return upMedia.findIndex(m=>m.type==='video'?m.poster:m.url);
}

function moveMedia(from,to){
  if(to<0||to>=upMedia.length||from===to)return;
  const [m]=upMedia.splice(from,1);
  upMedia.splice(to,0,m);
  renderThumbs();
}

const DRAG_HOLD_MS=240;      /* a still press is a reorder */
const DRAG_SLOP=7;           /* movement before intent is readable */
let mDrag=null;

function mediaDragStart(e,i){
  /* Left button or touch only, and never from the remove button. */
  if(e.button>0||e.target.closest('.rm-photo'))return;
  const box=$('photoPrev');
  const tiles=[...box.querySelectorAll('.photo-th')];
  if(tiles.length<2)return;

  mDrag={
    i, from:i, box, tiles,
    el:tiles[i],
    slots:tiles.map(t=>t.getBoundingClientRect()),
    order:tiles.map((_,n)=>n),
    x0:e.clientX, y0:e.clientY, live:false,
    hold:setTimeout(()=>{ if(mDrag&&!mDrag.live) mediaDragEngage(); },DRAG_HOLD_MS),
    pid:e.pointerId,
  };
}

function mediaDragEngage(){
  const d=mDrag;
  if(!d||d.live)return;
  d.live=true;
  clearTimeout(d.hold);
  /* Now that it is ours, stop the browser panning underneath it. */
  d.box.classList.add('reordering');
  d.el.classList.add('dragging');
  try{ d.el.setPointerCapture(d.pid); }catch(err){}
  if(navigator.vibrate) navigator.vibrate(8);
}

function mediaDragMove(e){
  const d=mDrag;
  if(!d)return;
  const dx=e.clientX-d.x0, dy=e.clientY-d.y0;

  if(!d.live){
    if(Math.abs(dx)<DRAG_SLOP&&Math.abs(dy)<DRAG_SLOP)return;
    /* Downward first means they are scrolling the sheet, not reordering. */
    if(Math.abs(dy)>Math.abs(dx)){ mediaDragCancel(); return; }
    mediaDragEngage();
  }
  e.preventDefault();

  /* The dragged tile follows the pointer. */
  d.el.style.transform=`translate(${dx}px, ${dy}px) scale(1.08)`;

  /* Which slot is the pointer over? Nearest centre wins. */
  const px=e.clientX, py=e.clientY;
  let best=0,bestD=Infinity;
  d.slots.forEach((r,n)=>{
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const dist=(px-cx)**2+(py-cy)**2;
    if(dist<bestD){bestD=dist;best=n;}
  });

  const cur=d.order.indexOf(d.from);
  if(best!==cur){
    d.order.splice(cur,1);
    d.order.splice(best,0,d.from);
    mediaDragLayout();
  }
}

/* Put every tile except the dragged one in the slot its index now
   occupies. */
function mediaDragLayout(){
  const d=mDrag;
  d.order.forEach((tileIdx,slot)=>{
    if(tileIdx===d.from)return;
    const el=d.tiles[tileIdx];
    const from=d.slots[tileIdx], to=d.slots[slot];
    el.style.transform=`translate(${to.left-from.left}px, ${to.top-from.top}px)`;
  });
}

function mediaDragEnd(){
  const d=mDrag;
  if(!d)return;
  mDrag=null;
  clearTimeout(d.hold);
  if(!d.live){ return; }

  d.box.classList.remove('reordering');
  d.el.classList.remove('dragging');
  d.tiles.forEach(t=>{t.style.transform='';});

  const to=d.order.indexOf(d.from);
  if(to!==d.from){
    const wasCover=coverIndex();
    moveMedia(d.from,to);
    if(coverIndex()!==wasCover||to===0) showToast('Cover updated');
  } else {
    renderThumbs();
  }
}

function mediaDragCancel(){
  const d=mDrag;
  if(!d)return;
  mDrag=null;
  clearTimeout(d.hold);
  if(!d.live)return;
  d.box.classList.remove('reordering');
  d.el.classList.remove('dragging');
  d.tiles.forEach(t=>{t.style.transform='';});
}

document.addEventListener('pointermove',mediaDragMove,{passive:false});
document.addEventListener('pointerup',mediaDragEnd);
document.addEventListener('pointercancel',mediaDragCancel);

/* One tile, used by the picker, the activity sheet and anywhere else
   that shows a piece of media. A video shows its poster with a play
   badge over it; with no poster it falls back to the video element's
   own first frame. */
function mediaTileHTML(m,cls){
  const c=cls?` class="${cls}"`:'';
  if(m.type==='video'){
    const inner=m.poster
      ? `<img src="${esc(m.poster)}" alt="" loading="lazy"/>`
      : `<video src="${esc(m.url)}" muted playsinline preload="metadata"></video>`;
    return `<span class="media-tile is-video"${c}>${inner}
      <span class="media-play">${icon('play','ic-sm')}</span></span>`;
  }
  return `<span class="media-tile"${c}><img src="${esc(m.url)}" alt="" loading="lazy"/></span>`;
}

function renderThumbs(){
  const box=$('photoPrev');
  if(!box)return;
  const cover=coverIndex();
  const tiles=upMedia.map((m,i)=>
    `<div class="photo-th${i===cover?' is-cover':''}" onpointerdown="mediaDragStart(event,${i})"
          aria-label="${i===cover?'Cover. ':''}Drag to reorder">
       ${mediaTileHTML(m)}
       ${i===cover?'<span class="photo-cover-tag">Cover</span>':''}
       <button class="rm-photo" onclick="event.stopPropagation();rmMedia(${i})" aria-label="Remove">${icon('x')}</button>
     </div>`).join('');
  /* An in-flight upload gets a tile of its own. A video can take a
     while, and with no placeholder the sheet looks like it ignored the
     file that was just picked. */
  const pending=Array.from({length:_mediaPending},()=>
    `<div class="photo-th pending"><span class="spinner"></span></div>`).join('');
  box.innerHTML=tiles+pending;
  /* The completion sheet will not save without at least one of these.
     The rule belongs to that sheet, not to the picker, so it lives in
     activities.js — this is only the one place every change to upMedia
     passes through. */
  updateMediaRequirement();
}
