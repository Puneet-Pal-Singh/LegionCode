import type { Message } from "@ai-sdk/react";
import type { FileStatus } from "@repo/shared-types";
import type { ActivityTurnViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import { buildConversationTurns } from "../messageMetadata";

export type ChatInterfaceEntry =
  | { kind: "message"; message: Message }
  | { kind: "turn"; turn: ActivityTurnViewModel };

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
    if (conversationTurn.userMessage) {
      entries.push({
        kind: "message",
        message: conversationTurn.userMessage,
      });

      const matchedActivityTurns =
        activityTurnsByMessageId.get(conversationTurn.userMessage.id) ?? [];
      for (const activityTurn of matchedActivityTurns) {
        if (activityTurn.hasVisibleRows) {
          assignedActivityTurnKeys.add(activityTurn.key);
          entries.push({ kind: "turn", turn: activityTurn });
        }
      }
    }

    if (conversationTurn.assistantMessage) {
      entries.push({
        kind: "message",
        message: conversationTurn.assistantMessage,
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
    if (prompt) {
      entries.push({
        kind: "message",
        message: {
          id: `activity:${turn.key}:user`,
          role: "user",
          content: prompt,
        },
      });
    }
    entries.push({ kind: "turn", turn });
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
  const promptQueues = buildPromptQueues(conversationTurns);

  for (const activityTurn of turns) {
    if (!activityTurn?.hasVisibleRows) {
      continue;
    }
    const messageId = resolveActivityTurnMessageId(
      activityTurn,
      userMessageIds,
      promptQueues,
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

function resolveActivityTurnMessageId(
  activityTurn: ActivityTurnViewModel,
  userMessageIds: Set<string>,
  promptQueues: Map<string, string[]>,
): string | null {
  if (userMessageIds.has(activityTurn.key)) {
    return activityTurn.key;
  }

  const promptKey = normalizePrompt(activityTurn.userPrompt);
  const promptMatch = promptKey
    ? promptQueues.get(promptKey)?.shift()
    : undefined;
  if (promptMatch) {
    return promptMatch;
  }

  return null;
}

function buildPromptQueues(
  conversationTurns: ReturnType<typeof buildConversationTurns>,
): Map<string, string[]> {
  const queues = new Map<string, string[]>();
  for (const conversationTurn of conversationTurns) {
    const message = conversationTurn.userMessage;
    if (!message) {
      continue;
    }
    const promptKey = normalizePrompt(message.content);
    if (!promptKey) {
      continue;
    }
    queues.set(promptKey, [...(queues.get(promptKey) ?? []), message.id]);
  }
  return queues;
}

function normalizePrompt(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .replace(/@(?=\S)/g, "")
      .replace(/\s+/g, " ") ?? ""
  );
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
