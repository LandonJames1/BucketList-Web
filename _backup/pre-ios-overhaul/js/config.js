/* ==============================================================
   CONFIG — Supabase client + default cover images
   Loaded first. Everything else assumes `sb` already exists.
   ============================================================== */

const SUPABASE_URL='https://xxdmendegyxlkikejvps.supabase.co';
const SUPABASE_KEY='sb_publishable_45ETmiEMgvWn3QAd58ck5Q_opy0TWnX';
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_KEY);

/* Default cover images */
const COVERS=[
  'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1600&q=90',
  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=1600&q=90',
  'https://images.unsplash.com/photo-1612278675615-7b093b07772d?w=1600&q=90',
  'https://images.unsplash.com/photo-1505832018823-50331d70d237?w=1600&q=90',
  'https://images.unsplash.com/photo-1498307833015-e7b400441eb8?w=1600&q=90',
  'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=1600&q=90',
  'https://images.unsplash.com/photo-1519451241324-20b4ea2c4220?w=1600&q=90',
  'https://images.unsplash.com/photo-1461237439866-5a557710c921?w=1600&q=90',
  'https://images.unsplash.com/photo-1483729558449-99ef09a8c325?w=1600&q=90',
  'https://images.unsplash.com/photo-1528164344705-47542687000d?w=1600&q=90',
];
let usedCovers=[];
function randCover(existingCovers){
  /* Pick a cover not already used by the user's other collections.
     existingCovers = array of cover URLs already in use.
     Falls back to cycling through COVERS once all 9 are used. */
  const inUse=existingCovers||usedCovers;
  const available=COVERS.filter(c=>!inUse.includes(c));
  if(available.length) return available[Math.floor(Math.random()*available.length)];
  return COVERS[Math.floor(Math.random()*COVERS.length)];
}
