import {
  iterateLocalThreadHistory,
  type AppServerClient,
  type LocalThreadHistoryParams,
  type LocalThreadHistoryMessagesWindow,
  type ConversationHistoryMessage,
} from "@legioncode/sdk";
import type { EventCursor, Thread, TurnAdmission } from "@repo/platform-protocol";

export const DESKTOP_HISTORY_PAGE_SIZE = 25;
export interface DesktopHistoryWindow {
  readonly admissions: TurnAdmission[];
  readonly messages: ConversationHistoryMessage[];
  readonly window: LocalThreadHistoryMessagesWindow | null;
  readonly nextCursor: EventCursor | null;
  readonly hasEarlier: boolean;
}

/** One bounded read for the existing conversation owner. Admission cursors and
 * message-window cursors never substitute for one another. */
export async function readDesktopHistoryWindow(
  client: AppServerClient,
  thread: Thread,
  request: LocalThreadHistoryParams,
  previous: DesktopHistoryWindow | null,
  signal: AbortSignal,
): Promise<DesktopHistoryWindow> {
  const assertCurrent = () => { if (signal.aborted) throw new Error("Saved history read was cancelled"); };
  assertCurrent();
  if (request.workspaceId !== thread.workspaceId || request.threadId !== thread.id) throw new Error("Saved history request scope changed");
  const continuation = request.messagesContinuation;
  if (continuation && (!previous?.window || continuation.throughCursor !== previous.window.throughCursor ||
    JSON.stringify(continuation.turnIds) !== JSON.stringify(previous.window.turnIds))) {
    throw new Error("Saved message navigation no longer belongs to this history snapshot");
  }
  const iterator = iterateLocalThreadHistory((params) => client.getThreadHistoryPage(params), request, { signal });
  try {
    const first = await iterator.next();
    if (!first.value) throw new Error("Saved history did not return a page");
    const admissionPage = first.value;
    if (!continuation && admissionPage.nextCursor !== null && admissionPage.nextCursor === request.afterCursor) {
      throw new Error("Saved admission history cursor did not make progress");
    }
    // A full admission envelope may reserve all bytes. Follow its explicit
    // body continuation once, never drain the remainder of the transcript.
    const body = admissionPage.messages.length === 0 && admissionPage.messagesContinuation
      ? (await iterator.next()).value : admissionPage;
    if (!body) throw new Error("Saved history did not return its bounded message window");
    const history = continuation ? [...previous!.admissions] : [...admissionPage.admissions];
    if (history.length > DESKTOP_HISTORY_PAGE_SIZE) throw new Error("Invalid admission page size");
    for (const admission of history) assertDesktopAdmissionScope(admission, thread);
    if (continuation && JSON.stringify(body.messagesWindow?.lastUserByTurn) !== JSON.stringify(previous!.window?.lastUserByTurn)) {
      throw new Error("Saved message snapshot changed during navigation");
    }
    const admissionsById = new Map(history.map((admission) => [admission.turn.id, admission]));
    for (const message of body.messages) {
      const identity = message.data?.metadata?.canonicalIdentity;
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("Saved message identity is unavailable");
      const facts = identity as Record<string, unknown>;
      const admission = typeof facts.turnId === "string" ? history.find((item) => item.turn.id === facts.turnId) : undefined;
      if (!admission || facts.runAttemptId !== admission.runAttemptId) throw new Error("Saved message belongs to another attempt");
    }
    if (body.messagesWindow && (body.messagesWindow.turnIds.length !== history.length ||
      body.messagesWindow.turnIds.some((turnId) => !admissionsById.has(turnId)))) throw new Error("Saved message Turn selection changed");
    const latest = history.at(-1);
    if (latest) {
      assertCurrent();
      const restored = await client.getTurn(latest.turn.id);
      assertCurrent();
      assertDesktopAdmissionScope(restored, thread);
      if (restored.turn.id !== latest.turn.id || restored.run.id !== latest.run.id || restored.runAttemptId !== latest.runAttemptId) {
        throw new Error("Restored turn identity changed");
      }
      history[history.length - 1] = restored;
    }
    assertCurrent();
    const lookahead = !continuation && admissionPage.nextCursor ? await client.getThreadHistoryPage({
      workspaceId: thread.workspaceId, threadId: thread.id, afterCursor: admissionPage.nextCursor, limit: 1, messageLimit: 1,
    }) : null;
    assertCurrent();
    for (const admission of lookahead?.admissions ?? []) assertDesktopAdmissionScope(admission, thread);
    return { admissions: history, messages: body.messages, window: body.messagesWindow ?? null,
      nextCursor: continuation ? previous!.nextCursor : lookahead?.admissions.length ? admissionPage.nextCursor : null,
      hasEarlier: continuation ? previous!.hasEarlier : request.latest === true && admissionPage.hasEarlier === true };
  } finally {
    await iterator.return();
  }
}

export function assertDesktopAdmissionScope(admission: TurnAdmission, thread: Thread): void {
  if (admission.run.workspaceId !== thread.workspaceId || admission.run.threadId !== thread.id ||
    admission.turn.threadId !== thread.id || admission.turn.runId !== admission.run.id) {
    throw new Error("Local admission does not belong to the selected thread");
  }
}
