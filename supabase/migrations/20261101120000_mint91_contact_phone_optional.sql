-- MINT-91 U8 (Sowmya, Nov 1, 2026, Addendum 9): "required phone" becomes an
-- advisory. A contact saves with its office phone blank; the gap is recorded
-- as a backend advisory once the bypassed-checks store (MINT-134) lands, and
-- this migration records nothing itself. Which number is allowed does not
-- change here: the app still refuses a non-US or malformed phone (A3), and the
-- database never checked the format.
--
-- Two functions raised on a blank phone, and both are redefined without that
-- one check. Everything else in them is unchanged.
--
-- 1. public.assert_contact_valid(jsonb, text), the contact check that
--    create_organization (customer contact and sales rep) and submit_capture
--    (the one-time capture link) call. It drops
--      IF btrim(coalesce(p->>'phone_office', '')) = '' THEN RAISE ...
--    and still requires name, a valid email, street address, city, state and
--    postal code. Copied from 20260709130000_create_organization_rpc_v3_contacts.sql,
--    its only definition.
--
-- 2. public.submit_inbound_lead(jsonb), the public /contact form. It drops
--      IF btrim(coalesce(p_payload->>'contact_phone', '')) = '' THEN RAISE 'Phone is required'
--    and still requires the organization name, your name and a valid email,
--    with the same throttle and honeypot. Copied from
--    20260710130000_public_rpc_rate_limiting.sql, its latest definition. A lead
--    has no organization, so no advisory can be recorded for it.
--
-- No column changes. parties.phone_office and inbound_leads.contact_phone are
-- nullable text with no CHECK, and every write path already stores a blank
-- phone as NULL (nullif(btrim(...), '')), which is how existing rows store "no
-- phone".
--
-- Not changed: validate_capture_token still lists phone_office in its
-- `required_fields` reply. The app never reads that list, and the function is
-- the capture-boundary repair (20260923214607) that
-- scripts/security/verify-capture-boundary.mjs replays, so it stays as is.
--
-- CREATE OR REPLACE keeps each function's owner and grants; the grants are
-- restated anyway, as 20260710120000_stage0_grant_hardening.sql set them.
-- Idempotent. Repo-only until an operator applies it, staging first.

CREATE OR REPLACE FUNCTION public.assert_contact_valid(p jsonb, p_label text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_email text := btrim(coalesce(p->>'email', ''));
  v_email_re constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
BEGIN
  IF p IS NULL THEN RAISE EXCEPTION '% is required', p_label; END IF;
  IF btrim(coalesce(p->>'name', '')) = '' THEN RAISE EXCEPTION '% name is required', p_label; END IF;
  IF v_email = '' THEN RAISE EXCEPTION '% email is required', p_label; END IF;
  IF v_email !~ v_email_re THEN RAISE EXCEPTION '% email is not valid', p_label; END IF;
  -- MINT-91 U8: the office phone is optional; no phone check here.
  IF btrim(coalesce(p->>'address_line1', '')) = '' THEN RAISE EXCEPTION '% street address is required', p_label; END IF;
  IF btrim(coalesce(p->>'city', '')) = '' THEN RAISE EXCEPTION '% city is required', p_label; END IF;
  IF btrim(coalesce(p->>'state', '')) = '' THEN RAISE EXCEPTION '% state is required', p_label; END IF;
  IF btrim(coalesce(p->>'postal_code', '')) = '' THEN RAISE EXCEPTION '% postal code is required', p_label; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_contact_valid(jsonb, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.assert_contact_valid(jsonb, text) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_inbound_lead(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_email text := btrim(coalesce(p_payload->>'contact_email', ''));
  v_email_re constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
BEGIN
  -- Rate-limit: 5 total attempts per 60 min per source IP (all attempts,
  -- not just failed -- this is a submission cap, not a validation cap).
  -- Throttled response = fake success (same as honeypot -- no oracle).
  IF NOT public.check_rpc_throttle('submit_inbound_lead', 5, 60, true) THEN
    RETURN jsonb_build_object('ok', true);
  END IF;

  -- Honeypot: real users never populate this hidden field; bots do. Silently
  -- pretend success so a bot gets no signal, but insert nothing.
  IF btrim(coalesce(p_payload->>'company_website', '')) <> '' THEN
    RETURN jsonb_build_object('ok', true);
  END IF;

  IF btrim(coalesce(p_payload->>'org_name', '')) = '' THEN
    RAISE EXCEPTION 'Organization name is required';
  END IF;
  IF btrim(coalesce(p_payload->>'contact_name', '')) = '' THEN
    RAISE EXCEPTION 'Your name is required';
  END IF;
  IF v_email = '' THEN
    RAISE EXCEPTION 'Email is required';
  END IF;
  IF v_email !~ v_email_re THEN
    RAISE EXCEPTION 'Email is not valid';
  END IF;
  -- MINT-91 U8: the phone is optional; a blank one is stored as NULL.

  INSERT INTO public.inbound_leads (
    org_name, contact_name, contact_email, contact_phone,
    address_line1, address_line2, city, state, postal_code, country, status
  ) VALUES (
    btrim(p_payload->>'org_name'),
    btrim(p_payload->>'contact_name'),
    v_email,
    nullif(btrim(coalesce(p_payload->>'contact_phone', '')), ''),
    nullif(btrim(coalesce(p_payload->>'address_line1', '')), ''),
    nullif(btrim(coalesce(p_payload->>'address_line2', '')), ''),
    nullif(btrim(coalesce(p_payload->>'city', '')), ''),
    nullif(btrim(coalesce(p_payload->>'state', '')), ''),
    nullif(btrim(coalesce(p_payload->>'postal_code', '')), ''),
    nullif(btrim(coalesce(p_payload->>'country', '')), ''),
    'new'
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_inbound_lead(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_inbound_lead(jsonb) TO anon, authenticated;
