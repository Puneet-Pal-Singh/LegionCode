import type {
  HarnessAdmissionSelection,
  HarnessCapabilities,
  HarnessSelection,
  RunAttemptId,
  ThreadId,
  TurnId,
} from "@repo/platform-protocol";
import type { HarnessObservationCommitPort } from "@repo/runtime-kernel";
import type { ProviderId } from "@repo/shared-types";
import type { HarnessOpeningIntent, HarnessStartCommand, HarnessSession } from "@repo/worker-protocol";

export interface HarnessAdmissionPrincipal {
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly runAttemptId: RunAttemptId;
  readonly runId: string;
  readonly environmentId: string;
}
export type HarnessAccountFacts = Pick<
  HarnessSelection,
  | "harness"
  | "instanceId"
  | "connectionId"
  | "authOwnerGeneration"
  | "modelId"
  | "billingSource"
  | "runtimeVersion"
  | "protocolVersion"
  | "transport"
> & {
  readonly providerId: ProviderId;
  readonly capabilities: HarnessCapabilities;
};
/** P12/P13 implement account/selection checks only, using their existing selected
 * revision CAS, owned instance and connection authorities. No checkout/kernel. */
export interface HarnessAdmissionAccountPort {
  resolveForAdmission(
    principal: HarnessAdmissionPrincipal,
    expected: HarnessAdmissionSelection,
  ): Promise<HarnessAccountFacts>;
  assertForAttempt(
    principal: HarnessAdmissionPrincipal,
    selection: HarnessSelection,
  ): Promise<void>;
  /** Exactly P12 HarnessConnectionService.resolveForAttempt. Credential material
   * is opaque here and is parsed by P09 with the canonical credential schema. */
  resolveForAttempt(
    binding: HarnessAdmissionPrincipal & {
      readonly connectionId: string;
      readonly providerId: ProviderId;
      readonly ownerGeneration: number;
    },
  ): Promise<unknown>;
}
/** P11 adapter over the existing binding repository/canonical append transaction.
 * freezeAndClaim MUST lock/compare the authoritative next-selection revision and
 * account/instance pins, verify the admitted fingerprint and freeze the resolved
 * selection with the execution claim in that SAME transaction. Preflight is not
 * authority. An exact retry reads its immutable binding, never current defaults. */
export interface HarnessAdmissionBindingPort {
  /** Look up the immutable same-attempt binding first. Changed expected capture
   * must conflict; an existing binding is never re-resolved from new preferences. */
  lookupImmutable(
    principal: HarnessAdmissionPrincipal,
    expected: HarnessAdmissionSelection,
    admissionFingerprint: string,
  ): Promise<HarnessSelection | null>;
  freezeAndClaim(input: {
    readonly principal: HarnessAdmissionPrincipal;
    readonly selection: HarnessSelection;
    readonly claimId: string;
    readonly expectedSelection: HarnessAdmissionSelection;
    readonly admissionFingerprint: string;
  }): Promise<"claimed" | "already_claimed" | "recovery_required" | "settled">;
  observationsForAttempt(
    principal: HarnessAdmissionPrincipal,
    selection: HarnessSelection,
  ): HarnessObservationCommitPort;
  reserveOpening(input: { readonly principal: HarnessAdmissionPrincipal; readonly selection: HarnessSelection;
    readonly command: HarnessStartCommand; readonly intent: HarnessOpeningIntent }): Promise<void>;
  beginOpeningDispatch(input: { readonly principal: HarnessAdmissionPrincipal; readonly selection: HarnessSelection;
    readonly intent: HarnessOpeningIntent }): Promise<void>;
  cancelReservedOpening(input: { readonly principal: HarnessAdmissionPrincipal; readonly selection: HarnessSelection;
    readonly intent: HarnessOpeningIntent }): Promise<void>;
  acknowledgeOpening(input: { readonly principal: HarnessAdmissionPrincipal; readonly selection: HarnessSelection;
    readonly intent: HarnessOpeningIntent; readonly session: HarnessSession }): Promise<void>;
  attach(input: {
    readonly principal: HarnessAdmissionPrincipal;
    readonly selection: HarnessSelection;
    readonly session: HarnessSession;
  }): Promise<void>;
  assertActive(
    principal: HarnessAdmissionPrincipal,
    selection: HarnessSelection,
  ): Promise<void>;
}
