/** Byte budgets shared by the Worker transport and Node bridge composition.
 * A 1 MiB canonical string can occupy 6 MiB when JSON escapes control characters.
 * Validate the complete encoded envelope before journaling or dispatching a command.
 */
export const CLOUD_HARNESS_BRIDGE_LIMITS = Object.freeze({
  maxFrameBytes: 16 * 1024 * 1024,
  maxPendingBytes: 32 * 1024 * 1024,
  maxPendingFrames: 64,
});

export function assertCloudHarnessBridgeFrame(frame: string): void {
  if (
    frame.length > CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes ||
    new TextEncoder().encode(frame).byteLength >
      CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes
  ) {
    throw new Error("Private harness bridge frame exceeds the size limit");
  }
}

/** This check must precede external side effects. Oversized facts stay unacknowledged;
 * the host must backpressure/quiesce explicitly, never truncate or drop them.
 * Canonical schemas still validate the value; this helper only enforces wire size.
 */
export function encodeCloudHarnessBridgeFrame(value: unknown): string {
  let frame: string | undefined;
  try {
    frame = JSON.stringify(value);
  } catch {
    throw new Error("Private harness bridge frame encoding failed");
  }
  if (frame === undefined) {
    throw new Error("Private harness bridge frame encoding failed");
  }
  assertCloudHarnessBridgeFrame(frame);
  return frame;
}
