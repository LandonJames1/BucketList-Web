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
/* Which conversation the conversation screen is showing. Kept beside
   curListId because it IS a collection id — a conversation belongs to
   a shared list rather than existing in its own right. See
   js/messages.js. */
let curConvId=null;
/* upMedia is the working list of {type,url,poster} entries for whichever
   sheet is open — see js/media.js. It was upPhotos, an array of base64
   data URLs, before photos moved into Supabase Storage and video existed
   at all. */
/* curSort is the order the collection screen lists its activities in —
   a key into ACT_SORTS (utils.js). It persists for the session rather
   than resetting on entry, the way curFilter does and unlike curView:
   filter and sort sit on the same control row, and having one of the
   two forget itself between visits reads as a bug. */
let curFilter='all',curSort='added',curView='list',upMedia=[],coverPhoto='';
let globalMapFilter='all',globalMapObj=null,globalMapHomeBounds=null;
let detMapHomeBounds=null;

/* Cached display name for the Me tab, read once from the Users table. */
let userProfile=null;

/* An invite code for a shared list, read from ?join= at boot and held
   because the link can be opened while signed out, and the sign-in
   screen must not swallow it. Cleared by
   handlePendingJoin() once there is a user to join as.
   See js/sharing.js. */
let pendingJoin=null;
