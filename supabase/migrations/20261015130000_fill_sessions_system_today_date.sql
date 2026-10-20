-- DYN-TODAY-01 — audit trail for the dynamic `system.today` token.
--
-- `system.today` is resolved on the coordinator's device at fill click, never
-- by the server, so the panel has no other record of WHICH calendar date went
-- into a signature / attestation / submission-date box. The extension (and the
-- panel's own payer-PDF fill) may report it on the fill event
-- (`POST /api/fill-events` body `systemTodayDate`, `YYYY-MM-DD`); this column
-- holds it. A date is not PHI, but it is the one value a fill event carries,
-- so it has its own typed column rather than a key inside a jsonb payload
-- the value-free V2 contract promises never to hold, and it is never logged.
--
-- Additive: nullable, no default, no backfill. Every fill recorded before this
-- column, and every fill that did not write the token, is NULL. The service
-- names the column only when a request carries the value, so a database that
-- predates this migration keeps accepting every other fill event unchanged.
ALTER TABLE public.fill_sessions
  ADD COLUMN IF NOT EXISTS system_today_date date;

COMMENT ON COLUMN public.fill_sessions.system_today_date IS
  'DYN-TODAY-01: the local calendar date the device resolved system.today to for this fill, when the fill wrote that token. Not PHI; never logged.';
