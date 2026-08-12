/* ==============================================================
   COLLECTIONS — the grid page plus create/edit/delete a collection
   
   ============================================================== */

async function renderCollections(){
  const newCard=`<div class="collection-card-new" onclick="openNewList()">
    <div class="plus">+</div><span>New Collection</span></div>`;
  try{
  const lists=await fetchCollections();
  console.log('renderCollections: lists=',lists.length,lists);
  const allActs=await fetchAllActivities(lists);
  console.log('renderCollections: allActs=',allActs.length);
  if(!lists.length){
    $('collectionsGrid').innerHTML=newCard;
    return;
  }

  $('collectionsGrid').innerHTML=lists.map(l=>{
    const acts=allActs.filter(a=>a.listId===l.id);
    const cnt=acts.length;
    const done=acts.filter(a=>a.completed).length;
    const cover=l.cover||randCover();
    return `<div class="collection-card" onclick="nav('detail','${l.id}')">
      <img class="collection-card-img" src="${cover}" alt="" loading="lazy"/>
      <div class="collection-card-overlay">
        <div class="collection-card-title">${esc(l.name)}</div>
        ${l.description?`<div class="collection-card-desc">${esc(l.description)}</div>`:''}
        <div class="collection-card-meta">${cnt} items &middot; ${done} accomplished</div>
      </div>
    </div>`;
  }).join('')+newCard;
  }catch(e){
    console.error('renderCollections error:',e);
    $('collectionsGrid').innerHTML=`<div style="padding:20px;color:var(--danger);font-family:var(--mono);font-size:.8rem">Error: ${e.message}</div>`+newCard;
  }
}

/* ---------- Create / edit / delete ---------- */
function openNewList(){
  editingListId=null;coverPhoto='';
  $('lName').value='';$('lDesc').value='';
  $('coverPreview').innerHTML='';$('coverZone').style.display='';
  $('listModalTitle').textContent='New Collection';
  $('listSaveBtn').textContent='Create';
  openModal('listModal');
  setTimeout(()=>$('lName').focus(),300);
}
async function openEditList(){
  const l=await fetchCollection(curListId);
  if(!l)return;
  editingListId=l.id;coverPhoto=l.cover||'';
  $('lName').value=l.name;$('lDesc').value=l.description||'';
  if(coverPhoto){$('coverPreview').innerHTML=`<div class="photo-th" style="width:160px;height:100px"><img src="${coverPhoto}"/><button class="rm-photo" style="opacity:1" onclick="coverPhoto='';$('coverPreview').innerHTML='';$('coverZone').style.display=''">&#x2715;</button></div>`;$('coverZone').style.display='none';}
  else{$('coverPreview').innerHTML='';$('coverZone').style.display='';}
  $('listModalTitle').textContent='Edit Collection';
  $('listSaveBtn').textContent='Save';
  openModal('listModal');
}
function handleCoverUpload(e){
  const f=e.target.files[0];if(!f||!f.type.startsWith('image/'))return;
  const r=new FileReader();
  r.onload=ev=>{compress(ev.target.result,1200,.85,c=>{coverPhoto=c;$('coverPreview').innerHTML=`<div class="photo-th" style="width:160px;height:100px"><img src="${c}"/><button class="rm-photo" style="opacity:1" onclick="coverPhoto='';$('coverPreview').innerHTML='';$('coverZone').style.display=''">&#x2715;</button></div>`;$('coverZone').style.display='none';});};
  r.readAsDataURL(f);e.target.value='';
}
async function saveList(){
  const name=$('lName').value.trim();
  if(!name){shakeEl($('lName'));return;}
  if(editingListId){
    const updates={name,description:$('lDesc').value.trim()};
    if(coverPhoto) updates.cover_image=coverPhoto;
    const{error}=await sb.from('Collections').update(updates).eq('id',editingListId);
    if(error){console.error('saveList update:',error);return;}
  } else {
    /* Gather existing covers so we don't repeat */
    const existingLists=await fetchCollections();
    const existingCovers=existingLists.map(l=>l.cover).filter(Boolean);
    const{data,error}=await sb.from('Collections').insert({
      name,description:$('lDesc').value.trim(),
      cover_image:coverPhoto||randCover(existingCovers),
      user_id:currentUser.id
    }).select().single();
    if(error){console.error('saveList insert:',error);return;}
    curListId=data.id;
  }
  closeModal('listModal');
  if(curPage==='detail') renderDetail();
  else if(curPage==='collections') renderCollections();
  else renderHome();
}
async function delList(id){
  const{error:e1}=await sb.from('Activities').delete().eq('collection_id',id);
  if(e1){console.error('delList activities:',e1);alert('Failed to delete activities: '+e1.message);return;}
  const{error:e2}=await sb.from('Collections').delete().eq('id',id);
  if(e2){console.error('delList collection:',e2);alert('Failed to delete collection: '+e2.message);return;}
  nav('collections');
}
