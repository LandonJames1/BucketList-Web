/* ==============================================================
   LINK CHIPS — the tag-style URL input in the activity sheet.
   ============================================================== */

let aLinks=[];

/* Vestigial: there was briefly a second chip field, and `which` is
   still threaded through the call sites. There is only one array. */
function getChipArr(which){return aLinks;}

function handleTagKey(e,which){
  if(e.key==='Enter'||e.key==='Tab'){
    const v=e.target.value.trim();
    if(!v)return;
    e.preventDefault();
    const arr=getChipArr(which);
    if(!arr.includes(v)) arr.push(v);
    e.target.value='';
    renderTagChips(which);
  }
  if(e.key==='Backspace'&&!e.target.value){
    const arr=getChipArr(which);
    if(arr.length){arr.pop();renderTagChips(which);}
  }
}
function removeTag(which,idx){
  getChipArr(which).splice(idx,1);
  renderTagChips(which);
}
function renderTagChips(which){
  const arr=getChipArr(which);
  const wrap=$('aLinksWrap');
  if(!wrap)return;
  wrap.innerHTML=arr.map((t,i)=>
    `<span class="chip">${esc(t.replace(/^https?:\/\//,''))}
       <button onclick="removeTag('${which}',${i})" aria-label="Remove link">${icon('x','ic-xs')}</button>
     </span>`).join('');
  const field=document.createElement('input');
  field.className='chip-input';
  field.id='aLinkInput';
  field.type='url';
  field.inputMode='url';
  field.autocapitalize='off';
  field.autocomplete='off';
  field.spellcheck=false;
  field.placeholder=arr.length?'Add another':'Paste a URL, press return';
  field.setAttribute('onkeydown',`handleTagKey(event,'${which}')`);
  wrap.appendChild(field);
}
