// Mission Control › Organizations › create form state (M3). One form, one
// click: name, slug (prefilled from the name until edited), owner name and
// email (the customer admin M4 invites), optional plan tier. The escalation
// contact and sales rep are added later on the detail page, so unlike
// useOrgCreateForm (the customer intake form, which requires the escalation
// contact) nothing else is asked. It reuses that form's email checks; the
// database (platform_create_organization) stays the authority.
import { useState } from "react";
import { useCreatePlatformOrganization } from "@/hooks/usePlatformOrganizations";
import { commonEmailDomainTypo, isValidEmail } from "@/lib/contactValidation";
import { slugFromName, slugProblem } from "@/lib/orgProfile";
import { OrgRpcError } from "@/services/platformOrganizations";

export interface PlatformOrgCreateErrors {
  name?: string;
  slug?: string;
  ownerName?: string;
  ownerEmail?: string;
  form?: string;
}

const SLUG_CODES = new Set(["slug_taken", "slug_invalid"]);

export function usePlatformOrgCreateForm(opts: { onCreated: (orgId: string) => void }) {
  const create = useCreatePlatformOrganization();
  const [name, setNameState] = useState("");
  const [slug, setSlugState] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [planTier, setPlanTier] = useState<string | null>(null);
  const [errors, setErrors] = useState<PlatformOrgCreateErrors>({});

  const emailWarning = ownerEmail.trim() ? commonEmailDomainTypo(ownerEmail) : null;

  function setName(value: string) {
    setNameState(value);
    if (!slugEdited) setSlugState(slugFromName(value));
  }

  function setSlug(value: string) {
    setSlugEdited(true);
    setSlugState(value.trim().toLowerCase());
  }

  function validate(): boolean {
    const next: PlatformOrgCreateErrors = {};
    if (!name.trim()) next.name = "Organization name is required";
    const problem = slugProblem(slug);
    if (problem) next.slug = problem;
    if (!ownerName.trim()) next.ownerName = "Owner name is required";
    if (!ownerEmail.trim()) next.ownerEmail = "Owner email is required";
    else if (!isValidEmail(ownerEmail)) next.ownerEmail = "Enter a valid email address";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submit() {
    if (!validate()) return;
    create.mutate(
      { name, slug, ownerName, ownerEmail, planTier },
      {
        onSuccess: ({ orgId }) => opts.onCreated(orgId),
        onError: (error) => {
          const message = error instanceof Error ? error.message : "Couldn't create organization";
          if (error instanceof OrgRpcError && SLUG_CODES.has(error.code)) {
            setErrors({ slug: message });
          } else {
            setErrors({ form: message });
          }
        },
      },
    );
  }

  return {
    name,
    setName,
    slug,
    setSlug,
    ownerName,
    setOwnerName,
    ownerEmail,
    setOwnerEmail,
    planTier,
    setPlanTier,
    errors,
    emailWarning,
    applyEmailSuggestion: () => {
      if (emailWarning) setOwnerEmail(emailWarning);
    },
    submit,
    isPending: create.isPending,
  };
}

export type PlatformOrgCreateForm = ReturnType<typeof usePlatformOrgCreateForm>;
