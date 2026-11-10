import type { SqlMigration } from "./types.js";
export const harnessOpeningIntentMigration: SqlMigration = {
  id: "0040_harness_opening_intent",
  description:
    "Persist actual process generation before native harness opening",
  statements: ["ALTER TABLE harness_bindings ADD COLUMN opening_json JSONB"],
};
