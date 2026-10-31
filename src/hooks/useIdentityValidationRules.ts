// The identity validation rules in force (src/lib/providerIdentity.ts). No
// platform or organization override is stored yet, so this is the defaults;
// the Mission Control setting (MINT-129) reads its overrides here and passes
// them to resolveIdentityValidationRules. One resolved object, so callers can
// list it in memo dependencies.
import {
  resolveIdentityValidationRules,
  type IdentityValidationRules,
} from "@/lib/providerIdentity";

const RESOLVED_RULES = resolveIdentityValidationRules();

export function useIdentityValidationRules(): IdentityValidationRules {
  return RESOLVED_RULES;
}
