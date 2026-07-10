import type { AgenticLoopToolLifecycleEvent } from "../types.js";
import {
  buildEvidenceLedger,
  type EvidenceRecord,
} from "./EvidenceLedger.js";

export interface TurnEvidenceProjection {
  evidence: EvidenceRecord[];
  source: "canonical_tool_lifecycle";
}

export function projectTurnEvidence(
  lifecycle: readonly AgenticLoopToolLifecycleEvent[],
): TurnEvidenceProjection {
  return {
    evidence: buildEvidenceLedger(lifecycle),
    source: "canonical_tool_lifecycle",
  };
}
