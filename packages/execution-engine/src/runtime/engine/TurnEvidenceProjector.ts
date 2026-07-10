import type { RunEvent } from "@repo/shared-types";
import {
  buildEvidenceLedgerFromEvents,
  type EvidenceRecord,
} from "./EvidenceLedger.js";

export interface TurnEvidenceProjection {
  evidence: EvidenceRecord[];
  source: "canonical_run_events";
}

export function projectTurnEvidence(
  events: readonly RunEvent[],
): TurnEvidenceProjection {
  return {
    evidence: buildEvidenceLedgerFromEvents(events),
    source: "canonical_run_events",
  };
}
