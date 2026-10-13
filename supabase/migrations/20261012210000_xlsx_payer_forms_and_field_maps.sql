-- Allow Excel (.xlsx) roster templates alongside PDF forms in payer_forms and portal_field_maps

-- 1. Relax mime_type check on public.payer_forms
ALTER TABLE public.payer_forms
  DROP CONSTRAINT IF EXISTS payer_forms_mime_pdf,
  DROP CONSTRAINT IF EXISTS payer_forms_mime_check;

ALTER TABLE public.payer_forms
  ADD CONSTRAINT payer_forms_mime_check CHECK (
    mime_type IN (
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  );

-- 2. Relax map_type check on public.portal_field_maps
ALTER TABLE public.portal_field_maps
  DROP CONSTRAINT IF EXISTS portal_field_maps_map_type_check;

ALTER TABLE public.portal_field_maps
  ADD CONSTRAINT portal_field_maps_map_type_check CHECK (
    map_type = ANY (ARRAY['web'::text, 'pdf'::text, 'xlsx'::text])
  );

-- 3. Update storage.buckets payer-forms allowed_mime_types if set
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets
       SET allowed_mime_types = ARRAY[
         'application/pdf',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
       ]
     WHERE id = 'payer-forms'
       AND allowed_mime_types IS NOT NULL;
  END IF;
END $$;

-- 4. Update propose_shared_field_map to treat xlsx as a payer-form family
CREATE OR REPLACE FUNCTION public.propose_shared_field_map(
  p_portal_key text,
  p_selector text,
  p_field_label text DEFAULT NULL::text,
  p_form_section text DEFAULT NULL::text,
  p_page_step text DEFAULT NULL::text,
  p_field_type text DEFAULT 'text'::text,
  p_sort_order integer DEFAULT NULL::integer,
  p_notes text DEFAULT 'Captured for the shared form library'::text,
  p_control_options jsonb DEFAULT NULL::jsonb,
  p_map_type text DEFAULT 'web'::text,
  p_expected_mapping_generation integer DEFAULT NULL::integer
)
 RETURNS portal_field_maps
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  INSERT INTO public.portal_field_maps (
    org_id, portal_key, selector, field_label, form_section, page_step,
    field_type, map_type, status, source, notes, token, sort_order,
    control_options, mapping_generation
  )
  VALUES (
    NULL, v_key, btrim(p_selector),
    nullif(btrim(coalesce(p_field_label, '')), ''),
    nullif(btrim(coalesce(p_form_section, '')), ''),
    nullif(btrim(coalesce(p_page_step, '')), ''),
    coalesce(nullif(p_field_type, ''), 'text'),
    coalesce(p_map_type, 'web'), 'proposed', 'manual',
    coalesce(nullif(btrim(coalesce(p_notes, '')), ''), 'Captured for the shared form library'),
    NULL, p_sort_order,
    CASE WHEN jsonb_typeof(p_control_options) = 'array' AND jsonb_array_length(p_control_options) > 0 THEN p_control_options ELSE NULL END,
    v_generation
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_existing
    FROM public.portal_field_maps
   WHERE org_id IS NULL AND portal_key = v_key AND selector = btrim(p_selector) AND map_type = coalesce(p_map_type, 'web')
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not resolve the shared field map after insert';
  END IF;

  UPDATE public.portal_field_maps
     SET field_label = coalesce(nullif(btrim(coalesce(p_field_label, '')), ''), field_label),
         form_section = coalesce(nullif(btrim(coalesce(p_form_section, '')), ''), form_section),
         page_step = coalesce(nullif(btrim(coalesce(p_page_step, '')), ''), page_step),
         sort_order = CASE WHEN p_sort_order IS NOT NULL THEN p_sort_order ELSE sort_order END,
         control_options = CASE WHEN p_control_options IS NOT NULL THEN p_control_options ELSE control_options END,
         updated_at = now()
   WHERE id = v_existing.id
   RETURNING * INTO v_existing;

  RETURN v_existing;
END;
$function$;

-- 5. Update update_shared_field_registry to treat xlsx as a payer-form family
CREATE OR REPLACE FUNCTION public.update_shared_field_registry(p_entries jsonb)
 RETURNS SETOF portal_field_maps
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_entry jsonb;
  v_id uuid;
  v_portal_key text;
  v_map_type text;
  v_expected_generation integer;
  v_map public.portal_field_maps%ROWTYPE;
BEGIN
  IF app_authz.is_restricted_external() OR coalesce(auth.role(), '') = 'anon' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;
  IF jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'entries_must_be_array';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    v_id := nullif(v_entry->>'id', '')::uuid;
    v_expected_generation := nullif(v_entry->>'expected_mapping_generation', '')::integer;
    -- Read identity without locking, then acquire locks in reset order:
    -- portal configuration first, field-map row second.
    SELECT portal_key, map_type INTO v_portal_key, v_map_type FROM public.portal_field_maps
     WHERE id = v_id AND org_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'field_map_not_found'; END IF;
    IF v_map_type IN ('pdf', 'xlsx') THEN
      PERFORM public.assert_legacy_pdf_mapping_generation_for_write(
        v_portal_key, v_expected_generation
      );
    ELSE
      PERFORM public.assert_portal_mapping_generation_for_write(
        v_portal_key, NULL, v_expected_generation
      );
    END IF;
    SELECT * INTO v_map FROM public.portal_field_maps
     WHERE id = v_id AND org_id IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'field_map_not_found'; END IF;
    IF v_map.portal_key IS DISTINCT FROM v_portal_key
       OR v_map.map_type IS DISTINCT FROM v_map_type THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'mapping_configuration_changed';
    END IF;
    UPDATE public.portal_field_maps
       SET display_label = CASE WHEN v_entry ? 'display_label'
                                THEN nullif(btrim(coalesce(v_entry->>'display_label', '')), '') ELSE display_label END,
           section = CASE WHEN v_entry ? 'section'
                          THEN nullif(btrim(coalesce(v_entry->>'section', '')), '') ELSE section END,
           sort_order = CASE WHEN v_entry ? 'sort_order'
                             THEN (v_entry->>'sort_order')::integer ELSE sort_order END,
           updated_at = now()
     WHERE id = v_id AND org_id IS NULL;
  END LOOP;
  RETURN QUERY SELECT * FROM public.portal_field_maps
    WHERE org_id IS NULL
      AND id IN (SELECT (entry->>'id')::uuid FROM jsonb_array_elements(p_entries) entry);
END;
$function$;
