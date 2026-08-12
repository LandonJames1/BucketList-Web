/* ==============================================================
   UTILS — small helpers used everywhere
   DOM lookup, HTML escaping, date formatting/urgency, image
   compression, and the confetti celebration.
   ============================================================== */

const $=id=>document.getElementById(id);

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function fmtDate(s){return new Date(s+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}
function dateInfo(a){
  if(a.completed) return{label:a.completedDate?fmtDate(a.completedDate):'Done',cls:'time-done'};
  if(!a.targetDate) return{label:'',cls:''};
  if(a.targetDate==='Before I Die') return{label:'∞ Lifetime',cls:'time-forever'};
  const now=new Date();
  let target;
  switch(a.targetDate){
    case 'This Month': target=new Date(now.getFullYear(),now.getMonth()+1,0); break;
    case 'This Year': target=new Date(now.getFullYear(),11,31); break;
    case 'Next Year': target=new Date(now.getFullYear()+1,11,31); break;
    case 'In 2-3 Years': target=new Date(now.getFullYear()+3,11,31); break;
    case 'In 5+ Years': target=new Date(now.getFullYear()+5,11,31); break;
    default: return{label:a.targetDate,cls:''};
  }
  const diffMs=target-now;
  const diffDays=Math.ceil(diffMs/(864e5));
  if(diffDays<0) return{label:'Overdue',cls:'time-overdue'};
  const diffMonths=Math.round(diffDays/30.44);
  const diffYears=diffDays/365.25;
  if(diffYears>2){
    const y=Math.round(diffYears);
    return{label:`~${y} yr${y!==1?'s':''}`,cls:'time-relaxed'};
  }
  if(diffDays>=30){
    const cls=diffMonths>6?'time-moderate':'time-soon';
    return{label:`${diffMonths} mo${diffMonths!==1?'s':''}`,cls};
  }
  return{label:`${diffDays} day${diffDays!==1?'s':''}`,cls:'time-urgent'};
}
function shakeEl(el){el.style.borderColor='var(--danger)';el.style.animation='shake .4s ease';setTimeout(()=>{el.style.borderColor='';el.style.animation='';},600);}

/* Downscale an image data-URL to at most maxD px, then re-encode as JPEG. */
function compress(url,maxD,q,cb){
  const img=new Image();
  img.onload=()=>{
    let{width:w,height:h}=img;
    if(w>maxD||h>maxD){const r=Math.min(maxD/w,maxD/h);w*=r;h*=r;}
    const c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    cb(c.toDataURL('image/jpeg',q));
  };img.src=url;
}

function confetti(){
  const c=$('confC');
  const cols=['#626b52','#b8714e','#c4b69c','#1a1a18','#ddd9d0','#8a877e'];
  for(let i=0;i<80;i++){
    const p=document.createElement('div');
    const sz=Math.random()*8+4;
    p.style.cssText=`position:absolute;width:${sz}px;height:${sz*(Math.random()+.5)}px;background:${cols[~~(Math.random()*cols.length)]};left:${Math.random()*100}%;top:-20px;border-radius:${['50%','1px','0'][~~(Math.random()*3)]};animation:confettiFall ${Math.random()*2.5+1.5}s var(--ease) forwards;animation-delay:${Math.random()*.3}s`;
    c.appendChild(p);
  }
  setTimeout(()=>{c.innerHTML='';},5000);
}
