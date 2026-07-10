import { buildEvidenceLedger } from "./EvidenceLedger.js";
import {
  evaluateFinalizationContract,
  readFinalizationEvidenceRequirements,
  type FinalizationContract,
} from "./EvidenceLedger.js";
import type { Run } from "../run/index.js";

export function settleFinalizationContract(input: {
  run: Run;
  metadata?: Record<string, unknown>;
}): {
  ledger: ReturnType<typeof buildEvidenceLedger>;
  contract: FinalizationContract;
  metadata: Record<string, unknown>;
} {
  const ledger = buildEvidenceLedger(
    input.run.metadata.agenticLoop?.toolLifecycle ?? [],
  );
  const requiredEvidence = readFinalizationEvidenceRequirements(
    input.metadata?.requiredEvidence,
  );
  const contract = evaluateFinalizationContract({
    ledger,
    requiredEvidence,
  });
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };

  if (ledger.length > 0 || requiredEvidence.length > 0) {
    metadata.evidenceLedger = ledger;
    metadata.finalizationContract = contract;
  }

  if (!contract.settled) {
    metadata.code = "FINALIZATION_MISSING_EVIDENCE";
  }

  return { ledger, contract, metadata };
}

export function buildMissingEvidenceFinalText(
  contract: FinalizationContract,
): string {
  return [
    "I cannot finalize that answer yet because this run did not record the required evidence.",
    `Missing evidence: ${contract.missingEvidence.join(", ")}`,
  ].join("\n");
}
