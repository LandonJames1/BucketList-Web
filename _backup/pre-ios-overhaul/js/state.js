/* ==============================================================
   STATE — mutable globals shared across the whole app
   Which page is showing, which collection/activity is open, the
   active filters and view mode, and handles to the live maps.
   ============================================================== */

/* The signed-in Supabase user, or null when signed out. */
let currentUser=null;

let curPage='home',curListId=null,editingListId=null,editingActId=null;
let completingId=null,curFilter='all',curView='list',upPhotos=[],coverPhoto='';
let globalMapFilter='all',globalMapObj=null,globalMapHomeBounds=null,globalMapClusters=null,globalMapAllMarkers=[];
let detMapHomeBounds=null;
