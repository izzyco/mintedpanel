-- Leave blank: a fourth field-map decision.
--
-- Today a reviewed field is one of token / hardcoded / manual. An admin who
-- has looked at a payer field and concluded it should stay EMPTY has had no
-- way to say so: a fixed "N/A" breaks portal validation, and "Human fills
-- this" (source 'manual') puts the field on the specialist's post-fill
-- checklist and distorts completion counts. `source = 'leave_blank'` with
-- `status = 'approved'` is that decision. No new column; the row carries no
-- token, no literal and no transform, and nothing fills it.
--
-- Additive: the CHECK is widened (drop + re-add with one more member) and the
-- 7-argument `train_global_field_map` core is re-issued with the same
-- signature so the shared-tier trainer accepts the value. The 8-argument
-- generation-guard wrapper (`20261006150000` / `20261007120000`) delegates to
-- this core and is untouched. Org rows write through
-- `update_org_portal_field_map`, which validates no source of its own — the
-- CHECK is the only gate there.
--
-- Wire contract: the extension mirrors the value in `src/shared/apiTypes.ts`
-- (`PortalFieldMapSource` adds "leave_blank") in a coordinated change.

ALTER TABLE public.portal_field_maps
  DROP CONSTRAINT IF EXISTS portal_field_maps_source_check;

ALTER TABLE public.portal_field_maps
  ADD CONSTRAINT portal_field_maps_source_check
  CHECK (source = ANY (ARRAY['token'::text, 'manual'::text, 'manual_partial'::text, 'hardcoded'::text, 'leave_blank'::text]));

CREATE OR REPLACE FUNCTION public.train_global_field_map(
  p_id uuid,
  p_status text,
  p_source text,
  p_token text DEFAULT NULL,
  p_field_label text DEFAULT NULL,
  p_hardcoded_value text DEFAULT NULL,
  p_transform text DEFAULT NULL
)
RETURNS public.portal_field_maps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.portal_field_maps%ROWTYPE;
  v_token text := nullif(btrim(coalesce(p_token, '')), '');
  v_literal text := nullif(btrim(coalesce(p_hardcoded_value, '')), '');
  v_transform text := nullif(btrim(coalesce(p_transform, '')), '');
BEGIN
  IF app_authz.is_restricted_external() THEN
    RAISE EXCEPTION 'Restricted client cannot modify global training surfaces';
  END IF;
  IF coalesce(auth.role(), '') = 'anon' THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('proposed', 'approved') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('token', 'manual', 'manual_partial', 'hardcoded', 'leave_blank') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;
  IF p_source IN ('token', 'manual_partial') AND v_token IS NULL THEN
    RAISE EXCEPTION 'Token is required for source %', p_source;
  END IF;
  IF p_source = 'hardcoded' THEN
    IF v_literal IS NULL THEN
      RAISE EXCEPTION 'A fixed value cannot be empty';
    END IF;
    v_token := NULL;
  ELSE
    v_literal := NULL;
  END IF;
  -- A human-filled or deliberately blank field carries no token: nothing
  -- resolves into it.
  IF p_source IN ('manual', 'leave_blank') THEN
    v_token := NULL;
  END IF;
  -- Shaping only applies to a token fill. A fixed value is already the
  -- literal that will be sent.
  IF p_source IN ('token', 'manual_partial') THEN
    IF v_transform IS NOT NULL AND v_transform NOT IN (
      'state_abbrev',
      'date_mmddyyyy',
      'date_mmddyyyy_dash',
      'date_ddmmyyyy',
      'date_ddmmyyyy_dash',
      'date_yyyymmdd_slash',
      'date_yyyymmdd',
      'zip5',
      'phone_digits',
      'phone_dashed',
      'phone_country_dashed',
      'phone_e164',
      'tin_digits',
      'tin_dashed'
    ) THEN
      RAISE EXCEPTION 'Invalid transform %', v_transform;
    END IF;
  ELSE
    v_transform := NULL;
  END IF;

  SELECT * INTO v_row FROM public.portal_field_maps
   WHERE id = p_id AND org_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Field map not found';
  END IF;

  UPDATE public.portal_field_maps
     SET status = p_status,
         source = p_source,
         token = v_token,
         hardcoded_value = v_literal,
         transform = v_transform,
         notes = CASE WHEN p_source IN ('manual', 'manual_partial')
                      THEN coalesce(notes, 'Marked manual in the form editor')
                      ELSE notes END,
         field_label = coalesce(nullif(btrim(coalesce(p_field_label, '')), ''), field_label)
   WHERE id = p_id AND org_id IS NULL
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.train_global_field_map(uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.train_global_field_map(uuid, text, text, text, text, text, text) TO authenticated, service_role;
