/* ==============================================================
   LOCATION AUTOCOMPLETE — place search via OpenStreetMap Nominatim
   Debounced so typing does not hammer the public API.
   ============================================================== */

let locTimer=null;
function locSearch(input,resultsId){
  const q=input.value.trim();
  const box=$(resultsId);
  if(q.length<2){box.classList.remove('open');box.innerHTML='';return;}
  clearTimeout(locTimer);
  locTimer=setTimeout(async()=>{
    try{
      const res=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6`,{headers:{'Accept-Language':'en'}});
      const data=await res.json();
      if(!data.length){box.innerHTML='<div class="loc-item"><div class="loc-item-main" style="color:var(--text3)">No results found</div></div>';box.classList.add('open');return;}
      box.innerHTML=data.map((r,i)=>{
        const main=r.display_name.split(',')[0];
        const sub=r.display_name.split(',').slice(1,3).join(',').trim();
        return `<div class="loc-item" data-idx="${i}" onmousedown="locPick(this,'${resultsId}','${esc(r.display_name.replace(/'/g,"\\'"))}',${r.lat},${r.lon})">
          <div class="loc-item-main">${esc(main)}</div>
          ${sub?`<div class="loc-item-sub">${esc(sub)}</div>`:''}
        </div>`;
      }).join('');
      box.classList.add('open');
      /* Position fixed dropdowns in bulk table */
      if(box.style.position==='fixed'||getComputedStyle(box).position==='fixed'){
        const rect=input.getBoundingClientRect();
        box.style.top=rect.bottom+'px';
        box.style.left=rect.left+'px';
        box.style.width=rect.width+'px';
      }
    }catch(e){console.error('locSearch error:',e);}
  },350);
}
function locPick(el,resultsId,display,lat,lng){
  const box=$(resultsId);
  const input=box.parentElement.querySelector('input[type="text"],input:not([type="hidden"])');
  const latInput=box.parentElement.querySelector('input[id*="Lat"]');
  const lngInput=box.parentElement.querySelector('input[id*="Lng"]');
  input.value=display;
  if(latInput)latInput.value=lat;
  if(lngInput)lngInput.value=lng;
  box.classList.remove('open');box.innerHTML='';
}
/* Close loc dropdowns on outside click */
document.addEventListener('click',e=>{
  document.querySelectorAll('.loc-results.open').forEach(b=>{
    if(!b.parentElement.contains(e.target))b.classList.remove('open');
  });
});
