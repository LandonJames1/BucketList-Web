/* ==============================================================
   REMINDERS — "nudge me about this on a date".

   The motivating case: a campsite whose reservations open months
   before the trip. The activity's *target* is the trip; the reminder
   is the day you have to act.

   WHAT THIS CAN AND CANNOT DO — read before extending it.

   A web app cannot wake itself up. There is no reliable way to schedule
   a notification for a future date from the browser: Notification
   Triggers never shipped beyond an experiment, and the Push API needs a
   server to send the push. So a reminder here fires when the app is
   *opened or foregrounded* on or after its date, not at 9am while the
   phone is in a pocket.

   That is why a due reminder is also surfaced as a banner at the top of
   Home. The banner is the real mechanism and the notification is a
   bonus; anything that relied on the notification alone would silently
   not work.

   Making it a true background push means: a Supabase Edge Function
   holding VAPID keys, a push_subscriptions table, and pg_cron running a
   daily sweep. See the note in CLAUDE.md.
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
  const res=await Notification.requestPermission();
  if(res==='granted'){
    showToast('Reminders on');
    checkDueReminders();
  }
  if(curPage==='me') renderMe();
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
      await reg.showNotification('Reminder',{
        body:a.name, tag:'bl-reminder-'+a.id,
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
