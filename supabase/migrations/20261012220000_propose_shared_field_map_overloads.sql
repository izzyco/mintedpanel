-- Fix propose_shared_field_map overloads for xlsx support without signature ambiguity or signature drift.
-- 1. Drop the 11-argument function with default parameter that was introduced with ambiguous default values.
DROP FUNCTION IF EXISTS public.propose_shared_field_map(text, text, text, text, text, text, integer, text, jsonb, text, integer);

-- 2. Recreate the 10-argument overload supporting web, pdf, and xlsx with exact e612 behavior.
CREATE OR REPLACE FUNCTION public.propose_shared_field_map(
  p_portal_key text,
  p_selector text,
  p_field_label text DEFAULT NULL,
  p_form_section text DEFAULT NULL,
  p_page_step text DEFAULT NULL,
  p_field_type text DEFAULT 'text',
  p_sort_order integer DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_control_options jsonb DEFAULT NULL,
  p_map_type text DEFAULT 'web'
)
RETURNS public.portal_field_maps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := lower(btrim(coalesce(p_portal_key, '')));
  v_selector text := btrim(coalesce(p_selector, ''));
  v_type text := coalesce(nullif(btrim(coalesce(p_field_type, '')), ''), 'text');
  v_map_type text := coalesce(nullif(btrim(lower(coalesce(p_map_type, ''))), ''), 'web');
  v_row public.portal_field_maps%ROWTYPE;
  v_options jsonb := NULL;
  v_family_text text;
  v_family_id uuid;
