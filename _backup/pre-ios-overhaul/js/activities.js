/* ==============================================================
   ACTIVITIES — create/edit/delete, completion flow, detail modal
   
   ============================================================== */

function openNewActivity(){
  editingActId=null;aLinks=[];
  $('aName').value='';$('aDesc').value='';$('aLoc').value='';$('aLocLat').value='';$('aLocLng').value='';$('aDate').value='Before I Die';$('aPri').value='medium';
  renderTagChips('aLinks');
  $('actModalTitle').textContent='New Activity';
  $('actSaveBtn').textContent='Add';
  openModal('actModal');setTimeout(()=>$('aName').focus(),300);
}
async function openEditAct(id){
  const a=await fetchActivity(id);if(!a)return;
  editingActId=id;
  $('aName').value=a.name;$('aDesc').value=a.description||'';$('aLoc').value=a.location||'';$('aLocLat').value=a.locationLat||'';$('aLocLng').value=a.locationLng||'';$('aDate').value=a.targetDate||'';
  $('aPri').value=a.priority||'medium';aLinks=[...(a.links||[])];
  renderTagChips('aLinks');
  $('actModalTitle').textContent='Edit Activity';$('actSaveBtn').textContent='Save';
  openModal('actModal');
}
async function saveActivity(){
  const name=$('aName').value.trim();
  if(!name){shakeEl($('aName'));return;}
  const fields={
    name,description:$('aDesc').value.trim(),
    location:$('aLoc').value.trim()||null,
    location_lat:parseFloat($('aLocLat').value)||null,
    location_lng:parseFloat($('aLocLng').value)||null,
    target_date:$('aDate').value||null,
    priority:$('aPri').value,
    links:aLinks
  };
  if(editingActId){
    const{error}=await sb.from('Activities').update(fields).eq('id',editingActId);
    if(error){console.error('saveActivity update:',error);return;}
  } else {
    fields.collection_id=curListId;
    const{error}=await sb.from('Activities').insert(fields);
    if(error){console.error('saveActivity insert:',error);return;}
  }
  await updateCollectionStats(curListId);
  closeModal('actModal');renderDetail();
}
async function delActivity(id){
  const{error}=await sb.from('Activities').delete().eq('id',id);
  if(error){console.error('delActivity:',error);alert('Failed to delete: '+error.message);return;}
  await updateCollectionStats(curListId);
  renderDetail();
}


/* ==============================================================
   COMPLETION
   ============================================================== */
async function openComp(id,editMode){
  const a=await fetchActivity(id);if(!a)return;
  completingId=id;
  if(editMode&&a.completed){
    upPhotos=[...(a.photos||[])];
    $('compName').textContent=a.name;
    $('compLoc').value=a.location||'';$('compLocLat').value=a.locationLat||'';$('compLocLng').value=a.locationLng||'';
    $('compDate').value=a.completedDate||new Date().toISOString().split('T')[0];
    $('compNotes').value=a.completionNotes||'';
    renderThumbs();
    $('compModalTitle').textContent='Edit Completion';
    $('compSaveBtn').textContent='Save';
  } else {
    upPhotos=[];
    $('compName').textContent=a.name;
    $('compLoc').value=a.location||'';$('compLocLat').value=a.locationLat||'';$('compLocLng').value=a.locationLng||'';
    $('compDate').value=new Date().toISOString().split('T')[0];
    $('compNotes').value='';$('photoPrev').innerHTML='';
    $('compModalTitle').textContent='Accomplished';
    $('compSaveBtn').textContent='Mark Complete';
  }
  openModal('compModal');
}
async function confirmComplete(){
  if(!completingId)return;
  const{error}=await sb.from('Activities').update({
    location:$('compLoc').value.trim()||null,
    location_lat:parseFloat($('compLocLat').value)||null,
    location_lng:parseFloat($('compLocLng').value)||null,
    date_completed:$('compDate').value||new Date().toISOString().split('T')[0],
    experience_notes:$('compNotes').value.trim(),
    photos:upPhotos
  }).eq('id',completingId);
  if(error){console.error('confirmComplete:',error);return;}
  if(curListId) await updateCollectionStats(curListId);
  closeModal('compModal');renderDetail();confetti();
  completingId=null;
}
async function undoComp(id){
  const a=await fetchActivity(id);if(!a)return;
  pendingDelete={type:'undo',id};
  $('delConfirmTitle').textContent='Undo Completion';
  $('delConfirmMsg').textContent=`Revert "${a.name}" back to pending? Completion date, notes, and photos will be removed.`;
  $('delConfirmYes').textContent='Undo';
  openModal('deleteConfirmModal');
}

