/** Investigation pin; host admission must verify the installed version before use. */
export const codexRuntime = Object.freeze({
  version: "0.167.0",
  transport: "codex-app-server-stdio",
  schemaSha256:
    "021462a9bacd117f4cd40c256a4888619d059cec6a65b795198d521ba660e554",
  linuxX64BinarySha256:
    "cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda",
  npmPackage: "@openai/codex@0.167.0-linux-x64",
  npmIntegrity:
    "sha512-FNc7danfUng9Sp6w+Fh7kofNHHZpA6VMyNKWsWrS3OwHly69gywTWeiuwrUPXpJSho8Df4xqRsHfHRPzj7zYQg==",
  // No cross-version resume compatibility is asserted by this transport checkpoint.
  resumeCompatibility: "exact-version-and-schema-only",
  experimentalApi: false,
} as const);
