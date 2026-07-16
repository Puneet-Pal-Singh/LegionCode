import type { Message } from "@ai-sdk/react";
import type { FileStatus } from "@repo/shared-types";
import type { ActivityTurnViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import { buildConversationTurns } from "../messageMetadata";

export type ChatInterfaceEntry =
  | { kind: "message"; message: Message }
  | {
      kind: "turn";
      turn: ActivityTurnViewModel;
      userMessage?: Message;
      assistantMessage?: Message;
    };

export function buildChatEntries(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
  runId: string,
): ChatInterfaceEntry[] {
  const entries: ChatInterfaceEntry[] = [];
  const activityTurnsByMessageId = correlateActivityTurnsToMessages(
    conversationTurns,
    turns,
    { logUnmatched: false, runId },
  );
  const assignedActivityTurnKeys = new Set<string>();

  for (const conversationTurn of conversationTurns) {
    const userMessage = conversationTurn.userMessage;
    const assistantMessage = conversationTurn.assistantMessage;
    const matchedActivityTurns = userMessage
      ? (activityTurnsByMessageId.get(userMessage.id) ?? []).filter(
          (activityTurn) => activityTurn.hasVisibleRows,
        )
      : [];

    if (matchedActivityTurns.length > 0 && userMessage) {
      matchedActivityTurns.forEach((activityTurn, index) => {
        assignedActivityTurnKeys.add(activityTurn.key);
        entries.push({
          kind: "turn",
          turn: activityTurn,
          userMessage: index === 0 ? userMessage : undefined,
          assistantMessage:
            index === matchedActivityTurns.length - 1 &&
            shouldIncludeAssistantMessage(assistantMessage)
              ? assistantMessage
              : undefined,
        });
      });
      continue;
    }

    if (userMessage) {
      entries.push({ kind: "message", message: userMessage });
    }
    if (shouldIncludeAssistantMessage(assistantMessage)) {
      entries.push({
        kind: "message",
        message: assistantMessage,
      });
    }
  }

  if (entries.length === 0) {
    appendUnmatchedActivityTurns(entries, turns, assignedActivityTurnKeys);
  }
  return entries;
}

function appendUnmatchedActivityTurns(
  entries: ChatInterfaceEntry[],
  turns: ActivityTurnViewModel[],
  assignedActivityTurnKeys: Set<string>,
): void {
  for (const turn of turns) {
    if (!turn.hasVisibleRows || assignedActivityTurnKeys.has(turn.key)) {
      continue;
    }

    const prompt = turn.userPrompt?.trim();
    const userMessage = prompt
      ? ({
          id: `activity:${turn.key}:user`,
          role: "user",
          content: prompt,
        } as Message)
      : undefined;
    entries.push({ kind: "turn", turn, userMessage });
  }
}

function correlateActivityTurnsToMessages(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
  options: { logUnmatched?: boolean; runId?: string } = {},
): Map<string, ActivityTurnViewModel[]> {
  const logUnmatched = options.logUnmatched ?? true;
  const assignments = new Map<string, ActivityTurnViewModel[]>();
  const userMessageIds = new Set(
    conversationTurns.flatMap((turn) =>
      turn.userMessage ? [turn.userMessage.id] : [],
    ),
  );

  for (const activityTurn of turns) {
    if (!activityTurn?.hasVisibleRows) {
      continue;
    }
    const messageId = resolveActivityTurnMessageId(
      activityTurn,
      userMessageIds,
    );
    if (!messageId) {
      if (logUnmatched) {
        warnUnmatchedActivityTurn(options.runId, activityTurn.key);
      }
      continue;
    }
    const existingAssignments = assignments.get(messageId) ?? [];
    existingAssignments.push(activityTurn);
    assignments.set(messageId, existingAssignments);
  }

  return assignments;
}

function shouldIncludeAssistantMessage(
  message: Message | undefined,
): message is Message {
  if (!message || message.role !== "assistant") {
    return false;
  }

  const terminalState = readTerminalState(message);
  return terminalState == null || terminalState === "completed";
}

function readTerminalState(message: Message): string | null {
  const data = (message as Message & { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return null;
  }

  const metadata = (data as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const terminalState = (metadata as Record<string, unknown>).terminalState;
  return typeof terminalState === "string" ? terminalState : null;
}

function resolveActivityTurnMessageId(
  activityTurn: ActivityTurnViewModel,
  userMessageIds: Set<string>,
): string | null {
  if (userMessageIds.has(activityTurn.key)) {
    return activityTurn.key;
  }

  return null;
}

const unmatchedActivityWarningKeys = new Set<string>();
const MAX_UNMATCHED_ACTIVITY_WARNING_KEYS = 500;

function warnUnmatchedActivityTurn(
  runId: string | undefined,
  activityTurnKey: string,
): void {
  const warningKey = `${runId ?? "unknown"}:${activityTurnKey}`;
  if (unmatchedActivityWarningKeys.has(warningKey)) {
    return;
  }

  if (
    unmatchedActivityWarningKeys.size >= MAX_UNMATCHED_ACTIVITY_WARNING_KEYS
  ) {
    unmatchedActivityWarningKeys.clear();
  }
  unmatchedActivityWarningKeys.add(warningKey);

  console.warn(
    "[chat/transcript] Activity turn could not be correlated to a user message.",
    { activityTurnKey, runId },
  );
}

export function deriveActivityChangedFilesByAssistantMessageId(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
  turns: ActivityTurnViewModel[],
): Record<string, FileStatus[]> {
  const assignments = correlateActivityTurnsToMessages(
    conversationTurns,
    turns,
    {
      logUnmatched: false,
    },
  );
  const snapshots: Record<string, FileStatus[]> = {};

  for (const conversationTurn of conversationTurns) {
    if (!conversationTurn.userMessage || !conversationTurn.assistantMessage) {
      continue;
    }

    const activityTurns =
      assignments.get(conversationTurn.userMessage.id) ?? [];

    const changedFiles = collectActivityChangedFiles(activityTurns);
    if (changedFiles.length > 0) {
      snapshots[conversationTurn.assistantMessage.id] = changedFiles;
    }
  }

  return snapshots;
}

export function collectActivityChangedFiles(
  turns: ActivityTurnViewModel[],
): FileStatus[] {
  const filesByPath = new Map<string, FileStatus>();
  for (const turn of turns) {
    for (const row of turn.rows) {
      collectChangedFilesFromActivityRow(row, filesByPath);
    }
  }
  return [...filesByPath.values()];
}

function collectChangedFilesFromActivityRow(
  row: ActivityTurnViewModel["rows"][number],
  filesByPath: Map<string, FileStatus>,
): void {
  if (row.kind === "group") {
    for (const childRow of row.rows) {
      collectChangedFilesFromActivityRow(childRow, filesByPath);
    }
    return;
  }

  if (row.kind !== "tool" || !row.changedFile) {
    return;
  }

  const existing = filesByPath.get(row.changedFile.path);
  if (!existing) {
    filesByPath.set(row.changedFile.path, { ...row.changedFile });
    return;
  }

  filesByPath.set(row.changedFile.path, {
    ...existing,
    additions: existing.additions + row.changedFile.additions,
    deletions: existing.deletions + row.changedFile.deletions,
  });
}
