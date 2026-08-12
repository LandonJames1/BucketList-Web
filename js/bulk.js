/* ==============================================================
   BULK ADD — the "add several, with details" sheet.

   Row values live in bulkEntries[] and the DOM is re-rendered from
   it wholesale, so saveBulkFieldValues() must flush the inputs back
   into the array before any redraw. Every mutation helper does this.

   The old 7-column spreadsheet is gone — it was a 1050px horizontal
   scroll on a phone. Rows are cards now, and the composer on the
   detail screen covers the "just add names quickly" case.
   ============================================================== */

let bulkEntries=[];

function openBulkAdd(){
  bulkEntries=[];
  addBulkEntry(true);
  openModal('bulkSheet');
  setTimeout(()=>{
    const first=$('bName_0');
    if(first) first.focus();
  },340);
}

function addBulkEntry(skipScroll){
  bulkEntries.push({links:[]});
  renderBulkEntries();
  if(skipScroll)return;
  setTimeout(()=>{
    const el=$('bEntry_'+(bulkEntries.length-1));
    if(el) el.scrollIntoView({behavior:'smooth',block:'nearest'});
    const input=$('bName_'+(bulkEntries.length-1));
    if(input) input.focus();
  },60);
}

function removeBulkEntry(idx){
  if(bulkEntries.length<=1)return;
  saveBulkFieldValues();
  bulkEntries.splice(idx,1);
  renderBulkEntries();
}

function saveBulkFieldValues(){
  bulkEntries.forEach((entry,i)=>{
    const n=$('bName_'+i);
    if(!n)return;
    entry._name=n.value;
    entry._desc=($('bDesc_'+i)||{}).value||'';
    entry._loc=($('bLoc_'+i)||{}).value||'';
    entry._locLat=($('bLocLat_'+i)||{}).value||'';
    entry._locLng=($('bLocLng_'+i)||{}).value||'';
    entry._date=($('bDate_'+i)||{}).value||'';
    entry._pri=($('bPri_'+i)||{}).value||'medium';
  });
}

/* bulkApplyDown has already written the array itself, so the flush at
   the top of renderBulkEntries would overwrite it with stale DOM. */
let _skipSaveBulk=false;
function bulkApplyDown(field){
  if(!bulkEntries.length)return;
  saveBulkFieldValues();
  const first=bulkEntries[0];
  if(field==='date'){
    const v=first._date||'';
    bulkEntries.forEach(e=>e._date=v);
  } else if(field==='pri'){
    const v=first._pri||'medium';
    bulkEntries.forEach(e=>e._pri=v);
  } else if(field==='loc'){
    const v=first._loc||'',lat=first._locLat||'',lng=first._locLng||'';
    bulkEntries.forEach(e=>{e._loc=v;e._locLat=lat;e._locLng=lng;});
  }
  _skipSaveBulk=true;
  renderBulkEntries();
  _skipSaveBulk=false;
  showToast('Copied to all rows');
}

function renderBulkEntries(){
  if(!_skipSaveBulk) saveBulkFieldValues();

  /* Same reduced set as the activity sheet. Bulk only ever creates new
     rows, so there is no legacy value to preserve here. */
  const dateOpts=['This Month','This Year','Next Year','In 2-3 Years','In 5+ Years'];
  const dateLabels=['This month','This year','Next year','2–3 years','5+ years'];

  $('bulkRows').innerHTML=bulkEntries.map((entry,i)=>{
    const sel=(v,cur,def)=>((cur||def)===v?' selected':'');
    return `<div class="bulk-row" id="bEntry_${i}">
      <div class="bulk-row-head">
        <span class="bulk-row-num">Activity ${i+1}</span>
        ${bulkEntries.length>1
          ? `<button class="bulk-row-remove" onclick="removeBulkEntry(${i})" aria-label="Remove">${icon('x')}</button>`
          : ''}
      </div>
      <div class="bulk-field">
        <input id="bName_${i}" placeholder="Name" maxlength="100" value="${esc(entry._name||'')}"
               autocapitalize="sentences" enterkeyhint="next"/>
      </div>
      <div class="bulk-field">
        <textarea id="bDesc_${i}" placeholder="Notes" rows="1">${esc(entry._desc||'')}</textarea>
      </div>
      <div class="bulk-field">
        <div class="loc-wrap">
          <input id="bLoc_${i}" placeholder="Location" maxlength="200" autocomplete="off"
                 value="${esc(entry._loc||'')}"
                 oninput="locSearch(this,'bLocRes_${i}')" onfocus="locSearch(this,'bLocRes_${i}')"/>
          <input type="hidden" id="bLocLat_${i}" value="${esc(entry._locLat||'')}"/>
          <input type="hidden" id="bLocLng_${i}" value="${esc(entry._locLng||'')}"/>
          <div class="loc-results" id="bLocRes_${i}"></div>
        </div>
      </div>
      <div class="bulk-field">
        <label for="bDate_${i}">Target</label>
        <select id="bDate_${i}">
          ${dateOpts.map((v,k)=>`<option value="${esc(v)}"${sel(v,entry._date,DEFAULT_TARGET_DATE)}>${dateLabels[k]}</option>`).join('')}
        </select>
      </div>
      <div class="bulk-field">
        <label for="bPri_${i}">Priority</label>
        <select id="bPri_${i}">
          <option value="low"${sel('low',entry._pri,'medium')}>Low</option>
          <option value="medium"${sel('medium',entry._pri,'medium')}>Medium</option>
          <option value="high"${sel('high',entry._pri,'medium')}>High</option>
        </select>
      </div>
    </div>`;
  }).join('');

  $('bulkFill').style.display=bulkEntries.length>1?'':'none';
}

async function saveBulkActivities(){
  saveBulkFieldValues();
  const valid=bulkEntries.filter(e=>(e._name||'').trim());
  if(!valid.length){
    const first=$('bName_0');
    if(first){shakeEl(first);first.focus();}
    return;
  }
  const btn=$('bulkSaveBtn');
  btn.disabled=true;btn.textContent='Adding…';
  const rows=valid.map(e=>({
    name:e._name.trim(),
    collection_id:curListId,
    description:(e._desc||'').trim()||null,
    location:(e._loc||'').trim()||null,
    location_lat:parseFloat(e._locLat)||null,
    location_lng:parseFloat(e._locLng)||null,
    target_date:e._date||null,
    priority:e._pri||'medium',
    links:e.links||[],
  }));
  const{error}=await sb.from('Activities').insert(rows);
  btn.disabled=false;btn.textContent='Add All';
  if(error){
    console.error('saveBulkActivities:',error);
    showToast(error.message||'Couldn’t add those.');
    return;
  }
  await updateCollectionStats(curListId);
  closeModal('bulkSheet');
  renderDetail();
  showToast(`Added ${rows.length} activit${rows.length===1?'y':'ies'}`);
}
