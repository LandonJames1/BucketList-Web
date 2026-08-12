/* ==============================================================
   BOOT — paint the static icons, restore the Supabase session, then
   show the app or the auth screen.
   Loaded LAST: every function it touches is already defined.
   ============================================================== */

/* index.html leaves empty placeholder elements where an icon belongs
   rather than inlining a dozen SVG blobs into the markup. Fill them
   in once, here, from the sprite map in js/icons.js. */
function paintStaticIcons(){
  const set=(id,html)=>{const el=$(id);if(el)el.innerHTML=html;};

  /* Tab bar — each tab carries both a stroked and a filled glyph;
     CSS shows whichever matches the selected state. */
  const tab=(id,off,on,label)=>set(id,
    `<span class="ic-off">${icon(off)}</span><span class="ic-on">${icon(on)}</span><span>${label}</span>`);
  tab('tabHome','home','home-fill','Home');
  tab('tabLists','stack','stack-fill','Lists');
  tab('tabMap','compass','compass-fill','Map');
  tab('tabMe','summit','summit-fill','You');

  set('coverZoneIcon',icon('photo','ic-lg'));
  set('photoZoneIcon',icon('camera','ic-lg'));
  set('actMoreChevron',icon('chevron-down'));
  set('bulkAddIcon',icon('plus','ic-sm'));

  set('lbCloseBtn',icon('x'));
  set('lbPrev',icon('chevron-left'));
  set('lbNext',icon('chevron-right'));

  set('installCloseIcon',icon('x'));
  set('iosCloseIcon',icon('x'));
  set('iosShareGlyph',icon('share'));

  set('homeComposerIcon',icon('plus'));
  set('homeComposerGo',icon('chevron-right'));
  set('actListChevron',icon('chevron-right'));
  set('meInstallChevron',icon('chevron-right'));
  const lead=document.querySelector('#page-me .li-blue');
  if(lead) lead.innerHTML=icon('share');
}

(async()=>{
  paintStaticIcons();
  const{data:{session}}=await sb.auth.getSession();
  if(session?.user){
    currentUser=session.user;
    showApp();
  } else {
    showAuth();
  }
})();
