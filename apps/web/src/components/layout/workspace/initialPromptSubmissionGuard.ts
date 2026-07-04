const CLAIM_PREFIX = "legioncode:initial-prompt-submission:";
const claimedSubmissionIds = new Set<string>();

export function claimInitialPromptSubmission(id: string): boolean {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return false;
  }
  if (claimedSubmissionIds.has(normalizedId)) {
    return false;
  }

  const storageKey = buildClaimKey(normalizedId);
  if (isSessionClaimed(storageKey)) {
    claimedSubmissionIds.add(normalizedId);
    return false;
  }

  claimedSubmissionIds.add(normalizedId);
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
