import type { CoreMessage } from "ai";

/** Own provider-message data before waiting on the admitted kernel. */
export function captureLocalTurnInputMessage(message: CoreMessage): CoreMessage {
  return captureValue(message, new WeakMap<object, unknown>()) as CoreMessage;
}

function captureValue(value: unknown, captured: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol")
      throw new TypeError("Native input contains unsupported provider message data");
    return value;
  }
  if (captured.has(value)) return captured.get(value);
  if (value instanceof URL) {
    const copy = new URL(value.href);
    captured.set(value, copy);
    return copy;
  }
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value);
    captured.set(value, copy);
    return copy;
  }
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    captured.set(value, copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    captured.set(value, copy);
    for (const item of value) copy.push(captureValue(item, captured));
    return copy;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Native input contains unsupported provider message data");
  const copy: Record<string, unknown> = {};
  captured.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: captureValue(item, captured), enumerable: true, writable: true, configurable: true,
    });
  }
  return copy;
}
