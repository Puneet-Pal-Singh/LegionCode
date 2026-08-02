const TURN_ID_RUN_DELIMITER = "__turn__";
const RUN_ID_PREFIX_LENGTH = "run_".length;
const MAX_TURN_SUFFIX_LENGTH = 128;
const MIN_TURN_SEED_LENGTH = 6;
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]+$/;
const TURN_ID_PATTERN = /^trn_[A-Za-z0-9_-]+$/;

export function turnIdFromRunId(runId: string, turnSeed: string): string {
  const parsedRunId = parseRunId(runId);
  const runSuffix = parsedRunId.slice(RUN_ID_PREFIX_LENGTH);
  const seed = normalizeTurnSeed(turnSeed);
  const seedLimit =
    MAX_TURN_SUFFIX_LENGTH - runSuffix.length - TURN_ID_RUN_DELIMITER.length;
  if (seedLimit < MIN_TURN_SEED_LENGTH) {
    throw new Error("Run id is too long to derive a lifecycle turn id");
  }
  return parseTurnId(
    `trn_${runSuffix}${TURN_ID_RUN_DELIMITER}${seed.slice(0, seedLimit)}`,
  );
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

function parseRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Invalid run id");
  }
  return runId;
}

function parseTurnId(turnId: string): string {
  if (!TURN_ID_PATTERN.test(turnId)) {
    throw new Error("Invalid turn id");
  }
  return turnId;
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
