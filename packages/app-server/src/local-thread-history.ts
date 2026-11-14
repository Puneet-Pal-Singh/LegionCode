import {
  APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES, APP_SERVER_PROTOCOL_VERSION, appServerJsonByteLength,
  type TurnAdmission,
} from "@repo/platform-protocol";
import { LocalThreadUserHistoryFrameTooLargeError } from "@repo/event-store";
import { EventStoreError } from "@repo/event-store/errors";
import type { LocalPersistence } from "@repo/event-store/local";
import type { LocalThreadService } from "./local-threads.js";
import { LocalThreadHistoryParamsSchema, LocalThreadHistoryResultSchema, type LocalThreadHistoryParams } from "./protocol.js";
import { AppServerOperationError } from "./server.js";

/** Read-only projection over canonical admission/user-item streams. Admission
 * paging and message windows retain independent, explicit cursor semantics. */
export async function readLocalThreadHistory(options: {
  persistence: Pick<LocalPersistence, "turnAdmissions" | "readThreadUserHistory">;
  threads: LocalThreadService;
}, raw: LocalThreadHistoryParams) {
  const params = LocalThreadHistoryParamsSchema.parse(raw);
  const thread = await options.threads.get(params.threadId);
  const authorize = async () => {
    const current = await options.threads.get(thread.id);
    if (current.userId !== thread.userId || current.workspaceId !== params.workspaceId)
      throw new AppServerOperationError(404, "not_found", "Local thread was not found in the granted workspace");
  };
  if (thread.workspaceId !== params.workspaceId) throw new AppServerOperationError(404, "not_found", "Local thread was not found in the granted workspace");
  const bytes = (result: unknown) => appServerJsonByteLength({ protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    method: "thread/history", ok: true, result });
  try {
    if (params.messagesContinuation) {
      const continuation = params.messagesContinuation;
      const admissionFrame = { admissions: [] as TurnAdmission[], nextCursor: null };
      const messagePage = await options.persistence.readThreadUserHistory({
        threadId: thread.id, userId: thread.userId, workspaceId: thread.workspaceId,
        ...continuation, limit: params.messageLimit ?? 100, maxBytes: APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES,
        allowEmptyPrefix: false, measure: (page) => bytes({ ...admissionFrame, ...page }),
      });
      await authorize();
      return LocalThreadHistoryResultSchema.parse({ ...admissionFrame, ...messagePage });
    }
    let admissionBudget = APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES;
    for (;;) {
      const page = await options.persistence.turnAdmissions.listByThread({ threadId: thread.id,
        afterCursor: params.afterCursor ?? null, limit: params.limit ?? (params.latest ? 25 : 50),
        latest: params.latest, maxBytes: admissionBudget });
      const admissionFrame = { admissions: [...page.admissions], nextCursor: page.nextCursor,
        ...(params.latest ? { hasEarlier: page.hasEarlier } : {}) };
      if (!page.admissions.length) {
        await authorize();
        return LocalThreadHistoryResultSchema.parse({ ...admissionFrame, messages: [] });
      }
      try {
        const messagePage = await options.persistence.readThreadUserHistory({
          threadId: thread.id, userId: thread.userId, workspaceId: thread.workspaceId,
          turnIds: page.admissions.map((admission) => admission.turn.id), cursor: null,
          direction: params.latest ? "backward" : "forward", limit: params.messageLimit ?? 100,
          allowEmptyPrefix: true, maxBytes: APP_SERVER_DEFAULT_MAX_RESPONSE_BYTES,
          measure: (messages) => bytes({ ...admissionFrame, ...messages }),
        });
        await authorize();
        return LocalThreadHistoryResultSchema.parse({ ...admissionFrame, ...messagePage });
      } catch (error) {
        if (!(error instanceof LocalThreadUserHistoryFrameTooLargeError)) throw error;
        // Reuse canonical whole-Turn pagination with a smaller private budget;
        // never fabricate the admission cursor when reducing the selected page.
        admissionBudget = Math.min(admissionBudget - 1, bytes(admissionFrame) - error.excessBytes);
        if (admissionBudget < 1) throw error;
      }
    }
  } catch (error) {
    if (error instanceof EventStoreError) {
      if (error.code === "history_row_too_large")
        throw new AppServerOperationError(503, "server_unavailable", "The next saved history record exceeds the supported response size", "history_row_too_large", false);
      if (error.code === "cursor_conflict" || error.code === "cursor_not_found")
        throw new AppServerOperationError(409, "conflict", "Saved history cursor does not match its authorized snapshot", "history_cursor_conflict", false);
    }
    throw error;
  }
}
