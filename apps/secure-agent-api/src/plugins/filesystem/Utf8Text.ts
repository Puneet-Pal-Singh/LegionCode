const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
  suffix: string,
): { value: string; truncated: boolean } {
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }

  const encodedSuffix = encoder.encode(suffix);
  const contentLimit = Math.max(0, maxBytes - encodedSuffix.byteLength);
  const content = new TextDecoder().decode(encoded.slice(0, contentLimit), {
    stream: true,
  });
  return { value: `${content}${suffix}`, truncated: true };
}
