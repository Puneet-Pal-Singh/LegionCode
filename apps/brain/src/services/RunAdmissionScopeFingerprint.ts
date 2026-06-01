export async function buildAdmissionScopeFingerprint(
  request: Request,
): Promise<string> {
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

async function hashScopeFingerprintSeed(seed: string): Promise<string> {
  const bytes = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `fp-${hex}`;
}
