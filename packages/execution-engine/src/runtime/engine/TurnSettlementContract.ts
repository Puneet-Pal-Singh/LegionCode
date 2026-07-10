import type { AgenticLoopToolLifecycleEvent } from "../types.js";
import {
  evaluateFinalizationContract,
  readFinalizationEvidenceRequirements,
  type FinalizationContract,
  type EvidenceRecord,
} from "./EvidenceLedger.js";
import { projectTurnEvidence } from "./TurnEvidenceProjector.js";

export function settleFinalizationContract(input: {
  lifecycle: readonly AgenticLoopToolLifecycleEvent[];
  metadata?: Record<string, unknown>;
}): {
  ledger: EvidenceRecord[];
  contract: FinalizationContract;
  metadata: Record<string, unknown>;
} {
  const ledger = projectTurnEvidence(input.lifecycle).evidence;
  const contract = evaluateFinalizationContract({
    ledger,
    requiredEvidence: readFinalizationEvidenceRequirements(
      input.metadata?.requiredEvidence,
    ),
  });
  return {
    ledger,
    contract,
    metadata: {
      ...(input.metadata ?? {}),
      evidenceLedger: ledger,
      finalizationContract: contract,
    },
  };
}
