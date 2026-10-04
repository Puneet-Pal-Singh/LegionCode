import assert from "node:assert/strict";
import test from "node:test";
import {
  recoveryCheckpointCurrentTurnMatches,
  recoveryProofShape,
  resolveLatestUserPromptSequence,
  selectRecoverableCurrentTurn,
} from "./recovery-current-turn.mjs";

test("a terminal older verified turn is not current when a newer prompt is unverified", () => {
  const admissions = [{ turnId: "old-terminal", promptSequence: "4", isProvenCurrentTurn: true }];
  assert.equal(selectRecoverableCurrentTurn(admissions, "9"), null);
});

test("an exact active tuple is current only for the whole-session latest prompt", () => {
  const admissions = [
    { turnId: "old-active", promptSequence: "4", isProvenCurrentTurn: true },
    { turnId: "latest-active", promptSequence: "9", isProvenCurrentTurn: true },
  ];
  assert.equal(selectRecoverableCurrentTurn(admissions, "9")?.turnId, "latest-active");
});

test("ambiguous tuples at the latest prompt do not set the current turn", () => {
  const admissions = [
    { turnId: "candidate-a", promptSequence: "9", isProvenCurrentTurn: true },
    { turnId: "candidate-b", promptSequence: "9", isProvenCurrentTurn: true },
  ];
  assert.equal(selectRecoverableCurrentTurn(admissions, "9"), null);
});

test("a user prompt without parts makes the latest sequence unknown", () => {
  assert.deepEqual(resolveLatestUserPromptSequence([
    { prompt_sequence: "4", part_count: 1 },
    { prompt_sequence: null, part_count: 0 },
  ]), { sequence: null, uncertain: true });
});

test("tied latest prompt sequences are ambiguous", () => {
  assert.deepEqual(resolveLatestUserPromptSequence([
    { prompt_sequence: "4", part_count: 1 },
    { prompt_sequence: "9", part_count: 1 },
    { prompt_sequence: "9", part_count: 2 },
  ]), { sequence: null, uncertain: true });
});

test("a unique latest prompt sequence is selected, and an empty session stays empty", () => {
  assert.deepEqual(resolveLatestUserPromptSequence([
    { prompt_sequence: "4", part_count: 1 },
    { prompt_sequence: "19", part_count: 2 },
  ]), { sequence: "19", uncertain: false });
  assert.deepEqual(resolveLatestUserPromptSequence([]), { sequence: null, uncertain: false });
});

test("checkpoint reapply requires the planned current turn and rejects unexpected targets", () => {
  assert.equal(recoveryCheckpointCurrentTurnMatches("turn-a", "turn-a", "turn-a"), true);
  assert.equal(recoveryCheckpointCurrentTurnMatches(null, null, null), true);
  assert.equal(recoveryCheckpointCurrentTurnMatches("turn-b", "turn-a", "turn-a"), false);
  assert.equal(recoveryCheckpointCurrentTurnMatches("turn-a", "turn-a", "turn-b"), false);
  assert.equal(recoveryCheckpointCurrentTurnMatches(null, null, undefined), false);
});

test("freshness proof changes when task ownership invalidates an exact tuple", () => {
  const dryRun = {
    taskOwnerMatches: true,
    activeRunId: "run-1",
    latestUserPromptSequence: "19",
    latestPromptUncertain: false,
    identityCandidates: 1,
    verifiedExactTuples: 1,
    unverifiableIdentityCandidates: 0,
    importedAdmissions: [{ threadId: "thread-1", turnId: "turn-1", runAttemptId: "attempt-1", promptSequence: "19" }],
    recoveredCurrentTurnId: "turn-1",
    conflicts: [],
  };
  const changedOwnership = { ...dryRun, taskOwnerMatches: false, importedAdmissions: [], verifiedExactTuples: 0, recoveredCurrentTurnId: null };
  assert.notDeepEqual(recoveryProofShape(dryRun), recoveryProofShape(changedOwnership));
});

test("freshness proof includes exact admissions and current-turn target", () => {
  const initial = {
    taskOwnerMatches: true,
    activeRunId: null,
    latestUserPromptSequence: "19",
    latestPromptUncertain: false,
    identityCandidates: 1,
    verifiedExactTuples: 1,
    unverifiableIdentityCandidates: 0,
    importedAdmissions: [{ threadId: "thread-1", turnId: "turn-1", runAttemptId: "attempt-1" }],
    recoveredCurrentTurnId: "turn-1",
    conflicts: [],
  };
  assert.notDeepEqual(recoveryProofShape(initial), recoveryProofShape({ ...initial, importedAdmissions: [] }));
  assert.notDeepEqual(recoveryProofShape(initial), recoveryProofShape({ ...initial, recoveredCurrentTurnId: null }));
});
