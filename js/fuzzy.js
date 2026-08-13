/* ==============================================================
   FUZZY — approximate string matching.

   Two features need this and they need different things from it, so
   there are two entry points over one set of primitives:

     similarity(a,b)      symmetric, 0..1. "Are these two activities
                          the same thing?" — duplicate detection.
     matchScore(q,text)   asymmetric, 0..1. "Does this row answer what
                          the user is typing?" — global search.

   They are genuinely different problems. Duplicate detection compares
   two finished phrases, so word order and overall overlap matter and
   neither side is privileged. Search compares a fragment against a
   whole phrase, so a prefix ("fush") has to score highly against
   "Fushimi Inari" even though the two are barely similar as strings.
   Using one for the other gives bad results both ways.

   Everything here is pure and synchronous. It runs against the
   in-memory row cache (api.js), never the network — which is what
   lets the duplicate check sit in the middle of the quick-add path
   without slowing it down, and what makes both work offline.
   ============================================================== */

/* ==============================================================
   NORMALISING

   Case, accents and punctuation are noise for both jobs: "Café" and
   "cafe", "Mt. Fuji" and "Mt Fuji" are the same input as far as a
   user is concerned.
   ============================================================== */
function fuzzyNorm(s){
  return (s||'')
    .toLowerCase()
    /* Decompose, then drop the combining marks — é becomes e. The
       range is written as escapes rather than literal combining
       characters, which are invisible in a source file. */
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    /* Apostrophes close up (world's → worlds) so the token survives;
       everything else becomes a space so it acts as a separator. */
    .replace(/['’]/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .trim();
}

/* Words that carry no meaning in an activity name. Kept deliberately
   short: an over-eager stopword list makes unrelated things collide,
   which is worse here than missing a duplicate. */
const FUZZY_STOP=new Set(['a','an','the','and','or','of','to','in','at','on','for','with','from','my','me','i','is','it','go','get']);

/* Verbs an activity name tends to open with. Stripped only when they
   LEAD, so "Visit Fushimi Inari" and "Fushimi Inari" match, while
   "Learn to see" keeps its second verb. */
const FUZZY_LEAD_VERBS=new Set(['visit','see','do','try','eat','ride','walk','hike','climb','swim','watch','attend','explore','experience','check','out','take','make','tour']);

/* Abbreviations common enough in place names to be worth expanding.
   Deliberately tiny — this is not a gazetteer, it is the handful that
   otherwise make "Climb Mt. Fuji" and "Climb Mount Fuji" look like
   different activities. */
const FUZZY_ABBREV={mt:'mount',mtn:'mount',mts:'mount',st:'saint',ft:'fort',pk:'peak',nat:'national',natl:'national'};

function fuzzyTokens(s){
  const raw=fuzzyNorm(s).split(' ').filter(Boolean).map(t=>FUZZY_ABBREV[t]||t);
  let i=0;
  while(i<raw.length&&FUZZY_LEAD_VERBS.has(raw[i])) i++;
  /* Never strip a name down to nothing — "Go see" is all leading verbs
     and still has to compare as itself. */
  const body=i<raw.length?raw.slice(i):raw;
  const kept=body.filter(t=>!FUZZY_STOP.has(t));
  return kept.length?kept:body;
}

/* A crude suffix stripper, not a real stemmer. It exists for one
   case: "skydive" and "skydiving" are the same activity written two
   ways, and no amount of character overlap says so — they differ in
   three of nine characters. Reducing both to "skydiv" does.

   Order matters: the longest suffix has to be tried first, or "ing"
   is never reached because "s" already matched nothing. */
function fuzzyStem(t){
  if(t.length<=4) return t;
  for(const suf of ['ing','ies','ed','es','s','e']){
    if(t.length-suf.length>=3&&t.endsWith(suf)) return t.slice(0,-suf.length);
  }
  return t;
}

/* How alike two single words are. Exact, then stem-equal, then a
   prefix relationship, then edit distance. */
function fuzzyTokenSim(a,b){
  if(a===b) return 1;
  const sa=fuzzyStem(a),sb=fuzzyStem(b);
  if(sa===sb) return .97;
  if(sa.length>=4&&sb.length>=4&&(sa.startsWith(sb)||sb.startsWith(sa))) return .9;
  return fuzzyEditRatio(sa,sb);
}

/* Dice over tokens, but pairing words by how alike they are rather
   than demanding they be identical. Each token on the left claims its
   best unclaimed partner on the right, so a word is never counted
   twice. Below FUZZY_TOKEN_MIN the pair is not a match at all and
   contributes nothing. */
const FUZZY_TOKEN_MIN=.8;

function fuzzySoftDice(ta,tb){
  if(!ta.length||!tb.length) return 0;
  const taken=new Array(tb.length).fill(false);
  let shared=0;
  for(const a of ta){
    let bestI=-1,bestS=0;
    for(let j=0;j<tb.length;j++){
      if(taken[j]) continue;
      const s=fuzzyTokenSim(a,tb[j]);
      if(s>bestS){bestS=s;bestI=j;}
    }
    if(bestS>=FUZZY_TOKEN_MIN){ taken[bestI]=true; shared+=bestS; }
  }
  return 2*shared/(ta.length+tb.length);
}

/* ==============================================================
   PRIMITIVES
   ============================================================== */

/* Character trigrams, padded so the start and end of a string carry
   weight. Catches typos and inflections that token overlap misses:
   "kayaking" vs "kayakking". */
function fuzzyTrigrams(s){
  const p='  '+s+' ';
  const out=new Set();
  for(let i=0;i<p.length-2;i++) out.add(p.slice(i,i+3));
  return out;
}

/* Sørensen–Dice over two sets: 2|A∩B| / (|A|+|B|). Symmetric, and
   more forgiving than Jaccard on sets of unequal size — which is the
   normal case here, since one name is usually longer than the other. */
function fuzzyDice(a,b){
  if(!a.size||!b.size) return 0;
  let shared=0;
  const [small,large]=a.size<b.size?[a,b]:[b,a];
  small.forEach(v=>{ if(large.has(v)) shared++; });
  return 2*shared/(a.size+b.size);
}

/* Levenshtein, capped. Two rows of the matrix rather than the full
   grid, and it gives up past FUZZY_MAX_EDIT_LEN — the cost is
   quadratic and the long strings it would run on are exactly the ones
   trigrams already handle well. */
const FUZZY_MAX_EDIT_LEN=48;

function fuzzyEditRatio(a,b){
  if(a===b) return 1;
  if(!a.length||!b.length) return 0;
  if(a.length>FUZZY_MAX_EDIT_LEN||b.length>FUZZY_MAX_EDIT_LEN) return 0;

  let prev=new Array(b.length+1);
  let cur=new Array(b.length+1);
  for(let j=0;j<=b.length;j++) prev[j]=j;

  for(let i=1;i<=a.length;i++){
    cur[0]=i;
    for(let j=1;j<=b.length;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+cost);
    }
    const swap=prev;prev=cur;cur=swap;
  }
  const dist=prev[b.length];
  return 1-dist/Math.max(a.length,b.length);
}

/* ==============================================================
   SIMILARITY — for duplicate detection

   Blends token overlap with character trigrams, then lets two
   special cases override the blend upward:

     containment  "Fushimi Inari" inside "Visit Fushimi Inari at
                  sunrise" is a duplicate, but the blended score is
                  dragged down by the extra words. Scaled by the
                  length ratio so a short word swallowed by a long
                  unrelated phrase ("Paris" in "Paris Hilton
                  documentary") does not score as one.
     edit ratio   short names where trigrams are too sparse to say
                  much — "Kyoto" vs "Kyotto".

   Token overlap is weighted above trigrams because word-level
   agreement is the better signal for names people write themselves.
   ============================================================== */
function similarity(a,b){
  const na=fuzzyNorm(a),nb=fuzzyNorm(b);
  if(!na||!nb) return 0;
  if(na===nb) return 1;

  const ta=fuzzyTokens(a),tb=fuzzyTokens(b);
  const ja=ta.join(' '),jb=tb.join(' ');
  /* Equal once the leading verb and stopwords are gone. */
  if(ja&&ja===jb) return 1;

  const tokenScore=fuzzySoftDice(ta,tb);
  const gramScore=fuzzyDice(fuzzyTrigrams(na),fuzzyTrigrams(nb));
  let score=.6*tokenScore+.4*gramScore;

  /* Containment, measured on the stopword-stripped forms so the
     filler words in a longer name do not defeat it.

     Scaled hard by the length ratio, and that scaling is the whole
     point. A generous floor here made "Visit Paris" a duplicate of
     "Paris Hilton documentary" — the short name is genuinely inside
     the long one, but it accounts for a fifth of it, and a fifth is
     not a match. Only a containment that covers most of the longer
     name is allowed to carry the score on its own. */
  const [shortS,longS]=ja.length<=jb.length?[ja,jb]:[jb,ja];
  const boundary=longS===shortS||longS.startsWith(shortS+' ')||
                 longS.endsWith(' '+shortS)||longS.includes(' '+shortS+' ');
  if(shortS.length>=4&&boundary){
    score=Math.max(score,.5+.5*(shortS.length/longS.length));
  }

  /* Typo distance, on the full normalised strings. Only allowed to
     raise the score, and only when it is decisive. */
  const edit=fuzzyEditRatio(na,nb);
  if(edit>.82) score=Math.max(score,edit);

  return Math.min(1,score);
}

/* ==============================================================
   MATCH SCORE — for search

   Asymmetric: `q` is a fragment the user is still typing, `text` is
   a whole field. Ordered from most to least confident, and the first
   one that fires wins — a run of `Math.max` over all of them would
   let a weak trigram overlap inflate a strong prefix hit's neighbour
   and flatten the ranking.
   ============================================================== */
function matchScore(q,text){
  const nq=fuzzyNorm(q),nt=fuzzyNorm(text);
  if(!nq||!nt) return 0;
  if(nq===nt) return 1;

  /* Whole-fragment substring. A hit at a word boundary is worth more
     than one in the middle of a word — "ari" matching "Inari" is a
     weaker signal than "ina" doing it. */
  const at=nt.indexOf(nq);
  if(at>=0){
    const boundary=at===0||nt[at-1]===' ';
    const coverage=nq.length/nt.length;
    return Math.min(.99,(boundary?.86:.72)+.13*coverage);
  }

  /* Every query word is the prefix of some word in the text, in any
     order: "fush ina" finds "Fushimi Inari Taisha". */
  const qt=nq.split(' ').filter(Boolean);
  const tt=nt.split(' ').filter(Boolean);
  if(qt.length&&qt.every(w=>tt.some(t=>t.startsWith(w)))){
    const coverage=qt.join('').length/Math.max(1,tt.join('').length);
    return Math.min(.85,.62+.23*coverage);
  }

  /* Typo tolerance against individual words, so one wrong letter in a
     long field still finds it: "kayakking" → "kayaking". */
  let best=0;
  for(const t of tt){
    if(Math.abs(t.length-nq.length)>3) continue;
    const r=fuzzyEditRatio(nq,t);
    if(r>best) best=r;
  }
  if(best>.75) return Math.min(.7,best*.72);

  /* Last resort: character overlap across the whole field. Only
     meaningful once the fragment is long enough to be distinctive. */
  if(nq.length>=4){
    const g=fuzzyDice(fuzzyTrigrams(nq),fuzzyTrigrams(nt));
    if(g>.28) return Math.min(.55,g*.6);
  }
  return 0;
}

/* ==============================================================
   SEARCHING A RECORD

   Weighted across several fields, because the name is what people
   mean nearly all of the time and a stray hit in a long notes field
   should never outrank it. Returns the best weighted field score
   plus a small bonus for matching in more than one place.
   ============================================================== */
function scoreFields(q,fields){
  let best=0,hits=0;
  for(const [text,weight] of fields){
    if(!text) continue;
    const s=matchScore(q,text)*weight;
    if(s>0) hits++;
    if(s>best) best=s;
  }
  if(!best) return 0;
  return Math.min(1,best+(hits>1?.03*(hits-1):0));
}
