/* ==============================================================
   LOCATION AUTOCOMPLETE — place search via OpenStreetMap Nominatim.
   Debounced so typing does not hammer the public API.
   ============================================================== */

let locTimer=null;

function locSearch(input,resultsId){
  const q=input.value.trim();
  const box=$(resultsId);
  if(!box)return;
  if(q.length<2){box.classList.remove('open');box.innerHTML='';return;}
  clearTimeout(locTimer);
  locTimer=setTimeout(async()=>{
    try{
      const res=await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6`,
        {headers:{'Accept-Language':'en'}});
      const data=await res.json();
      if(!data.length){
        box.innerHTML='<div class="loc-empty">No places found</div>';
        box.classList.add('open');positionLocBox(box,input);return;
      }
      box.innerHTML=data.map(r=>{
        const main=r.display_name.split(',')[0];
        const sub=r.display_name.split(',').slice(1,3).join(',').trim();
        const safe=r.display_name.replace(/'/g,"\\'");
        return `<button class="loc-item" onmousedown="locPick(this,'${resultsId}','${esc(safe)}',${r.lat},${r.lon})">
          ${icon('pin')}
          <span class="loc-item-body">
            <span class="loc-item-main">${esc(main)}</span>
            ${sub?`<span class="loc-item-sub">${esc(sub)}</span>`:''}
          </span>
        </button>`;
      }).join('');
      box.classList.add('open');
      positionLocBox(box,input);
    }catch(e){console.error('locSearch:',e);}
  },350);
}

/* One-shot lookup for a place name we already have — an imported link's
   location, say. Unlike locSearch this is not debounced and does not
   touch the DOM: it just resolves a string to coordinates, or null.
   The unfurl function geocodes server-side too; this is the fallback
   for when it could not, and for a place the user edits by hand. */
async function geocodeOnce(q){
  const query=(q||'').trim();
  if(query.length<2) return null;
  try{
    const res=await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      {headers:{'Accept-Language':'en'}});
    if(!res.ok) return null;
    const data=await res.json();
    if(!data.length) return null;
    return {display:data[0].display_name,lat:parseFloat(data[0].lat),lng:parseFloat(data[0].lon)};
  }catch(e){ console.warn('geocodeOnce:',e); return null; }
}

/* Inside the bulk sheet the dropdown is position:fixed so it can escape
   the sheet's scroll container; it therefore has to be placed by hand. */
function positionLocBox(box,input){
  if(getComputedStyle(box).position!=='fixed')return;
  const r=input.getBoundingClientRect();
  box.style.top=(r.bottom+4)+'px';
  box.style.left=r.left+'px';
  box.style.width=r.width+'px';
}

function locPick(el,resultsId,display,lat,lng){
  const box=$(resultsId);
  const wrap=box.parentElement;
  const input=wrap.querySelector('input:not([type="hidden"])');
  const latInput=wrap.querySelector('input[id*="Lat"]');
  const lngInput=wrap.querySelector('input[id*="Lng"]');
  if(input) input.value=display;
  if(latInput) latInput.value=lat;
  if(lngInput) lngInput.value=lng;
  box.classList.remove('open');box.innerHTML='';
}

/* Dismiss any open dropdown on an outside tap. */
document.addEventListener('click',e=>{
  document.querySelectorAll('.loc-results.open').forEach(b=>{
    if(!b.parentElement.contains(e.target)) b.classList.remove('open');
  });
});
