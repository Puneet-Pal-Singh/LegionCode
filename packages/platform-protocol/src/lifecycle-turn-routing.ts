import { RunIdSchema, TurnIdSchema, type RunId, type TurnId } from "./ids.js";

const TURN_ID_RUN_DELIMITER = "__turn__";
const TURN_ID_PREFIX_LENGTH = "trn_".length;
const RUN_ID_PREFIX_LENGTH = "run_".length;
const MAX_TURN_SUFFIX_LENGTH = 128;
const MIN_TURN_SEED_LENGTH = 6;

export function turnIdFromRunId(runId: string, turnSeed: string): TurnId {
  const parsedRunId = RunIdSchema.parse(runId);
  const runSuffix = parsedRunId.slice(RUN_ID_PREFIX_LENGTH);
  const seed = normalizeTurnSeed(turnSeed);
  const seedLimit =
    MAX_TURN_SUFFIX_LENGTH - runSuffix.length - TURN_ID_RUN_DELIMITER.length;
  if (seedLimit < MIN_TURN_SEED_LENGTH) {
    throw new Error("Run id is too long to derive a lifecycle turn id");
  }
  return TurnIdSchema.parse(
    `trn_${runSuffix}${TURN_ID_RUN_DELIMITER}${seed.slice(0, seedLimit)}`,
  );
}

export function runIdFromTurnId(turnId: string): RunId {
  const turnSuffix = TurnIdSchema.parse(turnId).slice(TURN_ID_PREFIX_LENGTH);
  const delimiterIndex = turnSuffix.indexOf(TURN_ID_RUN_DELIMITER);
  if (delimiterIndex <= 0) {
    throw new Error("Lifecycle turn id is missing run routing segment");
  }
  return RunIdSchema.parse(`run_${turnSuffix.slice(0, delimiterIndex)}`);
}

export function turnSeedFromLatestUserMessage(
  messages: readonly { role?: unknown; id?: unknown }[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    return typeof message.id === "string" && message.id.trim()
      ? message.id
      : `message-${index}`;
  }
  return "message-0";
}

function normalizeTurnSeed(turnSeed: string): string {
  const normalized = turnSeed
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length >= MIN_TURN_SEED_LENGTH
    ? normalized
    : `${normalized}000000`.slice(0, MIN_TURN_SEED_LENGTH);
}
