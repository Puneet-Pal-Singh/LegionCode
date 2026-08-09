import type { InitialPromptSubmissionId } from "../../../lib/initial-prompt-submission";

const CLAIM_PREFIX = "legioncode:initial-prompt-submission:";
const claimedSubmissionIds = new Set<InitialPromptSubmissionId>();

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

export function clearInitialPromptSubmissionClaimsForTests(): void {
  claimedSubmissionIds.clear();
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
