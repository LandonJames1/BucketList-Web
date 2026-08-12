/* ==============================================================
   LINK CHIPS — the tag-style URL input used by the activity modal
   
   ============================================================== */

let aLinks=[];
function getChipArr(which){return aLinks;}
function handleTagKey(e,which){
  if(e.key==='Enter'||e.key==='Tab'){
    e.preventDefault();
    const v=e.target.value.trim();
    if(!v)return;
    const arr=getChipArr(which);
    if(!arr.includes(v)){arr.push(v);}
    e.target.value='';
    renderTagChips(which);
  }
  if(e.key==='Backspace'&&!e.target.value){
    const arr=getChipArr(which);
    if(arr.length){arr.pop();renderTagChips(which);}
  }
}
function removeTag(which,idx){
  const arr=getChipArr(which);
  arr.splice(idx,1);renderTagChips(which);
}
function renderTagChips(which){
  const arr=getChipArr(which);
  const wrapId='aLinksWrap';
  const inputId='aLinkInput';
  const placeholder='Paste a URL and press Enter...';
  const wrap=$(wrapId);if(!wrap)return;
  wrap.innerHTML=arr.map((t,i)=>`<span class="tag-chip">${esc(t)}<button onclick="removeTag('${which}',${i})">&times;</button></span>`).join('');
  const field=document.createElement('input');
  field.className='tag-input-field';field.id=inputId;
  field.placeholder=arr.length?'':placeholder;
  field.setAttribute('onkeydown',`handleTagKey(event,'${which}')`);
  wrap.appendChild(field);
}
