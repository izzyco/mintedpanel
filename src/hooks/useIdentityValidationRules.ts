// The identity validation rules in force (src/lib/providerIdentity.ts). No
// platform or organization override is stored yet, so this is the defaults;
// the Mission Control setting (MINT-129) reads its overrides here and passes
// them to resolveIdentityValidationRules. One frozen object, so callers can
// list it in memo dependencies and none can change it for the others.
import {
  resolveIdentityValidationRules,
  type IdentityValidationRules,
} from "@/lib/providerIdentity";

const RESOLVED_RULES: IdentityValidationRules = Object.freeze(resolveIdentityValidationRules());

export function useIdentityValidationRules(): IdentityValidationRules {
  return RESOLVED_RULES;
}
