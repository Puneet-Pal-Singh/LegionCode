import { createHash } from "node:crypto";
import {
  ContentDigestSchema,
  HarnessAdmissionSelectionSchema,
  LocalTurnConfigurationSchema,
  TurnAdmissionSchema,
  type TurnAdmission,
} from "@repo/platform-protocol";
import { EventStoreError } from "./errors.js";
import { createStableEventFingerprint } from "./fingerprint.js";

/** Delegated client intent only. Native admission retains its strict fingerprint.
 * Private runtime pins and server-derived lineage never redefine a saved retry. */
export function fingerprintLocalHarnessClientIntent(value: TurnAdmission): string {
  try {
    const admission = TurnAdmissionSchema.parse(value);
    const { run, userMessage, clientRequestId } = admission;
    if (userMessage.type !== "user_message") throw invalidIntent();
    const capture = HarnessAdmissionSelectionSchema.parse(run.harnessSelection);
    const contentCapture = HarnessAdmissionSelectionSchema.parse(userMessage.content.harnessSelection);
    if (!capture.selection || typeof userMessage.content.text !== "string" ||
        createStableEventFingerprint(capture) !== createStableEventFingerprint(contentCapture))
      throw invalidIntent();
    const imageFingerprint = userMessage.content.imageFingerprint === undefined ? undefined
      : ContentDigestSchema.parse(userMessage.content.imageFingerprint);
    const configuration = userMessage.content.configuration === undefined ? undefined
      : LocalTurnConfigurationSchema.parse(userMessage.content.configuration);
    return createHash("sha256").update(createStableEventFingerprint({
      userId: run.userId, workspaceId: run.workspaceId, threadId: run.threadId, clientRequestId,
      text: userMessage.content.text, capture,
      ...(imageFingerprint === undefined ? {} : { imageFingerprint }),
      ...(configuration === undefined ? {} : { configuration }),
    })).digest("hex");
  } catch (error) {
    if (error instanceof EventStoreError) throw error;
    throw invalidIntent();
  }
}

function invalidIntent(): EventStoreError {
  return new EventStoreError("idempotency_conflict", "Delegated admission has invalid or conflicting client intent");
}
