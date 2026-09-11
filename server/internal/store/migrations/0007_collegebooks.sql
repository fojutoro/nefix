-- A collegebook is a notebook with kind = 'collegebook', and a page is a note
-- with a page_order. No new table and no new sync type: the two objects are
-- nearly the same thing in the data, and that is the point.

-- No CHECK. A client from a future version may send a kind this server has
-- never heard of, and a constraint here would answer that with a 500 and stop
-- its sync outright. The allowed set is validated in Go instead, where it can
-- produce a 400 that names the row and the bad value.
ALTER TABLE notebooks ADD COLUMN kind TEXT NOT NULL DEFAULT 'notes';

-- REAL, not INTEGER. Inserting a page between two others is then the midpoint
-- of their two orders, which touches one row; with integers it would be a
-- renumbering of every page after it. NULL is a note that is not a page.
ALTER TABLE notes ADD COLUMN page_order REAL;
