/* ==============================================================
   BOOT — restore the Supabase session, then show app or auth screen
   Loaded LAST: every function it touches is already defined.
   ============================================================== */

(async()=>{
  const{data:{session}}=await sb.auth.getSession();
  if(session?.user){
    currentUser=session.user;
    showApp();
  } else {
    showAuth();
  }
})();
