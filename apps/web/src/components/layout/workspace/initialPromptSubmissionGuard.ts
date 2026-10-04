import type { InitialPromptSubmissionId } from "../../../lib/initial-prompt-submission";

const CLAIM_PREFIX = "legioncode:initial-prompt-submission:";
const FAILED_PREFIX = `${CLAIM_PREFIX}failed:`;
const claimedSubmissionIds = new Set<InitialPromptSubmissionId>();
const failedSubmissionIds = new Set<InitialPromptSubmissionId>();

export function claimInitialPromptSubmission(
  id: InitialPromptSubmissionId,
): boolean {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return false;
  }
  if (claimedSubmissionIds.has(id)) {
    return false;
  }

  const storageKey = buildClaimKey(normalizedId);
  if (isSessionClaimed(storageKey)) {
    claimedSubmissionIds.add(id);
    return false;
  }

  claimedSubmissionIds.add(id);
  writeSessionClaim(storageKey);
  return true;
}

export function releaseInitialPromptSubmissionClaim(
  id: InitialPromptSubmissionId,
): void {
  claimedSubmissionIds.delete(id);
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(buildClaimKey(id.trim()));
  }
}

export function markInitialPromptSubmissionFailed(
  id: InitialPromptSubmissionId,
): void {
  failedSubmissionIds.add(id);
  writeSessionClaim(buildFailedKey(id.trim()));
}

export function isInitialPromptSubmissionFailed(
  id: InitialPromptSubmissionId,
): boolean {
  return failedSubmissionIds.has(id) || isSessionClaimed(buildFailedKey(id.trim()));
}

export function clearInitialPromptSubmissionFailure(
  id: InitialPromptSubmissionId,
): void {
  failedSubmissionIds.delete(id);
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(buildFailedKey(id.trim()));
  }
}

export function clearInitialPromptSubmissionClaimsForTests(): void {
  claimedSubmissionIds.clear();
  failedSubmissionIds.clear();
  if (typeof window === "undefined") {
    return;
  }

  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith(CLAIM_PREFIX)) {
      window.sessionStorage.removeItem(key);
    }
  }
}

function buildClaimKey(id: string): string {
  return `${CLAIM_PREFIX}${id}`;
}

function buildFailedKey(id: string): string {
  return `${FAILED_PREFIX}${id}`;
}

function isSessionClaimed(key: string): boolean {
  return (
    typeof window !== "undefined" && window.sessionStorage.getItem(key) === "1"
  );
}

function writeSessionClaim(key: string): void {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(key, "1");
  }
}
