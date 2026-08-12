/* ==============================================================
   BULK ADD — spreadsheet-style modal for adding many activities
   Row values live in bulkEntries[]; the DOM is re-rendered from it,
   so field values are flushed back into the array before each redraw.
   ============================================================== */

let bulkEntries=[];
function openBulkAdd(){
  bulkEntries=[];
  addBulkEntry();
  openModal('bulkAddModal');
  setTimeout(()=>{
    const first=document.querySelector('#bulkEntries input[id^="bName_"]');
    if(first)first.focus();
  },300);
}
function addBulkEntry(){
  bulkEntries.push({links:[]});
  renderBulkEntries();
  setTimeout(()=>{
    const el=document.getElementById('bEntry_'+(bulkEntries.length-1));
    if(el)el.scrollIntoView({behavior:'smooth',block:'nearest'});
    const nameInput=document.getElementById('bName_'+(bulkEntries.length-1));
    if(nameInput)nameInput.focus();
  },50);
}
function addBulkMultiple(){
  const count=Math.min(Math.max(parseInt($('bulkAddCount').value)||1,1),50);
  for(let i=0;i<count;i++) bulkEntries.push({links:[]});
  renderBulkEntries();
  setTimeout(()=>{
    const el=document.getElementById('bEntry_'+(bulkEntries.length-1));
    if(el)el.scrollIntoView({behavior:'smooth',block:'nearest'});
  },50);
}
function removeBulkEntry(idx){
  if(bulkEntries.length<=1)return;
  saveBulkFieldValues();
  bulkEntries.splice(idx,1);
  renderBulkEntries();
}
function updateBulkCount(){
  $('bulkCount').textContent=bulkEntries.length+' activit'+(bulkEntries.length===1?'y':'ies');
}
function saveBulkFieldValues(){
  bulkEntries.forEach((entry,i)=>{
    const n=document.getElementById('bName_'+i);
    if(n){
      entry._name=n.value;
      entry._desc=(document.getElementById('bDesc_'+i)||{}).value||'';
      entry._loc=(document.getElementById('bLoc_'+i)||{}).value||'';
      entry._locLat=(document.getElementById('bLocLat_'+i)||{}).value||'';
      entry._locLng=(document.getElementById('bLocLng_'+i)||{}).value||'';
      entry._date=(document.getElementById('bDate_'+i)||{}).value||'';
      entry._pri=(document.getElementById('bPri_'+i)||{}).value||'medium';
    }
  });
}
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
    const v=first._loc||'';
    const lat=first._locLat||'';
    const lng=first._locLng||'';
    bulkEntries.forEach(e=>{e._loc=v;e._locLat=lat;e._locLng=lng;});
  }
  _skipSaveBulk=true;
  renderBulkEntries();
  _skipSaveBulk=false;
}
function renderBulkEntries(){
  if(!_skipSaveBulk) saveBulkFieldValues();
  const wrap=$('bulkEntries');
  wrap.innerHTML=bulkEntries.map((entry,i)=>{
    return `<tr id="bEntry_${i}">
      <td>
        <div class="bulk-row-num">
          <span>${i+1}</span>
          ${bulkEntries.length>1?`<button class="bulk-row-remove" onclick="removeBulkEntry(${i})" title="Remove">&#x2715;</button>`:''}
        </div>
      </td>
      <td data-label="Name *"><input id="bName_${i}" placeholder="Activity name" maxlength="100" value="${esc(entry._name||'')}" /></td>
      <td data-label="Description"><textarea id="bDesc_${i}" placeholder="Description">${esc(entry._desc||'')}</textarea></td>
      <td data-label="Location">
        <div class="loc-wrap">
          <input id="bLoc_${i}" placeholder="Search location" maxlength="200" autocomplete="off" value="${esc(entry._loc||'')}" oninput="locSearch(this,'bLocRes_${i}')" onfocus="locSearch(this,'bLocRes_${i}')" />
          <input type="hidden" id="bLocLat_${i}" value="${esc(entry._locLat||'')}" />
          <input type="hidden" id="bLocLng_${i}" value="${esc(entry._locLng||'')}" />
          <div class="loc-results" id="bLocRes_${i}"></div>
        </div>
      </td>
      <td data-label="Target Date"><select id="bDate_${i}"><option value="Before I Die"${(entry._date||'Before I Die')==='Before I Die'?' selected':''}>Before I Die</option><option value="This Month"${(entry._date)==='This Month'?' selected':''}>This Mo</option><option value="This Year"${(entry._date)==='This Year'?' selected':''}>This Year</option><option value="Next Year"${(entry._date)==='Next Year'?' selected':''}>Next Year</option><option value="In 2-3 Years"${(entry._date)==='In 2-3 Years'?' selected':''}>2-3 Yrs</option><option value="In 5+ Years"${(entry._date)==='In 5+ Years'?' selected':''}>5+ Yrs</option><option value=""${(entry._date)===''?' selected':''}>—</option></select></td>
      <td data-label="Priority"><select id="bPri_${i}"><option value="low"${(entry._pri||'medium')==='low'?' selected':''}>Low</option><option value="medium"${(entry._pri||'medium')==='medium'?' selected':''}>Med</option><option value="high"${(entry._pri||'medium')==='high'?' selected':''}>High</option></select></td>
      <td data-label="Links">
        <div class="tag-input-wrap" id="bLinksWrap_${i}" onclick="document.getElementById('bLinkInput_${i}').focus()">
          ${(entry.links||[]).map((l,li)=>`<span class="tag-chip">${esc(l)}<button onclick="bulkRemoveLink(${i},${li})">&times;</button></span>`).join('')}
          <input class="tag-input-field" id="bLinkInput_${i}" placeholder="${entry.links.length?'':'+ link'}" onkeydown="bulkTagKey(event,${i},'links')" />
        </div>
      </td>
    </tr>`;
  }).join('');
  updateBulkCount();
}
function bulkTagKey(e,idx,which){
  if(e.key==='Enter'||e.key==='Tab'){
    e.preventDefault();
    const v=e.target.value.trim();if(!v)return;
    if(!bulkEntries[idx][which].includes(v))bulkEntries[idx][which].push(v);
    e.target.value='';
    renderBulkEntries();
    setTimeout(()=>{
      const id='bLinkInput_'+idx;
      const el=document.getElementById(id);if(el)el.focus();
    },20);
  }
  if(e.key==='Backspace'&&!e.target.value){
    const arr=bulkEntries[idx][which];
    if(arr.length){arr.pop();renderBulkEntries();setTimeout(()=>{const id='bLinkInput_'+idx;const el=document.getElementById(id);if(el)el.focus();},20);}
  }
}
function bulkRemoveLink(idx,li){saveBulkFieldValues();bulkEntries[idx].links.splice(li,1);renderBulkEntries();}
async function saveBulkActivities(){
  saveBulkFieldValues();
  const valid=bulkEntries.filter(e=>(e._name||'').trim());
  if(!valid.length){
    const first=document.getElementById('bName_0');
    if(first)shakeEl(first);
    return;
  }
  $('bulkSaveBtn').textContent='Adding…';$('bulkSaveBtn').disabled=true;
  const rows=valid.map(e=>({
    name:e._name.trim(),
    collection_id:curListId,
    description:e._desc.trim()||null,
    location:e._loc.trim()||null,
    location_lat:parseFloat(e._locLat)||null,
    location_lng:parseFloat(e._locLng)||null,
    target_date:e._date||null,
    priority:e._pri||'medium',
    links:e.links||[]
  }));
  const{error}=await sb.from('Activities').insert(rows);
  $('bulkSaveBtn').textContent='Add All';$('bulkSaveBtn').disabled=false;
  if(error){console.error('bulkAdd:',error);alert('Error: '+error.message);return;}
  await updateCollectionStats(curListId);
  closeModal('bulkAddModal');renderDetail();
}
