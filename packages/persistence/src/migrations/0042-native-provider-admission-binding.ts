import type { SqlMigration } from "./types.js";

/** Private attempt custody pins. Historical admissions remain unbound; readers
 * must never repair them from today's selected provider or credential. */
export const nativeProviderAdmissionBindingMigration: SqlMigration = {
  id: "0042_native_provider_admission_binding",
  description: "Freeze private Native provider binding with canonical admission",
  statements: [
    `ALTER TABLE canonical_turn_admissions ADD COLUMN IF NOT EXISTS native_provider_binding_json JSONB`,
    `ALTER TABLE canonical_turn_admissions ADD CONSTRAINT canonical_turn_admissions_native_provider_binding_object_check
      CHECK (native_provider_binding_json IS NULL OR jsonb_typeof(native_provider_binding_json) = 'object')`,
  ],
};
