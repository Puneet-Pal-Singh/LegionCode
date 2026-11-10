import type { LifecycleEventStore, TurnAdmissionRecord } from "@repo/persistence";
import {
  normalizeUserInputResponse, userIdFromExternalId,
  type LifecycleEvent, type SubmitUserInputResponseRequest, type UserInputResponse,
} from "@repo/platform-protocol";
import type { RunInterruptIdentity } from "./RunInterruptContract";

type Scope = RunInterruptIdentity & { readonly ownerUserId?: string; readonly revisionOfTurnId?: string };
type UserInputEvent = Extract<LifecycleEvent, { type: "user_input.requested" | "user_input.responded" | "request.resolved" }>;
type Requested = UserInputEvent & { readonly type: "user_input.requested" };
type Responded = UserInputEvent & { readonly type: "user_input.responded" };
type Authorization =
  | { readonly kind: "pending"; readonly scope: Scope; readonly command: SubmitUserInputResponseRequest }
  | { readonly kind: "responded"; readonly event: Responded }
  | { readonly kind: "conflict"; readonly message: string };
const conflict = (message: string): Authorization => ({ kind: "conflict", message });

/** Bind authenticated command to immutable admission and canonical pending form.
 * Never recover a native reply handle or infer ownership from the current picker.
 */
export async function authorizeLifecycleUserInput(input: {
  readonly store: LifecycleEventStore;
  readonly command: SubmitUserInputResponseRequest;
  readonly runId: string;
  readonly identity: Scope | undefined;
  readonly admission: TurnAdmissionRecord | null;
  readonly hasActiveOwner: () => boolean;
}): Promise<Authorization> {
  const { command, identity, admission } = input;
  if (!identity || !admission || admission.state !== "admitted" || !identity.ownerUserId ||
      admission.userId !== identity.ownerUserId || admission.turnId !== command.turnId || identity.turnId !== command.turnId ||
      admission.runId !== input.runId || identity.runId !== input.runId || admission.sessionId !== identity.sessionId ||
      admission.workspaceId !== identity.workspaceId || admission.threadId !== identity.threadId ||
      admission.runAttemptId !== identity.runAttemptId || admission.revisionOfTurnId !== (identity.revisionOfTurnId ?? null))
    return conflict("Question does not match its immutable admitted runtime scope.");
  const actor = userIdFromExternalId(identity.ownerUserId);
  if (command.respondedBy !== actor) return conflict("Question responder does not match its authenticated owner.");
  const facts = await findLifecycleUserInputEvents(input.store, identity, command.requestId);
  if (!facts.requested || facts.unavailable) return conflict("No matching canonical question is available.");
  let response: UserInputResponse;
  try { response = normalizeUserInputResponse(facts.requested.payload, command.response); }
  catch { return conflict("Question response does not match its pending descriptor."); }
  if (facts.responded) {
    let prior: UserInputResponse;
    try { prior = normalizeUserInputResponse(facts.requested.payload, facts.responded.payload.response); }
    catch { return conflict("Canonical question response is unavailable."); }
    return facts.responded.payload.respondedBy === actor && JSON.stringify(prior) === JSON.stringify(response)
      ? { kind: "responded", event: facts.responded }
      : conflict("Question was already resolved differently.");
  }
  if (facts.resolved || facts.settled || admission.executionState !== "running" || !input.hasActiveOwner())
    return conflict("Question no longer has an active runtime owner.");
  return { kind: "pending", scope: identity, command: { ...command, respondedBy: actor, response } };
}

/** Bounded canonical replay; exhaustion and inconsistent origins fail closed. */
export async function findLifecycleUserInputEvents(store: LifecycleEventStore, scope: RunInterruptIdentity, requestId: string): Promise<{
  requested: Requested | null; responded: Responded | null; resolved: boolean; settled: boolean; unavailable: boolean;
}> {
  let requested: Requested | null = null;
  let responded: Responded | null = null;
  let resolved = false, settled = false, unavailable = false;
  let afterSequence: number | null = null;
  for (let page = 0; page < 100; page++) {
    const replay = await store.replay({ turnId: scope.turnId, afterSequence, limit: 1000 });
    for (const event of replay.events) {
      if (event.turnId !== scope.turnId || event.threadId !== scope.threadId || event.runAttemptId !== scope.runAttemptId) { unavailable = true; continue; }
      if (event.type === "user_input.requested" && event.requestId === requestId) {
        if (requested || responded || resolved || settled) unavailable = true;
        requested = { ...event, type: "user_input.requested" };
      } else if (event.type === "user_input.responded" && event.requestId === requestId) {
        if (!requested || responded || resolved || settled || event.itemId !== requested.itemId) unavailable = true;
        responded = { ...event, type: "user_input.responded" };
      } else if (event.type === "request.resolved" && event.requestId === requestId) {
        if (!requested || responded || resolved || event.itemId !== requested.itemId) unavailable = true;
        resolved = true;
      } else if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted" ||
          (requested && "itemId" in event && event.itemId === requested.itemId &&
           ["item.completed", "item.failed", "item.interrupted", "item.declined"].includes(event.type))) settled = true;
    }
    if (replay.nextSequence === null) return { requested, responded, resolved, settled, unavailable };
    if (replay.events.length === 0 || replay.nextSequence <= (afterSequence ?? 0))
      throw new Error("Canonical question replay cursor did not advance");
    afterSequence = replay.nextSequence;
  }
  return { requested, responded, resolved, settled, unavailable: true };
}
