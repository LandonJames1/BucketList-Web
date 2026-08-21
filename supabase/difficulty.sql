-- HOW HARD IS IT?
--
-- One text column on Activities holding 'easy' | 'medium' | 'hard', or
-- null for anything written before this / anything the model declined
-- to judge.
--
-- Nothing in the app writes it by hand: it is inferred from the
-- activity's name at capture time, by the same `unfurl` call that
-- already guesses a location, using the user's Home address as the
-- yardstick for distance. See GUESSING HOW HARD IT IS in CLAUDE.md.
--
-- Optional, like every other migration here. Without it js/api.js's
-- probeDifficulty() answers false, the column is never sent, and the
-- app behaves exactly as it did before.

alter table "Activities"
  add column if not exists difficulty text;

-- The three tiers and nothing else. Null stays legal: it is what an
-- un-judged row looks like, and there are a lot of them.
alter table "Activities"
  drop constraint if exists activities_difficulty_check;
alter table "Activities"
  add constraint activities_difficulty_check
  check (difficulty is null or difficulty in ('easy','medium','hard'));
