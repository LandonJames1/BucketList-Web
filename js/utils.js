/* ==============================================================
   UTILS — small helpers used everywhere.
   DOM lookup, HTML escaping, date formatting and urgency,
   image compression, and the completion confetti.
   ============================================================== */

const $=id=>document.getElementById(id);

function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function todayISO(){return new Date().toISOString().split('T')[0];}

function fmtDate(s,withYear){
  const d=new Date(s+'T00:00:00');
  const now=new Date();
  const opts={month:'short',day:'numeric'};
  /* Only spell out the year when it isn't the current one — the way iOS
     date labels do. `withYear` overrides that for the places where the
     date is the record rather than a hint: an accomplishment is
     something you look back on, and "Jul 19" with no year is no use a
     year later. */
  if(withYear||d.getFullYear()!==now.getFullYear()) opts.year='numeric';
  return d.toLocaleDateString('en-US',opts);
}

/* target_date is a text column holding one of two things: a preset band
   ("This Year"), or an ISO date the user picked ("2026-12-25"). Both live
   in the same column — no schema change was needed to add real dates. */
const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;
function isCustomDate(v){ return ISO_DATE.test(v||''); }

/* Whole calendar days from today until an ISO date: today is 0,
   tomorrow 1, yesterday -1. Both sides are floored to midnight — doing
   the arithmetic on timestamps instead makes "today" come out as 1
   whenever the clock has passed midnight, which it always has. */
function daysUntil(iso){
  const target=new Date(iso+'T00:00:00');
  const today=new Date();
  today.setHours(0,0,0,0);
  return Math.round((target-today)/864e5);
}

/* Whole days until an activity's target, whichever kind it is. Used for
   sorting, where the urgency *class* is too coarse: "tomorrow" and
   "19 days" are both `urgent`, so ranking by class alone would let
   priority push tomorrow's flight below something three weeks out.
   Undated things sort last. */
const NO_TARGET=10**7;

/* The actual Date an activity is aiming at: itself if the user picked a
   date, the end of the window if they picked a band. Null for Someday
   and undated. This is what lets a specific date slot into the running
   order beside the bands — a date in September sorts before a "This
   year" band, which resolves to 31 December. */
function resolvedTarget(a){
  if(!a.targetDate||a.targetDate==='Before I Die') return null;
  if(isCustomDate(a.targetDate)) return new Date(a.targetDate+'T00:00:00');
  return presetTargetDate(a.targetDate);
}

function daysToTarget(a){
  if(!a.targetDate) return NO_TARGET;
  if(a.targetDate==='Before I Die') return NO_TARGET-1;
  const t=resolvedTarget(a);
  if(!t) return NO_TARGET;
  const today=new Date();today.setHours(0,0,0,0);
  return Math.round((t-today)/864e5);
}

/* Which calendar bucket an activity falls in, worked out from its
   *resolved* date rather than from the band it was given. That is the
   whole point: an activity dated 5 September and one set to "This year"
   both belong under this year, and sorting inside the bucket puts the
   5th before 31 December automatically.

   `order` is what the Up Next screen sorts its groups by. */
function targetBand(a){
  if(!a.targetDate)                 return{id:'none',   label:'No date',    order:90};
  if(a.targetDate==='Before I Die') return{id:'someday',label:'Someday',    order:80};
  if(daysToTarget(a)<0)             return{id:'overdue',label:'Overdue',    order:0};

  const t=resolvedTarget(a);
  if(!t)                            return{id:'none',   label:'No date',    order:90};
  const now=new Date();
  const endOf=(y,m,d)=>new Date(y,m,d,23,59,59);
  if(t<=endOf(now.getFullYear(),now.getMonth()+1,0)) return{id:'month',label:'This month', order:1};
  if(t<=endOf(now.getFullYear(),11,31))              return{id:'year', label:'This year',  order:2};
  if(t<=endOf(now.getFullYear()+1,11,31))            return{id:'next', label:'Next year',  order:3};
  if(t<=endOf(now.getFullYear()+3,11,31))            return{id:'y23',  label:'2–3 years',  order:4};
  return{id:'y5',label:'5+ years',order:5};
}

