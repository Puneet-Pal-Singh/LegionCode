import type { AppServerRequest, ConversationScope } from "@legioncode/sdk";
import { sameConversationScope } from "@legioncode/sdk";
import { workspaceIdFromExternalId } from "@repo/platform-protocol";

const MUTATIONS = new Set<AppServerRequest["method"]>([
  "turn/interrupt", "turn/approval", "turn/compact", "turn/steer", "turn/resume",
  "thread/input/enqueue", "thread/input/update", "thread/input/remove", "thread/input/steer", "thread/input/start",
]);
type Selection = Readonly<{ ownerKey: string; scope: ConversationScope | null }>;
const changed = () => new Error("The hosted task changed or needs recovery review before command dispatch.");

function assertEnvelopeScope(envelope: AppServerRequest, scope: ConversationScope): void {
  const expected = {
    sessionId: scope.sessionId, runId: scope.runId, workspaceId: workspaceIdFromExternalId(scope.workspaceId),
    threadId: scope.threadId, turnId: scope.turnId, runAttemptId: scope.runAttemptId,
    expectedTurnId: scope.turnId, expectedRunAttemptId: scope.runAttemptId,
  };
  const params: Record<string, unknown> = envelope.params;
  for (const [name, value] of Object.entries(expected)) {
    if (!(name in params)) continue;
    const actual = params[name];
    const normalized = name === "workspaceId" && typeof actual === "string"
      ? workspaceIdFromExternalId(actual) : actual;
    if (normalized !== value) throw changed();
  }
}

/** Captures only the existing authenticated selection before transport awaits.
 * The final synchronous guard neither owns execution nor observes responses. */
export function prepareConversationRequestGuard(envelope: AppServerRequest, selected: Selection,
  readCurrent: () => Selection, isAllowed: (scope: ConversationScope) => boolean): (() => void) | undefined {
  if (!MUTATIONS.has(envelope.method)) return undefined;
  if (!selected.scope) throw changed();
  const scope = Object.freeze({ ...selected.scope });
  const ownerKey = selected.ownerKey;
  assertEnvelopeScope(envelope, scope);
  return () => {
    const current = readCurrent();
    if (current.ownerKey !== ownerKey || !sameConversationScope(current.scope, scope) || !isAllowed(scope)) throw changed();
    assertEnvelopeScope(envelope, scope);
  };
}
