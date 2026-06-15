export const PACKAGE_DEPENDENCY_POLICY = {
  "@repo/event-store": ["@repo/platform-protocol"],
  "@repo/git-service": ["@repo/platform-protocol"],
  "@repo/permission-policy": ["@repo/platform-protocol"],
  "@repo/persistence": [
    "@repo/event-store",
    "@repo/platform-protocol",
    "@repo/shared-types",
    "@repo/workspace-core",
  ],
  "@repo/platform-client-sdk": [
    "@repo/platform-protocol",
    "@repo/provider-core",
    "@repo/shared-types",
  ],
  "@repo/platform-protocol": [],
  "@repo/runtime-kernel": [
    "@repo/event-store",
    "@repo/platform-protocol",
    "@repo/workspace-core",
  ],
  "@repo/worker-protocol": ["@repo/platform-protocol"],
  "@repo/workspace-core": ["@repo/platform-protocol"],
};

export const APP_IMPORT_POLICY = {
  "@shadowbox/brain": [
    "@repo/persistence",
    "@repo/runtime-kernel",
    "@repo/shared-types",
  ],
  "@shadowbox/secure-agent-api": [
    "@repo/git-service",
    "@repo/shared-types",
    "@repo/worker-protocol",
  ],
  "@shadowbox/web": ["@repo/platform-client-sdk", "@repo/shared-types"],
};

export const CANONICAL_AUTHORITIES = [
  {
    symbol: "EventStore",
    owner: "packages/event-store/src/types.ts",
    declaration: /\b(?:interface|class)\s+EventStore\s*\{|\btype\s+EventStore\s*=/,
  },
  {
    symbol: "GitService",
    owner: "packages/git-service/src/types.ts",
    declaration: /\b(?:interface|class)\s+GitService\s*\{|\btype\s+GitService\s*=/,
  },
  {
    symbol: "RuntimeKernel",
    owner: "packages/runtime-kernel/src/RuntimeKernel.ts",
    declaration: /\b(?:interface|class)\s+RuntimeKernel\s*\{|\btype\s+RuntimeKernel\s*=/,
  },
  {
    symbol: "WorkspaceManifestRepository",
    owner: "packages/workspace-core/src/repository.ts",
    declaration: /\b(?:interface|class)\s+WorkspaceManifestRepository\s*\{|\btype\s+WorkspaceManifestRepository\s*=/,
  },
];
