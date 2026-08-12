/* ==============================================================
   REMINDERS — "nudge me about this on a date".

   The motivating case: a campsite whose reservations open months
   before the trip. The activity's *target* is the trip; the reminder
   is the day you have to act.

   THREE DELIVERY PATHS — deliberately, in order of reliability.

   A web app cannot wake itself up: Notification Triggers never shipped
   past an experiment, so nothing in the browser can schedule a banner
   for a future date. Hence:

   1. The Home banner. Always works, needs no permission, no backend and
      no install. This is the floor.
   2. A local notification when the app is opened or foregrounded on or
      after the date. Needs permission only.
   3. Real background push, delivered on the day even with the app
      closed. Needs the backend in supabase/ deployed, VAPID_PUBLIC_KEY
      set in config.js, permission granted, and — on iOS — the PWA
      installed to the home screen.

   All three coexist because each has a different failure mode. Building
   on (3) alone would mean a reminder that silently never arrives for
   anyone who skipped one of its four prerequisites.
   ============================================================== */

/* Reminders already announced, so re-opening the app doesn't re-ping.
   Keyed by activity + date, so moving a reminder re-arms it. */
const NOTIFIED_KEY='bl_notified_reminders';

function notifiedSet(){
  try{ return new Set(JSON.parse(localStorage.getItem(NOTIFIED_KEY))||[]); }
  catch(e){ return new Set(); }
}
function markNotified(keys){
  try{
    const s=notifiedSet();
    keys.forEach(k=>s.add(k));
    /* Keep the list from growing without bound. */
    localStorage.setItem(NOTIFIED_KEY,JSON.stringify([...s].slice(-200)));
  }catch(e){}
}

/* Unfinished activities whose reminder date has arrived. */
function dueReminders(acts){
  const today=todayISO();
  return acts.filter(a=>!a.completed&&a.remindAt&&a.remindAt<=today)
    .sort((a,b)=>a.remindAt.localeCompare(b.remindAt));
}

/* ==============================================================
   THE HOME BANNER — the part that always works
   ============================================================== */
function renderHomeReminders(acts,lists){
  const sec=$('homeRemindersSection');
  if(!sec)return;
  const due=remindersReady()?dueReminders(acts):[];
  if(!due.length){sec.style.display='none';return;}
  sec.style.display='';

  $('homeReminders').innerHTML=due.map(a=>{
    const l=lists.find(c=>c.id===a.listId);
    const when=a.remindAt===todayISO()?'Today':fmtDate(a.remindAt);
    return `<div class="rem-row">
      <span class="rem-icon">${icon('clock')}</span>
      <button class="rem-main" onclick="openActDetail('${a.id}')">
        <span class="rem-name">${esc(a.name)}</span>
        ${a.remindNote?`<span class="rem-note">${esc(a.remindNote)}</span>`:''}
        <span class="rem-meta">${esc(when)}${l?' · '+esc(l.name):''}</span>
      </button>
      <button class="rem-dismiss" onclick="event.stopPropagation();clearReminder('${a.id}')"
              aria-label="Dismiss reminder">${icon('x')}</button>
    </div>`;
  }).join('');
}

async function clearReminder(id){
  const{error}=await sb.from('Activities').update({remind_at:null}).eq('id',id);
  if(error){
    console.error('clearReminder:',error);
    showToast(error.message||'Couldn’t clear that.');
    return;
  }
  showToast('Reminder cleared');
  if(curPage==='home') renderHome(); else if(curPage==='detail') renderDetail();
}

/* ==============================================================
   NOTIFICATIONS — the bonus layer
   ============================================================== */
function notificationsSupported(){
  return 'Notification' in window && 'serviceWorker' in navigator;
}
function notificationState(){
  if(!notificationsSupported()) return 'unsupported';
  return Notification.permission;          /* default | granted | denied */
}

