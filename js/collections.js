/* ==============================================================
   LISTS TAB — the root screen: every collection as a photo card,
   plus the collection create/edit/delete flows.
   ============================================================== */

async function renderCollections(){
  const wrap=$('collGrid');
  /* Only when there is actually a wait. Rows are cached for the session
     (api.js), so on every visit after the first this screen paints from
     memory — and blanking it to a spinner first would turn an instant
     redraw into a visible flash of nothing. */
  if(!cacheWarm()) wrap.innerHTML='<div class="spinner"></div>';
  try{
    const lists=await fetchCollections();
    if(!lists.length){
      wrap.innerHTML='';
      $('collEmpty').style.display='';
      return;
    }
    $('collEmpty').style.display='none';
    const allActs=await fetchAllActivities(lists);
    /* Which lists have more than one person in them. Empty set when
       sharing is not enabled, so the badge simply never appears. */
    const sharedOut=await sharedCollectionIds();

    wrap.innerHTML=lists.map(l=>{
      const acts=allActs.filter(a=>a.listId===l.id);
      const total=acts.length,done=acts.filter(a=>a.completed).length;
      const pct=total?Math.round(done/total*100):0;
      const cover=l.cover||randCover();
      const complete=total>0&&done===total;
      /* Outstanding high-priority work, so the tab says which list wants
         attention before you open any of them. Completed ones don't
         count — a list can be all-high and entirely finished. */
      const high=acts.filter(a=>!a.completed&&a.priority==='high').length;
      /* A list is marked as shared whenever more than one person can
         edit it — both a list you joined and one you own and have
         invited someone into. Which side you are on changes what you
         can do (only an owner can delete or re-invite), but the thing
         the card needs to say is simply "someone else is in here too",
         and that is true either way.
         `sharedOut` is filled in below, after the member counts are
         fetched; a joined list is known from the row itself. */
      const shared=isSharedWithMe(l)||sharedOut.has(l.id);
      return `<button class="coll-card" onclick="nav('detail','${l.id}')">
        <img class="coll-card-img" src="${esc(cover)}" alt="" loading="lazy"/>
        <div class="coll-card-scrim"></div>
        ${complete?`<div class="coll-card-done">${icon('check')}</div>`:''}
        ${high?`<div class="coll-card-pri">${high} High</div>`:''}
        ${shared?`<div class="coll-card-shared" title="Shared list"
           aria-label="Shared list">${icon('share','ic-xs')}</div>`:''}
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
    let offline=false;
    if(editingListId){
      const updates={name,description:$('lDesc').value.trim()};
      if(coverPhoto) updates.cover_image=coverPhoto;
      const r=await dbUpdate('Collections',updates,{id:editingListId});
      if(r.error)throw r.error;
      offline=!!r.offline;
    } else {
      /* Pick a default cover the user isn't already using. */
      const existing=(await fetchCollections()).map(l=>l.cover).filter(Boolean);
      /* No .select().single() round trip any more: dbInsert mints the
         uuid itself and hands the stamped row back, so the new
         collection's id is known without asking the server for it —
         which is also what lets a list be created offline and have
         activities filed into it immediately. */
      const r=await dbInsert('Collections',{
        name,description:$('lDesc').value.trim(),
        cover_image:coverPhoto||randCover(existing),
        user_id:currentUser.id
      });
      if(r.error)throw r.error;
      offline=!!r.offline;
      curListId=r.rows[0].id;
    }
    closeModal('listSheet');
    if(offline) showToast('Saved — will sync when you’re back online');
    refreshAfterChange();
  }catch(err){
    console.error('saveList:',err);
    showToast(err.message||'Couldn’t save the list.');
  }finally{ btn.disabled=false; }
}

async function delList(id){
  try{
    /* No DB cascade — the activities have to go first. Queued in this
       order too, so a replay after being offline cannot leave orphaned
       activities behind a deleted collection. */
    const r1=await dbDelete('Activities',{collection_id:id});
    if(r1.error)throw r1.error;
    const r2=await dbDelete('Collections',{id});
    if(r2.error)throw r2.error;
    nav('lists');
    showToast(r2.offline?'List deleted — will sync later':'List deleted');
  }catch(err){
    console.error('delList:',err);
    showToast(err.message||'Couldn’t delete the list.');
  }
}
