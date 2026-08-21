/* ==============================================================
   difficulty-profile.sql — teaching the rating what "hard" means
   for THIS person.

   One column. A short paragraph the user writes about themselves —
   "no car, tight budget, hikes most weekends, terrified of flying" —
   passed to the unfurl function alongside their Home address, so the
   easy/medium/hard call is made against their life rather than an
   average one.

   It pairs with the other half of the same idea, which needs no
   migration at all: the few-shot examples js/location.js pulls out of
   the activities they already have, balanced across the three tiers.
   The paragraph says WHY, the examples show WHAT. See
   "Rating for one person, not an average one" in CLAUDE.md.

   Optional, like every other migration here. Without it the column
   read fails once, is noted in the console, and the rating carries on
   with Home and the examples alone.

   Run it in the Supabase SQL editor.
   ============================================================== */

alter table "Users" add column if not exists difficulty_profile text;
