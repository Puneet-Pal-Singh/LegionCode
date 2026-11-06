import { AppServerEnvironmentIdSchema, HarnessAdmissionSelectionSchema, type HarnessAdmissionSelection } from "@repo/platform-protocol";
import { DomainError, ValidationError } from "../../domain/errors";

/** Selection intent chooses a strategy before any Native provider work.
 * This classification does not authorize credentials or create the frozen binding;
 * those remain with canonical admission and runtime composition.
 */
export function isDelegatedChat(input: {
  harnessSelection?: HarnessAdmissionSelection;
  harnessMode?: "platform_owned" | "delegated";
}, correlationId?: string): boolean {
  const admitted = input.harnessSelection === undefined
    ? undefined
    : HarnessAdmissionSelectionSchema.parse(input.harnessSelection);
  const delegated = admitted?.selection != null;
  if (!delegated && input.harnessMode === "delegated") {
    throw new ValidationError("Delegated execution requires an explicit harness selection", "HARNESS_SELECTION_REQUIRED", correlationId);
  }
  return delegated;
}

/** Trusted host configuration must agree with every explicit placement intent. */
export function assertHostedChatEnvironment(
  selection: HarnessAdmissionSelection | undefined,
  configuredEnvironmentId: string | undefined,
  correlationId?: string,
): void {
  if (!selection) return;
  const environment = AppServerEnvironmentIdSchema.safeParse(configuredEnvironmentId);
  if (!environment.success || selection.environmentId !== environment.data) {
    throw new DomainError("HARNESS_ENVIRONMENT_UNAVAILABLE", "Selected execution environment is unavailable", 503, false, correlationId);
  }
}

/** Reads only canonical admission receipts; never repairs a missing capture from
 * the submitted request or mutable Settings. Legacy Native receipts may omit it. */
export function readAdmittedHarnessSelection(admission: unknown): HarnessAdmissionSelection | undefined {
  if (!admission || typeof admission !== "object" || !("harnessSelection" in admission) || admission.harnessSelection == null) return undefined;
  const parsed = HarnessAdmissionSelectionSchema.safeParse(admission.harnessSelection);
  if (!parsed.success) throw new DomainError("HARNESS_BINDING_INVALID", "Persisted harness selection is invalid", 503, false);
  return parsed.data;
}

export function requireAdmittedHarnessSelection(
  expected: HarnessAdmissionSelection | undefined,
  admission: unknown,
  correlationId?: string,
): HarnessAdmissionSelection | undefined {
  const actual = readAdmittedHarnessSelection(admission);
  const canonicalExpected = expected ? HarnessAdmissionSelectionSchema.parse(expected) : undefined;
  if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
    throw new DomainError("HARNESS_BINDING_CONFLICT", "Admitted harness selection is missing or differs from the verified capture", 409, false, correlationId);
  }
  return actual;
}