BEGIN
  IF app_authz.is_restricted_external() THEN
    RAISE EXCEPTION 'Restricted client cannot modify global training surfaces';
  END IF;
  IF coalesce(auth.role(), '') = 'anon' THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_key = '' THEN
    RAISE EXCEPTION 'portal_key is required';
  END IF;
  IF v_selector = '' THEN
    RAISE EXCEPTION 'selector is required';
  END IF;
  IF v_type NOT IN ('text', 'select', 'radio', 'checkbox', 'date', 'file') THEN
    RAISE EXCEPTION 'Invalid field_type %', v_type;
  END IF;
  IF v_map_type NOT IN ('web', 'pdf', 'xlsx') THEN
    RAISE EXCEPTION 'Invalid map_type %', v_map_type;
  END IF;

  IF v_map_type IN ('pdf', 'xlsx') THEN
    IF v_key !~ '^payer-form:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'portal_configuration_not_found';
    END IF;
    v_family_text := substr(v_key, length('payer-form:') + 1);
    v_family_id := v_family_text::uuid;
    PERFORM 1 FROM public.payer_forms
     WHERE family_id = v_family_id AND retired_at IS NULL
     ORDER BY version DESC
     LIMIT 1
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'payer_form_configuration_not_found';
    END IF;
  END IF;

  IF p_control_options IS NOT NULL THEN
    IF jsonb_typeof(p_control_options) <> 'array' THEN
      RAISE EXCEPTION 'control_options must be a json array';
    END IF;
    IF jsonb_array_length(p_control_options) > 0 THEN
      v_options := p_control_options;
    END IF;
  END IF;

  INSERT INTO public.portal_field_maps (
    org_id, portal_key, selector, field_label, form_section, page_step,
    field_type, map_type, status, source, notes, token, sort_order,
    control_options
  )
  VALUES (
    NULL, v_key, v_selector,
    nullif(btrim(coalesce(p_field_label, '')), ''),
    nullif(btrim(coalesce(p_form_section, '')), ''),
    nullif(btrim(coalesce(p_page_step, '')), ''),
    v_type, v_map_type, 'proposed', 'manual',
    coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Captured for the shared form library'),
    NULL, p_sort_order,
    v_options
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_row
    FROM public.portal_field_maps
   WHERE org_id IS NULL AND portal_key = v_key AND selector = v_selector
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not resolve the shared field map after insert';
  END IF;

  UPDATE public.portal_field_maps
     SET field_label = coalesce(nullif(btrim(coalesce(p_field_label, '')), ''), field_label),
         form_section = coalesce(nullif(btrim(coalesce(p_form_section, '')), ''), form_section),
         page_step = coalesce(nullif(btrim(coalesce(p_page_step, '')), ''), page_step),
         sort_order = CASE
                        WHEN p_sort_order IS NOT NULL THEN p_sort_order
                        ELSE sort_order
                      END,
         control_options = CASE
                             WHEN v_options IS NOT NULL THEN v_options
                             ELSE control_options
                           END,
         updated_at = now()
   WHERE id = v_row.id AND org_id IS NULL
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- 3. Recreate the 11-argument overload without defaults so that 10-argument invocations never collide in PostgREST.
CREATE OR REPLACE FUNCTION public.propose_shared_field_map(
  p_portal_key text,
  p_selector text,
  p_field_label text,
  p_form_section text,
  p_page_step text,
  p_field_type text,
  p_sort_order integer,
  p_notes text,
  p_control_options jsonb,
  p_map_type text,
  p_expected_mapping_generation integer
)
RETURNS public.portal_field_maps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.portal_field_maps%ROWTYPE;
  v_portal public.portals%ROWTYPE;
  v_generation integer;
  v_key text := lower(btrim(coalesce(p_portal_key, '')));
  v_family_text text;
  v_family_id uuid;
BEGIN
  IF p_map_type IN ('pdf', 'xlsx') THEN
    IF v_key !~ '^payer-form:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'portal_configuration_not_found';
    END IF;
    IF p_expected_mapping_generation IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'mapping_generation_token_required';
    ELSIF p_expected_mapping_generation <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'mapping_generation_stale';
    END IF;
    v_family_text := substr(v_key, length('payer-form:') + 1);
    v_family_id := v_family_text::uuid;
    PERFORM 1 FROM public.payer_forms
     WHERE family_id = v_family_id AND retired_at IS NULL
     ORDER BY version DESC
     LIMIT 1
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'payer_form_configuration_not_found';
    END IF;
    v_generation := 1;
  ELSE
    IF v_key = '' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'portal_key_required';
    END IF;
    SELECT * INTO v_portal
      FROM public.portals
     WHERE org_id IS NULL AND portal_key = v_key
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'portal_configuration_not_found';
    END IF;
    IF p_expected_mapping_generation IS NULL THEN
      IF v_portal.mapping_generation <> 1
         OR v_portal.requires_explicit_selection
         OR v_portal.case_type IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM public.form_mapping_reset_events event
            WHERE event.portal_id = v_portal.id
         ) THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'mapping_generation_token_required';
      END IF;
    ELSIF p_expected_mapping_generation IS DISTINCT FROM v_portal.mapping_generation THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'mapping_generation_stale';
    END IF;
    v_generation := v_portal.mapping_generation;
  END IF;

  SELECT * INTO v_existing FROM public.portal_field_maps
   WHERE org_id IS NULL AND portal_key = lower(btrim(p_portal_key))
     AND selector = btrim(p_selector) AND map_type = coalesce(p_map_type, 'web') FOR UPDATE;
  IF FOUND AND v_existing.mapping_generation IS DISTINCT FROM v_generation THEN
    PERFORM set_config('minted.mapping_recapture_refresh', v_existing.id::text, true);
    UPDATE public.portal_field_maps
       SET mapping_generation = v_generation,
           field_label = nullif(btrim(coalesce(p_field_label, '')), ''),
           form_section = nullif(btrim(coalesce(p_form_section, '')), ''),
           page_step = nullif(btrim(coalesce(p_page_step, '')), ''),
           field_type = coalesce(nullif(p_field_type, ''), 'text'),
           token = NULL, hardcoded_value = NULL, transform = NULL,
           status = 'proposed', source = 'manual',
           notes = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Captured for the shared form library'),
           display_label = NULL, section = NULL, sort_order = NULL,
           control_options = CASE WHEN jsonb_typeof(p_control_options) = 'array'
                                      AND jsonb_array_length(p_control_options) > 0
                                  THEN p_control_options ELSE NULL END,
           updated_at = now()
     WHERE id = v_existing.id
     RETURNING * INTO v_existing;
    RETURN v_existing;
  END IF;
  RETURN public.propose_shared_field_map(
    p_portal_key, p_selector, p_field_label, p_form_section, p_page_step,
    p_field_type, p_sort_order, p_notes, p_control_options, p_map_type
  );
END;
$$;

-- 4. Permissions
REVOKE ALL ON FUNCTION public.propose_shared_field_map(text, text, text, text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_shared_field_map(text, text, text, text, text, text, integer, text, jsonb, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.propose_shared_field_map(text, text, text, text, text, text, integer, text, jsonb, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_shared_field_map(text, text, text, text, text, text, integer, text, jsonb, text, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_shared_field_registry(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_shared_field_registry(jsonb) TO authenticated, service_role;
