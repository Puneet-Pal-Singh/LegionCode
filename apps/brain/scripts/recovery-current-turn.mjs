/** Select a current turn only when the whole-session latest prompt is proven. */
export function selectRecoverableCurrentTurn(admissions, latestUserPromptSequence) {
  if (latestUserPromptSequence === null || latestUserPromptSequence === undefined) return null;
  const matches = admissions.filter((admission) =>
    admission.promptSequence === String(latestUserPromptSequence) &&
    admission.isProvenCurrentTurn === true,
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve the newest user prompt only when every prompt has an ordered part and
 * there is a single latest prompt. A partless row or sequence tie makes the
 * current turn unknowable for the whole session.
 */
export function resolveLatestUserPromptSequence(promptRows) {
  if (promptRows.length === 0) return { sequence: null, uncertain: false };
  const sequences = promptRows.map((row) => row.prompt_sequence == null ? null : String(row.prompt_sequence));
  if (sequences.some((sequence) => sequence === null)) return { sequence: null, uncertain: true };
  let latest;
  try {
    latest = sequences.reduce((max, sequence) => BigInt(sequence) > max ? BigInt(sequence) : max, BigInt(sequences[0]));
  } catch {
    return { sequence: null, uncertain: true };
  }
  const latestMatches = sequences.filter((sequence) => BigInt(sequence) === latest).length;
  if (latestMatches !== 1) return { sequence: null, uncertain: true };
  return { sequence: latest.toString(), uncertain: false };
}

export function recoveryCheckpointCurrentTurnMatches(actualCurrentTurnId, expectedCurrentTurnId, checkpointCurrentTurnId) {
  return actualCurrentTurnId === expectedCurrentTurnId && checkpointCurrentTurnId === expectedCurrentTurnId;
}

/** Immutable ownership and identity evidence that must remain fresh at apply. */
export function recoveryProofShape(session) {
  return {
    taskOwnerMatches: session.taskOwnerMatches,
    activeRunId: session.activeRunId,
    latestUserPromptSequence: session.latestUserPromptSequence,
    latestPromptUncertain: session.latestPromptUncertain,
    identityCandidates: session.identityCandidates,
    verifiedExactTuples: session.verifiedExactTuples,
    unverifiableIdentityCandidates: session.unverifiableIdentityCandidates,
    importedAdmissions: session.importedAdmissions,
    recoveredCurrentTurnId: session.recoveredCurrentTurnId,
    conflicts: session.conflicts,
  };
}
