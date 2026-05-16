export interface SessionRepositoryContextLike {
  fullName?: string;
  repoName?: string;
}

export function normalizeRepositoryIdentifier(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    try {
      const parsed = new URL(trimmed);
      return parsed.pathname
        .replace(/^\/+|\/+$/g, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
    } catch {
      return trimmed.replace(/\.git$/i, "").toLowerCase();
    }
  }

  return trimmed
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export function extractRepositoryName(identifier: string | null | undefined): string {
  const normalizedIdentifier = normalizeRepositoryIdentifier(identifier);
  if (!normalizedIdentifier) {
    return "";
  }

  const segments = normalizedIdentifier.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export function doesRepositorySelectionMatch(
  expectedRepository: string | null | undefined,
  actualFullName: string | null | undefined,
): boolean {
  const normalizedExpected = normalizeRepositoryIdentifier(expectedRepository);
  const normalizedActual = normalizeRepositoryIdentifier(actualFullName);

  if (!normalizedExpected) {
    return true;
  }

  if (!normalizedActual) {
    return false;
  }

  if (normalizedExpected.includes("/")) {
    return normalizedExpected === normalizedActual;
  }

  return (
    extractRepositoryName(normalizedExpected) ===
    extractRepositoryName(normalizedActual)
  );
}

export function doesSessionContextMatchRepository(
  expectedRepository: string | null | undefined,
  context: SessionRepositoryContextLike,
): boolean {
  const normalizedExpected = normalizeRepositoryIdentifier(expectedRepository);
  if (!normalizedExpected) {
    return true;
  }

  const normalizedFullName = normalizeRepositoryIdentifier(context.fullName);
  const normalizedRepoName = normalizeRepositoryIdentifier(context.repoName);

  if (normalizedExpected.includes("/")) {
    return normalizedFullName === normalizedExpected;
  }

  const expectedRepoName = extractRepositoryName(normalizedExpected);
  return (
    (normalizedRepoName.length > 0 &&
      normalizedRepoName === expectedRepoName) ||
    extractRepositoryName(normalizedFullName) === expectedRepoName
  );
}
