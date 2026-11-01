-- MINT-96 (Sowmya, Nov 1, B9) — a facility assignment may be saved without a
-- start date. Under the "no default" Add Provider setting, a blank Start date
-- saves the provider and its facility assignments as an accurate draft: the
-- record reads "Start date needed" until a date is entered (Billing
-- Readiness reads it as billable under #558, Addendum 11 D14). A missing start date is not a
-- hard-block rule, so the E1.4 floor (20260712150000, NOT VALID, so legacy
-- rows were already null) goes. Readers already handle a null: roster and
-- report SQL count it as current, billing readiness handles it, and payer-form tokens
-- resolve it to empty.
ALTER TABLE public.provider_facility_assignments
  DROP CONSTRAINT IF EXISTS provider_facility_assignments_start_date_check;
