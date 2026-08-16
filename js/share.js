/* ==============================================================
   SHARE IN — a link becomes an activity.

   Three ways in, one destination. They exist as three because each
   fails somewhere the others do not, the same shape as the three
   reminder delivery paths:

     1. Paste a link into the Home composer. No permissions, no
        backend, no install. The floor.
     2. An iOS Shortcut that opens ?share=<url>. iOS cannot register a
        PWA as a share target — the Web Share Target API is Chrome-only
        and the WebKit bug has been open since 2019 — so on the platform
        this app is built for, a Shortcut is the share sheet entry.
     3. share_target in the manifest, which gets Android and desktop
        Chrome for free.

   All three land on a query param, which this file reads once at boot
   and strips immediately so a reload cannot re-import the same link.

   The link is then unfurled by supabase/functions/unfurl (a browser
   cannot read any of these pages itself — CORS blocks every one) and
   the result is *reviewed*, never written straight through: extraction
   is sometimes wrong, and silently creating junk is worse than the
   feature not existing.
   ============================================================== */

/* What came in, and what came back.

   shareInput is `{url,title,text}` for a link, or `{image,mediaType,
   preview}` for a screenshot — see the SCREENSHOT section below. The
   two share every screen after extraction, so the sheet, the picker
   and the hand-off never branch on which one it was. */
let shareInput=null,shareDrafts=[],shareCover='',shareBusy=false;

/* ==============================================================
   READING THE SHARE

   Runs at boot from main.js, before the session is restored: a share
   can arrive while signed out, and the sign-in screen must not eat it.
   ============================================================== */
const SHARE_STASH='bl_pending_share';

function readSharedInput(){
  let params;
  try{ params=new URLSearchParams(location.search); }catch(e){ params=null; }
  if(!params||!params.toString()){
    /* Same recovery as readPendingJoin(): a first visit installs the
       service worker, which reloads the page after the query string
       has already been stripped. See js/pwa.js. */
    const kept=bootRead(SHARE_STASH);
    if(kept){ try{ pendingShare=JSON.parse(kept); }catch(e){} }
    return;
  }

  const text=(params.get('text')||'').trim();
  /* Android's share sheet often puts the URL inside the text rather
     than in url, and some apps send a title with the link trailing it,
     so fall back to the first URL found anywhere. */
  const url=(params.get('share')||params.get('url')||'').trim()
    || (text.match(/https?:\/\/[^\s]+/)||[''])[0];

  if(!url) return;

  pendingShare={
    url,
    title:(params.get('title')||'').trim(),
    /* Keep the text only when it is more than the link itself — it is
       occasionally the caption, which is exactly what we want to read. */
    text:text&&text!==url?text:'',
  };

  /* Held where a reload cannot destroy it — see bootKeep() in
     js/utils.js and the controllerchange handler in js/pwa.js. */
  bootKeep(SHARE_STASH,JSON.stringify(pendingShare));

  /* The app has no router, so the param has no meaning past this
     point. Strip it before anything can reload onto it. */
  history.replaceState(null,'',location.pathname);
}

/* Called from showApp() once there is a signed-in user to file it for. */
function handleSharedInput(){
  if(!pendingShare) return;
  const input=pendingShare;
  pendingShare=null;
  /* Consumed, for the same reason readPendingJoin()'s code is. */
  bootDrop(SHARE_STASH);
  openImportSheet(input);
}

/* ==============================================================
   THE IMPORT SHEET
   ============================================================== */
async function openImportSheet(input){
  shareInput=input;shareDrafts=[];shareCover='';
  $('importSource').textContent=input.image?'Screenshot':prettyUrl(input.url);
  renderImportState('loading');
  openModal('importSheet');
  await runUnfurl('');
}

/* ==============================================================
   SCREENSHOTS

   The general capture route, and the one that finally makes
   Instagram work — see the header of supabase/functions/unfurl.
   Anything on screen can be screenshotted, so this path is not
   limited to the five platforms the link path knows about.

   Entry points, in the order people find them:
     - the camera button in the Home composer
     - "Read a screenshot instead" on any failed link import

   The image is downscaled here rather than server-side. A phone
   screenshot is 2–4MB of PNG; 1568px on the long edge is the size
   above which the model gains nothing, and sending the original
   would be several seconds of upload on cellular for no better
   result.
   ============================================================== */
const SHOT_MAX_DIM=1568;
const SHOT_QUALITY=.85;

/* The camera button, and the retry on a failed link. */
function pickScreenshot(){
  const el=$('shotInput');
  if(el) el.click();
}

