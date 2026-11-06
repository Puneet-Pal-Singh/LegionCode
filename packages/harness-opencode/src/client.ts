import type { HarnessCapabilities } from "@repo/platform-protocol";

/** Support flags only; host isolation, selected credentials and release proof independently gate availability. */
export const OPENCODE_CAPABILITIES = Object.freeze({
  approvals: true,
  questions: false,
  steer: false,
  resume: false,
  fork: false,
  images: false,
  terminal: false,
  contextTelemetry: false,
  accountQuota: false,
  experimental: true,
} satisfies HarnessCapabilities);
