import { SessionStateService } from "../services/SessionStateService";

const BRANCH_PREFERENCE_PREFIX = "legioncode:session-branch-preference:";

interface SessionBranchPreference {
  fullName: string;
  branch: string;
}

export function loadSessionBranchPreference(
  sessionId: string,
  canonicalFullName: string,
): string | null {
  try {
    const stored = localStorage.getItem(`${BRANCH_PREFERENCE_PREFIX}${sessionId}`);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<SessionBranchPreference>;
      if (parsed.fullName === canonicalFullName && isBranch(parsed.branch)) {
        return parsed.branch;
      }
    }
  } catch {
    // A malformed UI preference cannot override the server workspace context.
  }

  const legacy = SessionStateService.loadSessionGitHubContext(sessionId);
  return legacy?.fullName === canonicalFullName && isBranch(legacy.branch)
    ? legacy.branch
    : null;
}

export function saveSessionBranchPreference(
  sessionId: string,
  canonicalFullName: string,
  branch: string,
): void {
  if (!canonicalFullName || !isBranch(branch)) return;
  try {
    localStorage.setItem(
      `${BRANCH_PREFERENCE_PREFIX}${sessionId}`,
      JSON.stringify({ fullName: canonicalFullName, branch }),
    );
  } catch {
    // The server workspace selection remains authoritative when storage is unavailable.
  }
}

function isBranch(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
