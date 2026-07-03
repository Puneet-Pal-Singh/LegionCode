import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";

export interface LifecycleEventStreamPort {
  start(turnId: string): void;
  emit(event: LifecycleEvent): void;
  complete(turnId: string): void;
  getStream(
    turnId: string,
    afterSequence: number | null,
  ): ReadableStream<Uint8Array>;
}
