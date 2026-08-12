/* ==============================================================
   PHOTOS — completion photo upload, compression, and previews.

   Photos are stored as base64 data URLs inside Activities.photos.
   compress() caps them at 800px/q0.8 to keep the rows sane; moving
   them into Supabase Storage is the real fix (see CLAUDE.md).
   ============================================================== */

function handlePhotos(e){
  Array.from(e.target.files).forEach(f=>{
    if(!f.type.startsWith('image/'))return;
    const r=new FileReader();
    r.onload=ev=>compress(ev.target.result,800,.8,c=>{upPhotos.push(c);renderThumbs();});
    r.readAsDataURL(f);
  });
  e.target.value='';
}

function rmPhoto(i){upPhotos.splice(i,1);renderThumbs();}

function renderThumbs(){
  $('photoPrev').innerHTML=upPhotos.map((p,i)=>
    `<div class="photo-th">
       <img src="${p}" alt=""/>
       <button class="rm-photo" onclick="rmPhoto(${i})" aria-label="Remove photo">${icon('x')}</button>
     </div>`).join('');
}