async function handleScreenshot(e){
  const file=(e.target.files||[])[0];
  e.target.value='';
  if(!file||!file.type.startsWith('image/'))return;

  /* An import sheet may already be open — this is the retry path off
     a failed link — so close it before the next one opens, or the two
     transforms fight. */
  const wasOpen=$('importSheet').classList.contains('open');
  if(wasOpen){ closeModal('importSheet'); await new Promise(r=>setTimeout(r,200)); }

  let dataUrl;
  try{
    dataUrl=await compressFile(file,SHOT_MAX_DIM,SHOT_QUALITY);
  }catch(err){
    console.warn('handleScreenshot:',err);
    showToast('Couldn’t read that image.');
    return;
  }
  openImportSheet({
    image:dataUrl,
    mediaType:'image/jpeg',   /* compressFile always re-encodes as JPEG */
    /* Shown while it is being read, so the sheet is obviously working
       on the right picture. */
    preview:dataUrl,
  });
}

/* Host + a truncated path: the full URL of a TikTok is mostly a
   tracking payload and tells the reader nothing. */
function prettyUrl(u){
  try{
    const p=new URL(u);
    const path=p.pathname.replace(/\/$/,'');
    return p.hostname.replace(/^www\./,'')+(path.length>28?path.slice(0,28)+'…':path);
  }catch(e){ return u; }
}

async function runUnfurl(caption){
  if(shareBusy) return;
  /* Reading anything — a link or a screenshot — needs the network. A
     queued import is not a sensible thing to build: the whole point is
     to come back with a filled-in draft to review. */
  if(!navigator.onLine){ return importFailed('offline'); }
  shareBusy=true;
  renderImportState('loading');
  try{
    /* One call, two payloads. A screenshot sends its bytes; a link
       sends its URL. The response shape is identical either way. */
    const body=shareInput.image
      ? {image:shareInput.image,mediaType:shareInput.mediaType,text:caption||''}
      : {url:shareInput.url,text:caption||shareInput.text||''};

    const{data,error}=await sb.functions.invoke('unfurl',{body});
    if(error) throw error;
    shareCover=data.cover||shareInput.preview||'';
    shareDrafts=(data.activities||[]).map(a=>({...a,pick:true}));

    if(!shareDrafts.length){
      /* Instagram serves a login wall to anything unauthenticated, so
         there is nothing to read and no amount of retrying changes it.
         A screenshot or the caption is the way through. */
      importFailed(data.degraded||'empty');
    } else if(shareInput.image&&shareDrafts.length===1){
      /* A screenshot that read as one activity goes straight to the
         activity sheet. The review card was showing the user their own
         screenshot back with one result under it and an Add button —
         a confirmation of something they had not asked about yet, on
         the way to a sheet that is itself the review step and still
         needs a Save. Several results keep the sheet: there is a
         genuine choice to make between them. */
      await handOffSingle(shareDrafts[0]);
    } else {
      renderImportState('ready');
    }
  }catch(e){
    /* The backend is optional, exactly like the media bucket and the
       reminder column. Without it the link still becomes an activity —
       the user just types the name. */
    console.warn('unfurl:',e);
    shareDrafts=[];
    importFailed('failed');
  }finally{ shareBusy=false; }
}

/* ==============================================================
   WHEN NOTHING COULD BE READ

   The two paths part company here, because what the user should do
   next is genuinely different.

   A **link** keeps the failure card. Its offer — "read a screenshot
   instead" — is the entire reason Instagram is usable, and pasting the
   caption is a real second attempt at the same import. There is
   something to do on that card.

   A **screenshot** does not. It was already the fallback: the picture
   is the last thing the app can read, so nothing on that card was a
   route back to a filled-in draft. What it actually offered was a
   textarea for describing the activity in words — which is the
   activity sheet, with fewer fields and an extra step in front of it.
   So the sheet opens instead, carrying one line saying why it is
   empty. Failing into the form you were heading for beats failing
   into a page about the failure.
   ============================================================== */
const SHOT_FAIL_NOTICE={
  no_model: 'Reading screenshots isn’t switched on for this app yet, so nothing could be read from the picture. Fill this in yourself.',
  too_large:'That image was too big to read. Fill this in yourself — or cancel and try a screenshot rather than a full-resolution photo.',
  offline:  'You’re offline, so the screenshot couldn’t be read. Fill this in and it’ll sync once you’re back.',
  failed:   'The screenshot couldn’t be read just now. Fill this in yourself.',
};
const SHOT_FAIL_DEFAULT=
  'Nothing in that screenshot read as an activity, so it couldn’t be filled in for you. Add the details yourself.';

