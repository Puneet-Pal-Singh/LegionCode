/**
 * Provider SDK retries are disabled at the adapter boundary.
 *
 * Coding turns carry a large system prompt and tool schema set. Retrying that
 * payload invisibly multiplies token-per-minute usage and hides attempt
 * identity from the runtime lifecycle. Retry policy belongs to the runtime,
 * where every attempt can be budgeted, cancelled, and audited.
 */
export const PROVIDER_SDK_MAX_RETRIES = 0;
