import { HostedTargetSchema } from "../shared/hosted-account";

declare const __LEGIONCODE_DESKTOP_HOSTED_TARGET__: string;

/** Closed build targets. Main never accepts a URL or target override from a renderer. */
export const DESKTOP_HOSTED_TARGETS = Object.freeze({
  production: Object.freeze({
    target: "production" as const,
    brainOrigin: "https://brain.legioncode.dev",
    frontendOrigin: "https://legioncode.dev",
    partition: "persist:legioncode-hosted-production-v1",
  }),
  development: Object.freeze({
    target: "development" as const,
    brainOrigin: "https://brain-dev.legioncode.dev",
    frontendOrigin: "https://legioncode-web-dev.pages.dev",
    partition: "persist:legioncode-hosted-development-v1",
  }),
});

// Uncompiled fixture imports retain the release default; packaged Main receives a fixed literal.
const target = HostedTargetSchema.parse(
  typeof __LEGIONCODE_DESKTOP_HOSTED_TARGET__ === "undefined"
    ? "production"
    : __LEGIONCODE_DESKTOP_HOSTED_TARGET__,
);
export const DESKTOP_HOSTED_TARGET = DESKTOP_HOSTED_TARGETS[target];
