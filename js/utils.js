/* ==============================================================
   UTILS — small helpers used everywhere.
   DOM lookup, HTML escaping, date formatting and urgency,
   image compression, and the completion confetti.
   ============================================================== */

const $=id=>document.getElementById(id);

function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function todayISO(){return new Date().toISOString().split('T')[0];}

function fmtDate(s){
  const d=new Date(s+'T00:00:00');
  const now=new Date();
  const opts={month:'short',day:'numeric'};
  /* Only spell out the year when it isn't the current one — the way
     iOS date labels do. */
  if(d.getFullYear()!==now.getFullYear()) opts.year='numeric';
  return d.toLocaleDateString('en-US',opts);
}

/* Turn an activity's target date into a short label plus an urgency
   class. Target dates are a fixed set of strings, not real dates. */
function dateInfo(a){
  if(a.completed) return{label:a.completedDate?fmtDate(a.completedDate):'Done',cls:'done'};
  if(!a.targetDate) return{label:'',cls:''};
  if(a.targetDate==='Before I Die') return{label:'Someday',cls:'forever'};
  const now=new Date();
  let target;
  switch(a.targetDate){
    case 'This Month':   target=new Date(now.getFullYear(),now.getMonth()+1,0); break;
    case 'This Year':    target=new Date(now.getFullYear(),11,31); break;
    case 'Next Year':    target=new Date(now.getFullYear()+1,11,31); break;
    case 'In 2-3 Years': target=new Date(now.getFullYear()+3,11,31); break;
    case 'In 5+ Years':  target=new Date(now.getFullYear()+5,11,31); break;
    default: return{label:a.targetDate,cls:''};
  }
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