async function requestNotifications(){
  if(!notificationsSupported()){
    showToast('This browser can’t show notifications');
    return;
  }
  if(Notification.permission==='denied'){
    showToast('Notifications are blocked in your browser settings');
    return;
  }
  /* On iOS, Notification.requestPermission only resolves for a PWA
     installed to the home screen. Say so rather than appearing to hang. */
  if(isIOS()&&!isStandalone()){
    showToast('Add to Home Screen first, then enable reminders');
    pwaShowInstallHelp();
    return;
  }
  const res=await Notification.requestPermission();
  if(res==='granted'){
    await subscribeToPush();
    showToast('Reminders on');
    checkDueReminders();
  }
  if(curPage==='me') renderMe();
}

/* ==============================================================
   WEB PUSH SUBSCRIPTION

   Registers this device with the browser's push service and stores the
   resulting endpoint so the Edge Function can reach it. Safe to call
   repeatedly — the endpoint is the primary key on the server side, so
   re-subscribing updates in place.
   ============================================================== */
function pushConfigured(){
  return typeof VAPID_PUBLIC_KEY==='string' && VAPID_PUBLIC_KEY.length>20;
}

/* VAPID keys are base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64){
  const padded=(base64+'='.repeat((4-base64.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(padded);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

async function subscribeToPush(){
  if(!pushConfigured()){
    console.info('[reminders] VAPID_PUBLIC_KEY not set — background push disabled, '+
      'falling back to the Home banner. See supabase/README.md.');
    return false;
  }
  if(!('PushManager' in window)) return false;
  try{
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub){
      sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const raw=sub.toJSON();
    const{error}=await sb.from('push_subscriptions').upsert({
      user_id:currentUser.id,
      endpoint:raw.endpoint,
      p256dh:raw.keys.p256dh,
      auth:raw.keys.auth,
      user_agent:navigator.userAgent.slice(0,300),
    },{onConflict:'endpoint'});
    if(error){console.error('[reminders] could not store subscription:',error);return false;}
    return true;
  }catch(e){
    console.warn('[reminders] push subscribe failed:',e);
    return false;
  }
}

/* Drop this device's subscription — used on sign-out so a shared phone
   does not keep pushing the previous account's reminders. */
async function unsubscribeFromPush(){
  try{
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.getSubscription();
    if(!sub)return;
    const endpoint=sub.endpoint;
    await sub.unsubscribe();
    await sb.from('push_subscriptions').delete().eq('endpoint',endpoint);
  }catch(e){ /* best effort */ }
}

/* Fire a local notification for anything newly due. Called on launch
   and whenever the app comes back to the foreground — the only two
   moments a web app is actually running. */
async function checkDueReminders(){
  if(!remindersReady()||!currentUser) return;
  if(notificationState()!=='granted') return;

  let acts=[];
  try{ acts=await fetchAllActivities(); }catch(e){ return; }
  const due=dueReminders(acts);
  if(!due.length) return;

  const seen=notifiedSet();
  const fresh=due.filter(a=>!seen.has(a.id+'@'+a.remindAt));
  if(!fresh.length) return;

  try{
    const reg=await navigator.serviceWorker.ready;
    /* One notification for one, a summary for several — a burst of
       separate banners after a week away is hostile. */
    if(fresh.length===1){
      const a=fresh[0];
      await reg.showNotification(a.name,{
        /* The note is the actionable part; the name is the title. */
        body:a.remindNote||'Reminder', tag:'bl-reminder-'+a.id,
        icon:'icons/icon-192.png', badge:'icons/favicon-32.png',
        data:{url:'./index.html'},
      });
    } else {
      await reg.showNotification(`${fresh.length} reminders`,{
        body:fresh.slice(0,3).map(a=>a.name).join(', ')+(fresh.length>3?'…':''),
        tag:'bl-reminders', icon:'icons/icon-192.png', badge:'icons/favicon-32.png',
        data:{url:'./index.html'},
      });
    }
    markNotified(fresh.map(a=>a.id+'@'+a.remindAt));
  }catch(e){ console.warn('[reminders] could not show notification:',e); }
}

/* The app is only ever running in the foreground, so these are the two
   moments a reminder can possibly be noticed. */
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible') checkDueReminders();
});
