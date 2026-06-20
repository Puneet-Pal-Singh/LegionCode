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
  const conversationUserTurns = conversationTurns.filter(
    (
      turn,
    ): turn is ReturnType<typeof buildConversationTurns>[number] & {
      userMessage: Message;
    } => Boolean(turn.userMessage),
  );
  const availableConversationTurnIndexes = new Set(
    conversationUserTurns.map((_, index) => index),
  );

  for (
    let activityIndex = turns.length - 1;
    activityIndex >= 0;
    activityIndex -= 1
  ) {
    const activityTurn = turns[activityIndex];
    if (!activityTurn?.hasVisibleRows) {
      continue;
    }

    const matchedIndex = findMatchingConversationTurnIndex(
      conversationUserTurns,
      availableConversationTurnIndexes,
      activityTurn.userPrompt,
    );
    if (matchedIndex === null) {
      if (logUnmatched) {
        warnUnmatchedActivityTurn(options.runId, activityTurn.key);
      }
      continue;
    }

    const matchedConversationTurn = conversationUserTurns[matchedIndex];
    if (!matchedConversationTurn) {
      console.warn(
        "[chat/transcript] Activity turn matched an unavailable user message index.",
        {
          activityTurnKey: activityTurn.key,
          matchedIndex,
          runId: options.runId,
        },
      );
      availableConversationTurnIndexes.delete(matchedIndex);
      continue;
    }

    availableConversationTurnIndexes.delete(matchedIndex);
    const existingAssignments =
      assignments.get(matchedConversationTurn.userMessage.id) ?? [];
    existingAssignments.unshift(activityTurn);
    assignments.set(
      matchedConversationTurn.userMessage.id,
      existingAssignments,
    );
  }

  return assignments;
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

function findMatchingConversationTurnIndex(
  conversationTurns: Array<
    ReturnType<typeof buildConversationTurns>[number] & { userMessage: Message }
  >,
  availableConversationTurnIndexes: Set<number>,
  userPrompt: string | null,
): number | null {
  const normalizedUserPrompt = normalizePromptForMatching(userPrompt);
  if (!normalizedUserPrompt) {
    return null;
  }

  const fuzzyMatches: number[] = [];
  for (let index = conversationTurns.length - 1; index >= 0; index -= 1) {
    if (!availableConversationTurnIndexes.has(index)) {
      continue;
    }
    const conversationPrompt = normalizePromptForMatching(
      conversationTurns[index]?.userMessage.content,
    );
    if (conversationPrompt === normalizedUserPrompt) {
      return index;
    }
    if (arePromptsFuzzyMatch(conversationPrompt, normalizedUserPrompt)) {
      fuzzyMatches.push(index);
    }
  }

  if (fuzzyMatches.length === 0) {
    return null;
  }

  return (
    fuzzyMatches.sort(
      (a, b) =>
        Math.abs(a - conversationTurns.length) -
        Math.abs(b - conversationTurns.length),
    )[0] ?? null
  );
}

function normalizePromptForMatching(
  content: string | null | undefined,
): string {
  if (typeof content !== "string") {
    return "";
  }

  return content
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/@(?=[\w./-])/g, "")
    .replace(/\s+/g, " ");
}

function arePromptsFuzzyMatch(left: string, right: string): boolean {
  if (left.length < 12 || right.length < 12) {
    return false;
  }
  if (left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftTokens = tokenizePrompt(left);
  const rightTokens = tokenizePrompt(right);
  if (leftTokens.size < 3 || rightTokens.size < 3) {
    return false;
  }

  let sharedTokenCount = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      sharedTokenCount += 1;
    }
  }

  const overlapRatio =
    sharedTokenCount / Math.max(leftTokens.size, rightTokens.size);
  return overlapRatio >= 0.8;
}

function tokenizePrompt(prompt: string): Set<string> {
  return new Set(
    prompt
      .split(/[^a-z0-9./-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}
