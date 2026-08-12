/* ==============================================================
   PHOTOS — upload, compress, and preview completion photos
   
   ============================================================== */

function handlePhotos(e){
  Array.from(e.target.files).forEach(f=>{
    if(!f.type.startsWith('image/'))return;
    const r=new FileReader();
    r.onload=ev=>{compress(ev.target.result,800,.8,c=>{upPhotos.push(c);renderThumbs();});};
    r.readAsDataURL(f);
  });e.target.value='';
}

function rmPhoto(i){upPhotos.splice(i,1);renderThumbs();}
function renderThumbs(){
  $('photoPrev').innerHTML=upPhotos.map((p,i)=>`<div class="photo-th"><img src="${p}"/><button class="rm-photo" onclick="rmPhoto(${i})">&#x2715;</button></div>`).join('');
}
