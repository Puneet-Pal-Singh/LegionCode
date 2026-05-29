export function buildAdmissionScopeFingerprint(request: Request): string {
  const cfIp = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  const forwarded = request.headers.get("X-Forwarded-For")?.trim() ?? "";
  const userAgent = request.headers.get("User-Agent")?.trim().toLowerCase() ?? "";
  const ip = firstForwardedIp(forwarded) || cfIp || "unknown-ip";
  return hashScopeFingerprintSeed(`${ip}|${userAgent || "unknown-ua"}`);
}

function firstForwardedIp(forwarded: string): string {
  if (forwarded.length === 0) {
    return "";
  }
  return forwarded.split(",")[0]?.trim() ?? "";
}

function hashScopeFingerprintSeed(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fp-${(hash >>> 0).toString(36)}`;
}
