// The phone validation rules in force (src/lib/phone.ts). No platform or
// organization override is stored yet, so this is the defaults; the Mission
// Control setting (MINT-129) reads its overrides here and passes them to
// resolvePhoneValidationRules. One frozen object, so callers can list it in
// memo dependencies and none can change it for the others.
import { resolvePhoneValidationRules, type PhoneValidationRules } from "@/lib/phone";

const RESOLVED_RULES: PhoneValidationRules = Object.freeze(resolvePhoneValidationRules());

export function usePhoneValidationRules(): PhoneValidationRules {
  return RESOLVED_RULES;
}
