-- ============================================================
-- target-rollover.sql — resolve stored target bands to real dates
--
-- RUN ONCE. Safe to re-run: it only touches rows still holding one of
-- the four resolving bands, and after a run there are none left.
--
-- WHY
-- `Activities.target_date` is a text column holding either a preset
-- band ("This Year") or an ISO date. A band is a *relative* label in an
-- *absolute* field, so it decays: "Next Year" chosen in 2026 means
-- 2027, but in 2027 the client resolved it again and read it as 2028 —
-- silently moving a deadline the user set once.
--
-- The client now resolves a band to a date at save time
-- (resolveTargetDate() in js/utils.js) and targetBand() derives the
-- label back from that date, so a row stored as 2027-12-31 *becomes*
-- "This year" the moment 2027 begins. No scheduled job, nothing to
-- miss. This file does the same to the rows written before that.
--
-- "In 5+ Years" is deliberately left alone. It names no deadline at all
-- and stays a literal string forever — see OPEN_BANDS in js/utils.js.
-- "Before I Die" and '' are retired values and are also left alone;
-- the client still renders both.
--
-- WHICH "NOW"
-- Bands resolve from **today**, not from each row's created_at. That is
-- the deliberate choice: resolving from today writes exactly the date
-- the app is already showing for these rows, so nothing on screen
-- changes and the new rolling behaviour simply starts here. Resolving
-- from created_at is the other honest reading — a 2024 "This Year" goal
-- really is overdue — but it would move a large number of rows into
-- Overdue at once, for a deadline the user never actually saw pass.
-- Swap `now()` for `a.created_at` below if you want that instead.
-- ============================================================

begin;

-- What is about to change, per band. Read this before committing.
select target_date, count(*)
from "Activities"
where target_date in ('This Month','This Year','Next Year','In 2-3 Years')
group by target_date
order by target_date;

update "Activities" a
set target_date = to_char(
  case target_date
    -- last day of this month
    when 'This Month'   then (date_trunc('month', now()) + interval '1 month - 1 day')
    when 'This Year'    then (date_trunc('year',  now()) + interval '1 year  - 1 day')
    when 'Next Year'    then (date_trunc('year',  now()) + interval '2 years - 1 day')
    -- the far edge of the range, matching presetTargetDate()
    when 'In 2-3 Years' then (date_trunc('year',  now()) + interval '4 years - 1 day')
  end, 'YYYY-MM-DD')
where target_date in ('This Month','This Year','Next Year','In 2-3 Years');

commit;

-- Verify: only the values that are meant to survive should remain.
-- select distinct target_date from "Activities"
--   where target_date is not null and target_date !~ '^\d{4}-\d{2}-\d{2}$';