async function openDetModal(id){
  const a=await fetchActivity(id);if(!a)return;
  let h='';
  h+=`<div class="dm-banner">`;
  h+=`<button class="dm-banner-close" onclick="closeModal('detModal')">&#x2715;</button>`;
  h+=`<div class="dm-banner-title">${esc(a.name)}</div>`;
  h+=`<div class="dm-badges">`;
  h+=a.completed
    ?`<span class="dm-badge done">&#x2713; Completed</span>`
    :`<span class="dm-badge pending">&#x25CB; Pending</span>`;
  if(a.completed&&a.completedDate) h+=`<span class="dm-badge" style="background:rgba(255,255,255,.18);color:#fff">${fmtDate(a.completedDate)}</span>`;
  if(a.priority) h+=`<span class="dm-priority dm-priority-${a.priority}">${cap(a.priority)}</span>`;
  if(a.location) h+=`<span class="dm-badge" style="background:rgba(255,255,255,.15);color:#fff">&#x1F4CD; ${esc(a.location)}</span>`;
  h+=`</div></div>`;
  h+=`<div class="dm-content">`;

  if(a.completed){
    /* --- Completed view: only show completion info --- */
    if(a.photos&&a.photos.length>=1){
      const photosArr=`[${a.photos.map(p=>"'"+p.replace(/'/g,"\\'")+"'").join(',')}]`;
      if(a.photos.length===1) h+=`<img class="dm-photo" src="${a.photos[0]}" onclick="event.stopPropagation();openLB(${photosArr},0)" />`;
      else {
        h+=`<div style="margin-bottom:8px;font-family:var(--mono);font-size:.72rem;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);font-weight:600">Photos</div>`;
        h+=`<div class="dm-photos" style="margin-bottom:24px">${a.photos.map((p,i)=>`<div class="dm-photo-item" onclick="event.stopPropagation();openLB(${photosArr},${i})"><img src="${p}" loading="lazy"/></div>`).join('')}</div>`;
      }
    }
    if(a.location) h+=`<div class="dm-notes"><strong style="color:var(--olive)">Location</strong>${esc(a.location)}</div>`;
    if(a.completionNotes) h+=`<div class="dm-notes"><strong style="color:var(--olive)">Experience</strong>${esc(a.completionNotes)}</div>`;
    if(a.links&&a.links.length){
      h+=`<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">${a.links.map(l=>`<a href="${esc(l)}" target="_blank" rel="noopener" class="link-chip">${esc(l.replace(/^https?:\/\//,'').slice(0,40))}${l.replace(/^https?:\/\//,'').length>40?'...':''}</a>`).join('')}</div>`;
    }
    h+=`<div class="dm-actions">`;
    h+=`<button class="btn btn-g" onclick="closeModal('detModal');openComp('${a.id}',true)">Edit Completion</button>`;
    h+=`<button class="btn btn-undo" onclick="undoComp('${a.id}')">Undo</button>`;
    h+=`<button class="btn btn-d" data-delete="activity" data-delete-id="${a.id}">Delete</button>`;
    h+=`</div>`;
  } else {
    /* --- Pending view: show all info --- */
    const infoItems=[];
    if(a.targetDate){
      const di=dateInfo(a);
      infoItems.push(['Target Date',`${esc(a.targetDate)}${di.label?` <span class="time-badge ${di.cls}" style="margin-left:8px">${di.label}</span>`:''}`]);
    }
    if(infoItems.length) h+=`<div class="dm-info-grid">${infoItems.map(([k,v])=>`<div class="dm-info-item"><div class="dm-info-label">${k}</div><div class="dm-info-value">${v}</div></div>`).join('')}</div>`;
    if(a.location) h+=`<div class="dm-notes"><strong>Location</strong>${esc(a.location)}</div>`;
    if(a.description) h+=`<div class="dm-notes"><strong>Description</strong>${esc(a.description)}</div>`;
    if(a.links&&a.links.length){
      h+=`<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">${a.links.map(l=>`<a href="${esc(l)}" target="_blank" rel="noopener" class="link-chip">${esc(l.replace(/^https?:\/\//,'').slice(0,40))}${l.replace(/^https?:\/\//,'').length>40?'...':''}</a>`).join('')}</div>`;
    }
    h+=`<div class="dm-actions">`;
    h+=`<button class="btn btn-g" onclick="closeModal('detModal');openComp('${a.id}')">Mark Complete</button>`;
    h+=`<button class="btn btn-s" onclick="closeModal('detModal');openEditAct('${a.id}')">Edit</button>`;
    h+=`<button class="btn btn-d" data-delete="activity" data-delete-id="${a.id}">Delete</button>`;
    h+=`</div>`;
  }

  h+=`</div>`;
  $('detModalBody').innerHTML=h;
  openModal('detModal');
}
