/* ==============================================================
   STATE — mutable globals shared across the whole app.
   Which screen is showing, which collection/activity is open, the
   active filters and view mode, and handles to the live maps.
   ============================================================== */

/* The signed-in Supabase user, or null when signed out. */
let currentUser=null;

/* ---- Navigation ----
   curTab is which of the four tab bar destinations is selected.
   curPage is the screen actually on show, which may be a screen
   pushed on top of a tab (currently only 'detail', inside 'lists').
   Pushed screens remember where they came from so Back can return. */
let curTab='home',curPage='home',backTab='lists';

let curListId=null,editingListId=null,editingActId=null;
/* upMedia is the working list of {type,url,poster} entries for whichever
   sheet is open — see js/media.js. It was upPhotos, an array of base64
   data URLs, before photos moved into Supabase Storage and video existed
   at all. */
let curFilter='all',curView='list',upMedia=[],coverPhoto='';
let globalMapFilter='all',globalMapObj=null,globalMapHomeBounds=null;
let detMapHomeBounds=null;

/* Cached display name for the Me tab, read once from the Users table. */
let userProfile=null;
