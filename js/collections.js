/* ==============================================================
   LISTS TAB — the root screen: every collection as a photo card,
   plus the collection create/edit/delete flows.
   ============================================================== */

async function renderCollections(){
  const wrap=$('collGrid');
  wrap.innerHTML='<div class="spinner"></div>';
  try{
    const lists=await fetchCollections();
    if(!lists.length){
      wrap.innerHTML='';
      $('collEmpty').style.display='';
      return;
    }
    $('collEmpty').style.display='none';
    const allActs=await fetchAllActivities(lists);

    wrap.innerHTML=lists.map(l=>{
      const acts=allActs.filter(a=>a.listId===l.id);
      const total=acts.length,done=acts.filter(a=>a.completed).length;
      const pct=total?Math.round(done/total*100):0;
      const cover=l.cover||randCover();
      const complete=total>0&&done===total;
      return `<button class="coll-card" onclick="nav('detail','${l.id}')">
        <img class="coll-card-img" src="${esc(cover)}" alt="" loading="lazy"/>
        <div class="coll-card-scrim"></div>
        ${complete?`<div class="coll-card-done">${icon('check')}</div>`:''}
        <div class="coll-card-body">
          <div class="coll-card-title">${esc(l.name)}</div>
          <div class="coll-card-meta">
            <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span>${done}/${total}</span>
          </div>
        </div>
      </button>`;
    }).join('')+
    `<button class="coll-card-new" onclick="openNewList()">${icon('plus')}<span>New List</span></button>`;
  }catch(e){
    console.error('renderCollections:',e);
    wrap.innerHTML=`<div class="empty" style="grid-column:1/-1">${icon('folder')}
      <div class="empty-title">Couldn’t load</div>
      <div class="empty-sub">${esc(e.message||'Something went wrong.')}</div>
      <button class="btn btn-tinted" onclick="renderCollections()">Try Again</button></div>`;
  }
}

/* ==============================================================
   CREATE / EDIT
   ============================================================== */
function openNewList(){
  editingListId=null;coverPhoto='';
  $('lName').value='';$('lDesc').value='';
  renderCoverPreview();
  $('listSheetTitle').textContent='New List';
  $('listSaveBtn').textContent='Add';
  openModal('listSheet');
  setTimeout(()=>$('lName').focus(),320);
}
async function openEditList(){
  const l=await fetchCollection(curListId);
  if(!l)return;
  editingListId=l.id;coverPhoto=l.cover||'';
  $('lName').value=l.name;$('lDesc').value=l.description||'';
  renderCoverPreview();
  $('listSheetTitle').textContent='Edit List';
  $('listSaveBtn').textContent='Save';
  openModal('listSheet');
}
function renderCoverPreview(){
  const box=$('coverPreview');
  if(coverPhoto){
    box.innerHTML=`<div class="photo-th" style="width:100%;height:120px">
      <img src="${esc(coverPhoto)}" alt=""/>
      <button class="rm-photo" onclick="clearCover()" aria-label="Remove cover">${icon('x')}</button>
    </div>`;
    $('coverZone').style.display='none';
  } else {
    box.innerHTML='';
    $('coverZone').style.display='';
  }
}
function clearCover(){coverPhoto='';renderCoverPreview();}
function handleCoverUpload(e){
  const f=e.target.files[0];if(!f||!f.type.startsWith('image/'))return;
  const r=new FileReader();
  r.onload=ev=>compress(ev.target.result,1200,.85,c=>{coverPhoto=c;renderCoverPreview();});
  r.readAsDataURL(f);e.target.value='';
}

async function saveList(){
  const name=$('lName').value.trim();
  if(!name){shakeEl($('lName'));$('lName').focus();return;}
  const btn=$('listSaveBtn');btn.disabled=true;
  try{
    if(editingListId){
      const updates={name,description:$('lDesc').value.trim()};
      if(coverPhoto) updates.cover_image=coverPhoto;
      const{error}=await sb.from('Collections').update(updates).eq('id',editingListId);
      if(error)throw error;
    } else {
      /* Pick a default cover the user isn't already using. */
      const existing=(await fetchCollections()).map(l=>l.cover).filter(Boolean);
      const{data,error}=await sb.from('Collections').insert({
        name,description:$('lDesc').value.trim(),
        cover_image:coverPhoto||randCover(existing),
        user_id:currentUser.id
      }).select().single();
      if(error)throw error;
      curListId=data.id;
    }
    closeModal('listSheet');
    if(curPage==='detail') renderDetail(); else renderCollections();
  }catch(err){
    console.error('saveList:',err);
    showToast(err.message||'Couldn’t save the list.');
  }finally{ btn.disabled=false; }
}

async function delList(id){
  try{
    /* No DB cascade — the activities have to go first. */
    const{error:e1}=await sb.from('Activities').delete().eq('collection_id',id);
    if(e1)throw e1;
    const{error:e2}=await sb.from('Collections').delete().eq('id',id);
    if(e2)throw e2;
    nav('lists');
    showToast('List deleted');
  }catch(err){
    console.error('delList:',err);
    showToast(err.message||'Couldn’t delete the list.');
  }
}