function importFailed(reason){
  if(!(shareInput&&shareInput.image)){
    /* The link path is unchanged — see IMPORT_FAIL_STATE. */
    renderImportState(IMPORT_FAIL_STATE[reason]||'empty');
    return;
  }
  handOffSingle(
    {name:'',location:'',lat:null,lng:null},
    SHOT_FAIL_NOTICE[reason]||SHOT_FAIL_DEFAULT);
}

/* Which "it didn't work" screen each backend outcome earns. They
   differ because the way out differs: an Instagram link wants a
   screenshot or a caption, an unreadable screenshot wants retyping. */
const IMPORT_FAIL_STATE={
  instagram:'caption',
  no_model:'nomodel',
  too_large:'toolarge',
  refused:'empty',
  failed:'offline',
};

function renderImportState(state){
  const body=$('importBody'),btn=$('importAddBtn');
  const title=$('importTitle');
  const isShot=!!(shareInput&&shareInput.image);

  if(state==='loading'){
    title.textContent=isShot?'Reading screenshot':'Reading link';
    btn.style.display='none';
    body.innerHTML=`<div class="imp-status">
      ${isShot&&shareInput.preview
        ? `<div class="imp-shot-preview"><img src="${esc(shareInput.preview)}" alt=""/></div>`:''}
      <div class="spinner"></div>
      <p>${isShot?'Reading what’s on screen…':'Reading the link…'}</p></div>`;
    return;
  }

  /* **Links only.** A screenshot that could not be read never lands
     here — importFailed() sends it to the activity sheet instead. This
     card survives because on a link there is a real next attempt to
     offer: a screenshot, or the caption. */
  if(state==='caption'||state==='empty'||state==='offline'||
     state==='nomodel'||state==='toolarge'){
    title.textContent='Add from link';
    btn.style.display='none';

    const msg=
      state==='caption'   ? 'Instagram doesn’t let apps read a post — screenshot it instead, and it’ll be read straight off the picture. Pasting the caption works too.'
    : state==='offline'   ? (navigator.onLine
                              ? 'Couldn’t read that link. Screenshot the page instead, paste the text, or add it by hand.'
                              : 'You’re offline, so nothing can be read right now. Add it by hand and it’ll sync later.')
    : state==='nomodel'   ? 'Reading pages needs ANTHROPIC_API_KEY set on the unfurl function. Add it by hand for now.'
    : state==='toolarge'  ? 'That was too big to read. Try a screenshot rather than a full-resolution image.'
    :                       'Nothing about a place or experience in that link. Screenshot it, or paste the caption if there’s more to it.';

    /* The screenshot button is the whole reason Instagram is usable at
       all — the user already has the post on screen, and a screenshot
       needs no API, no permission and no cooperation from the platform. */
    body.innerHTML=`
      <div class="imp-status">
        <p>${esc(msg)}</p>
        <button class="btn btn-filled btn-block" onclick="pickScreenshot()">
          ${icon('camera','ic-sm')}Read a screenshot instead</button>
        <textarea id="importCaption" rows="4" placeholder="Paste the caption"></textarea>
        <button class="btn btn-tinted btn-block" onclick="importFromCaption()">Read this text</button>
        <button class="btn btn-plain btn-block" onclick="importByHand()">Add by hand</button>
      </div>`;
    return;
  }

  /* Ready. One result goes straight to the activity sheet on Add —
     there is nothing to choose between. Several get a checklist,
     because a listicle always carries one or two you do not want. */
  const many=shareDrafts.length>1;
  title.textContent=many?`${shareDrafts.length} found`:'Add from link';
  btn.style.display='';
  updateImportBtn();

  body.innerHTML=`
    ${shareCover?`<div class="imp-cover" style="background-image:url('${esc(shareCover)}')"></div>`:''}
    <div class="imp-list">
      ${shareDrafts.map((d,i)=>{
        /* A shared listicle is where duplicates arrive in bulk, so
           they are marked here — before anything is picked — rather
           than stopping the user at the end of the flow. It is a note
           on the row, not a block: the row stays selectable, because
           the app is guessing and the user is not. */
        const dupe=dupeHintFor(d.name,d.location||'');
        return `<button class="imp-item${d.pick?' picked':''}" id="impItem_${i}"
                ${many?`onclick="toggleImportPick(${i})"`:'disabled'}>
          ${many?`<span class="imp-check">${icon('check')}</span>`:''}
          <span class="imp-item-body">
            <span class="imp-item-name">${esc(d.name)}</span>
            ${d.location?`<span class="imp-item-loc">${icon('pin')}${esc(d.location)}</span>`:''}
            ${dupe?`<span class="imp-item-dupe">Already have &ldquo;${esc(dupe)}&rdquo;</span>`:''}
          </span>
        </button>`;
      }).join('')}
    </div>
    <p class="imp-note">You can edit everything before it’s saved.</p>`;
}