/* Bands that describe a range or an open end rather than a deadline.
   Their resolved date exists only so they can be sorted and grouped; it
   is not a date the user chose, so it must never be counted down to.
   The labels match the group headers targetBand() hands the Up Next
   screen, so a row reads the same as the section it sits under. */
const OPEN_BANDS={'In 2-3 Years':'2–3 years','In 5+ Years':'5+ years'};

/* The end of the window each preset band describes. */
function presetTargetDate(v){
  const now=new Date();
  switch(v){
    case 'This Month':   return new Date(now.getFullYear(),now.getMonth()+1,0);
    case 'This Year':    return new Date(now.getFullYear(),11,31);
    case 'Next Year':    return new Date(now.getFullYear()+1,11,31);
    case 'In 2-3 Years': return new Date(now.getFullYear()+3,11,31);
    case 'In 5+ Years':  return new Date(now.getFullYear()+5,11,31);
    default: return null;
  }
}

/* Turn an activity's target date into a short label plus an urgency
   class, for both kinds of value. */
function dateInfo(a){
  if(a.completed) return{label:a.completedDate?fmtDate(a.completedDate):'Done',cls:'done'};
  if(!a.targetDate) return{label:'',cls:''};
  if(a.targetDate==='Before I Die') return{label:'Someday',cls:'forever'};

  /* A specific date: count down while it is close, then show the date
     itself — once something is months out, "Dec 25" is more use than
     "184 days left". */
  if(isCustomDate(a.targetDate)){
    const d=daysUntil(a.targetDate);
    if(d<0)   return{label:'Overdue',cls:'overdue'};
    if(d===0) return{label:'Today',cls:'overdue'};
    if(d===1) return{label:'Tomorrow',cls:'urgent'};
    if(d<=30) return{label:`${d} days left`,cls:'urgent'};
    const months=Math.round(d/30.44);
    return{label:fmtDate(a.targetDate),
           cls:d/365.25>2?'relaxed':months>6?'moderate':'soon'};
  }

  /* Some bands name a range or an open end rather than a deadline, and
     counting down to one states something the user never said. "In 5+
     Years" has no cutoff at all — it resolves to +5 years only so it can
     be sorted and bucketed — so rendering it as "5 years left" invents a
     date. These bands show themselves instead. The ones below (This
     Month / This Year / Next Year) do close on a real date, so they keep
     their countdown. */
  if(OPEN_BANDS[a.targetDate]) return{label:OPEN_BANDS[a.targetDate],cls:'relaxed'};

  const now=new Date();
  const target=presetTargetDate(a.targetDate);
  if(!target) return{label:a.targetDate,cls:''};
  const diffDays=Math.ceil((target-now)/864e5);
  if(diffDays<0) return{label:'Overdue',cls:'overdue'};
  const diffMonths=Math.round(diffDays/30.44);
  const diffYears=diffDays/365.25;
  /* Units are spelled out. "5 mos left" saves a few pixels and costs
     more than it saves — abbreviations in a glanceable list make the
     reader decode rather than read. The layouts that show these give
     the label a fixed slot and truncate around it instead. */
  if(diffYears>2){const y=Math.round(diffYears);return{label:`${y} year${y!==1?'s':''} left`,cls:'relaxed'};}
  if(diffDays>=30) return{label:`${diffMonths} month${diffMonths!==1?'s':''} left`,cls:diffMonths>6?'moderate':'soon'};
  return{label:`${diffDays} day${diffDays!==1?'s':''} left`,cls:'urgent'};
}

/* Sort key for "Up Next": lower is more urgent. Mirrors the classes
   dateInfo() hands out, so the ordering always matches the badges. */
