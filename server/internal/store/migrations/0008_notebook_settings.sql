-- Appearance settings for a collegebook: ruling, margin rule, paper and text.
-- Per book rather than per page, because a notebook is ruled or plain and is
-- not ruled on page six.

-- TEXT holding JSON, and nullable. NULL is "no settings", which is what every
-- notebook that already exists has, so this column needs no backfill and no
-- default: a reader that finds NULL uses its own defaults, and a later change
-- to those defaults then reaches every book that never set anything.
--
-- No CHECK and no shape. The server stores these bytes and hands them back
-- without reading them, for the reason notebooks.kind has no CHECK: a client
-- from a future version will send keys this server has never heard of, and
-- anything that rejected or rewrote them would break that client's sync
-- rather than degrade it. The only rules are enforced in Go, where they can
-- produce a 400 that names the row: valid JSON, and under a size cap.
ALTER TABLE notebooks ADD COLUMN settings TEXT;