function toggleImportPick(i){
  shareDrafts[i].pick=!shareDrafts[i].pick;
  const el=$('impItem_'+i);
  if(el) el.classList.toggle('picked',shareDrafts[i].pick);
  updateImportBtn();
}

function updateImportBtn(){
  const n=shareDrafts.filter(d=>d.pick).length;
  const btn=$('importAddBtn');
  btn.disabled=!n;
  btn.textContent=shareDrafts.length>1?`Add ${n}`:'Add';
}

function importFromCaption(){
  const t=$('importCaption');
  const v=t?t.value.trim():'';
  if(!v){ if(t) shakeEl(t); return; }
  runUnfurl(v);
}

/* Escape hatch from every failed state: the link is still worth
   keeping even when nothing could be read off it. */
function importByHand(){
  shareDrafts=[{name:(shareInput&&shareInput.title)||'',location:'',lat:null,lng:null,pick:true}];
  handOffSingle(shareDrafts[0]);
}

/* The source URL to file with an imported activity, or nothing at all
   for a screenshot — there is no link to keep, and an empty string in
   the links array renders as a broken chip. */
function shareSourceLinks(){
  return shareInput&&shareInput.url?[shareInput.url]:[];
}

function confirmImport(){
  const picked=shareDrafts.filter(d=>d.pick);
  if(!picked.length) return;
  if(picked.length===1) handOffSingle(picked[0]);
  else handOffMany(picked);
}

/* ==============================================================
   HAND-OFF

   Nothing here writes to the database. One draft opens the ordinary
   activity sheet with the fields filled in; several seed the bulk
   sheet. Both are the screens the user already knows, and both still
   require a Save.
   ============================================================== */
/* `notice` is passed only by importFailed() — a line in the sheet saying
   why it arrived empty. A successful import leaves it off. */
async function handOffSingle(draft,notice){
  closeModal('importSheet');
  /* Let the sheet finish sliding out before the next one starts, or
     the two transforms fight and the second appears half-open. */
  await new Promise(r=>setTimeout(r,240));

  await openNewActivity(draft.name||'',notice);
  $('aLoc').value=draft.location||'';
  $('aLocLat').value=draft.lat??'';
  $('aLocLng').value=draft.lng??'';
  aLinks=shareSourceLinks();
  renderTagChips('aLinks');
}

async function handOffMany(drafts){
  const lists=await fetchCollections();
  if(!lists.length){
    showToast('Create a list first');
    closeModal('importSheet');
    openNewList();
    return;
  }
  const seed=id=>{
    closeModal('importSheet');
    setTimeout(()=>{
      openBulkAdd(id);
      const links=shareSourceLinks();
      bulkEntries=drafts.map(d=>({
        links,
        _name:d.name||'',
        _loc:d.location||'',
        _locLat:d.lat??'',
        _locLng:d.lng??'',
        _date:DEFAULT_TARGET_DATE,
        _pri:'medium',
      }));
      /* openBulkAdd pushed a blank row; the array was just replaced
         wholesale, so redraw from it rather than from the DOM. */
      _skipSaveBulk=true;
      renderBulkEntries();
      _skipSaveBulk=false;
    },240);
  };

  if(lists.length===1){ seed(lists[0].id); return; }
  openListPicker({
    subtitle:`${drafts.length} activities`,
    onPick:seed,
  });
}

/* ==============================================================
   THE PASTE PATH

   No new affordance on Home: the composer is already the add control,
   and a second one beside it is one too many. It just notices when
   what you typed is a link and changes what its button does.
   ============================================================== */
function looksLikeUrl(s){
  return /^https?:\/\/\S+\.\S+/i.test((s||'').trim());
}

function importFromComposer(){
  const input=$('homeComposerInput');
  const url=input.value.trim();
  if(!looksLikeUrl(url)){ shakeEl(input); return; }
  input.value='';onHomeComposerInput();
  openImportSheet({url,title:'',text:''});
}