const TARGET_RANK={overdue:0,urgent:1,soon:2,moderate:3,relaxed:4,forever:5,'':6,done:9};
function targetRank(a){
  if(a.completed)return 9;
  const cls=dateInfo(a).cls;
  return TARGET_RANK[cls]!==undefined?TARGET_RANK[cls]:6;
}

/* Sort key for priority: lower is more important. Anything unset counts
   as medium, matching the column default. */
const PRIORITY_RANK={high:0,medium:1,low:2};
function priorityRank(a){
  const p=PRIORITY_RANK[a.priority];
  return p!==undefined?p:1;
}

/* ==============================================================
   SHOWING PRIORITY

   All three levels get the *same* treatment — a rail at the leading
   edge of the row and a capsule in the meta line — and differ only by
   hue:

     high    terracotta        --tint
     medium  saturated purple  --violet
     low     blue-teal         --slate

   They are three steps of one scale, so they have to look like it.
   Marking only some of them, or giving each a different shape, read as
   three unrelated things rather than a ranking.

   The lower two are separated on chroma as well as hue. They were a
   muted violet and a muted slate, which at capsule size read as the
   same colour twice — see the palette note in base.css.

   None of the three is red. Red is the deadline badge that sits beside
   them: an overdue activity and an important one are different claims
   on your attention, and sharing a colour made them argue.

   Completed activities show no priority at all — it is about what to
   do next, and a finished thing has no next.
   ============================================================== */
function priClass(a){
  if(a.completed)return '';
  const p=a.priority||'medium';
  return PRIORITY_RANK[p]!==undefined?' pri-'+p:' pri-medium';
}

function priTagHTML(a){
  if(a.completed)return '';
  const p=a.priority||'medium';
  const k=PRIORITY_RANK[p]!==undefined?p:'medium';
  return `<span class="tag tag-${k}">${cap(k)}</span>`;
}

/* Nudge an invalid field. Uses a transform animation rather than a
   colour change so it reads the same in light and dark. */
function shakeEl(el){
  el.style.animation='shake .38s ease';
  setTimeout(()=>{el.style.animation='';},420);
}

/* Downscale an image data-URL to at most maxD px, then re-encode as JPEG. */
function compress(url,maxD,q,cb){
  const img=new Image();
  img.onload=()=>{
    let{width:w,height:h}=img;
    if(w>maxD||h>maxD){const r=Math.min(maxD/w,maxD/h);w*=r;h*=r;}
    const c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    cb(c.toDataURL('image/jpeg',q));
  };
  img.src=url;
}

/* A short burst when something is accomplished. Deliberately brief —
   it should not get in the way of ticking off several in a row. */
function confetti(){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const c=$('confetti');
  /* Palette colours, read live so the burst matches light/dark mode.
     These were left over as iOS system blues/greens and clashed badly
     with the warm ground. */
  const cs=getComputedStyle(document.documentElement);
  const cols=['--green','--tint','--orange','--sand','--purple']
    .map(v=>cs.getPropertyValue(v).trim()).filter(Boolean);
  if(!cols.length) cols.push('#9c5a2e');
  for(let i=0;i<44;i++){
    const p=document.createElement('div');
    const sz=Math.random()*7+4;
    p.style.cssText=`position:absolute;width:${sz}px;height:${sz*(Math.random()+.6)}px;`+
      `background:${cols[~~(Math.random()*cols.length)]};left:${Math.random()*100}%;top:-18px;`+
      `border-radius:${['50%','1px','2px'][~~(Math.random()*3)]};`+
      `animation:confettiFall ${Math.random()*1.4+1.1}s cubic-bezier(.3,.6,.6,1) forwards;`+
      `animation-delay:${Math.random()*.22}s`;
    c.appendChild(p);
  }
  setTimeout(()=>{c.innerHTML='';},3000);
}
