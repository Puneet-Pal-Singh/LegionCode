export const PACKAGE_DEPENDENCY_POLICY = {
  "@repo/artifact-store": ["@repo/platform-protocol"],
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
  "@repo/runtime-cloudflare-worker": [
    "@repo/artifact-store",
    "@repo/git-service",
    "@repo/platform-protocol",
    "@repo/worker-protocol",
  ],
  "@repo/worker-protocol": ["@repo/artifact-store", "@repo/platform-protocol"],
  "@repo/workspace-core": ["@repo/platform-protocol"],
};

export const APP_IMPORT_POLICY = {
  "@shadowbox/brain": [
    "@repo/observability",
    "@repo/persistence",
    "@repo/platform-protocol",
    "@repo/provider-core",
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
    symbol: "CodingToolRegistry",
    owner: "packages/execution-engine/src/runtime/tools/CodingToolRegistry.ts",
    declaration: /\bclass\s+CodingToolRegistry\s*\{/,
  },
  {
    symbol: "ArtifactStore",
    owner: "packages/artifact-store/src/types.ts",
    declaration:
      /\b(?:interface|class)\s+ArtifactStore\s*\{|\btype\s+ArtifactStore\s*=/,
  },
  {
    symbol: "ProviderRegistry",
    owner: "packages/provider-core/src/registry.ts",
    declaration: /\bclass\s+ProviderRegistry\s*\{/,
  },
  {
    symbol: "EventStore",
    owner: "packages/event-store/src/types.ts",
    declaration:
      /\b(?:interface|class)\s+EventStore\s*\{|\btype\s+EventStore\s*=/,
  },
  {
    symbol: "GitService",
    owner: "packages/git-service/src/types.ts",
    declaration:
      /\b(?:interface|class)\s+GitService\s*\{|\btype\s+GitService\s*=/,
  },
  {
    symbol: "RuntimeKernel",
    owner: "packages/runtime-kernel/src/RuntimeKernel.ts",
    declaration:
      /\b(?:interface|class)\s+RuntimeKernel\s*\{|\btype\s+RuntimeKernel\s*=/,
  },
  {
    symbol: "WorkspaceManifestRepository",
    owner: "packages/workspace-core/src/repository.ts",
    declaration:
      /\b(?:interface|class)\s+WorkspaceManifestRepository\s*\{|\btype\s+WorkspaceManifestRepository\s*=/,
  },
  {
    symbol: "WorkerProtocolRequest",
    owner: "packages/worker-protocol/src/protocol.ts",
    declaration:
      /\b(?:interface|class)\s+WorkerProtocolRequest\s*\{|\btype\s+WorkerProtocolRequest\s*=/,
  },
  {
    symbol: "WorkerOperationName",
    owner: "packages/worker-protocol/src/common.ts",
    declaration:
      /\b(?:interface|class)\s+WorkerOperationName\s*\{|\btype\s+WorkerOperationName\s*=/,
  },
  {
    symbol: "PermissionPolicy",
    owner: "packages/permission-policy/src/types.ts",
    declaration:
      /\b(?:interface|class)\s+PermissionPolicy\s*\{|\btype\s+PermissionPolicy\s*=/,
  },
  {
    symbol: "PermissionRequest",
    owner: "packages/permission-policy/src/types.ts",
    declaration:
      /\b(?:interface|class)\s+PermissionRequest\s*\{|\btype\s+PermissionRequest\s*=/,
  },
];

export const UNIQUE_ACTION_REGISTRIES = [
  {
    name: "secure git plugin schema names",
    path: "apps/secure-agent-api/src/schemas/git.ts",
    pattern: /\bname:\s*["'](git_[A-Za-z0-9_]+)["']/g,
  },
  {
    name: "execution-engine git tool ids",
    path: "packages/execution-engine/src/runtime/tools/CodingToolRegistry.ts",
    pattern: /\bid:\s*["'](git_[A-Za-z0-9_]+)["']/g,
  },
  {
    name: "worker protocol operation names",
    path: "packages/worker-protocol/src/common.ts",
    pattern: /^\s*["']([a-z]+(?:\.[A-Za-z0-9]+)+)["'],?$/gm,
  },
];

export const DIRECT_GIT_COMMAND_POLICY = [
  {
    path: "apps/secure-agent-api/src/plugins/GitPlugin.ts",
    allowedPatterns: [
      /command:\s*["']git["'],\s*args:\s*\[\.\.\.authArgs,\s*["']clone["']/s,
      /command:\s*["']git["'],\s*args:\s*\[\s*["']-C["'],\s*worktree,\s*["']apply["'],\s*["']--check["']/s,
      /command:\s*["']git["'],\s*args:\s*\[\s*["']-C["'],\s*worktree,\s*["']apply["'],\s*patchPath\s*\]/s,
    ],
  },
];

export const POLICY_INVENTORY_PATH =
  "scripts/gates/harness-policy-inventory.json";

export const POLICY_INVENTORY_ALLOWED_CATEGORIES = [
  "approval",
  "auth-access",
  "config",
  "conversation",
  "execution-preparation",
  "finalization",
  "lifecycle",
  "memory",
  "metadata",
  "mode-intent",
  "permission",
  "provider",
  "recovery",
  "retry",
  "synthesis",
  "workspace-bootstrap",
];

export const POLICY_INVENTORY_ALLOWED_DISPOSITIONS = [
  "keep-pure-policy",
  "convert-data-config-policy",
  "convert-typed-protocol-projector",
  "delete-from-product-path",
  "quarantine-temporarily",
];

export const HARNESS_PRODUCT_PATH_GUARDS = {
  turnModePolicy: {
    forbiddenImportPattern:
      /import\s+(?!type\b)[\s\S]*?from\s+["'][^"']*RunTurnModePolicy(?:\.js)?["']/,
    allowedFiles: [],
  },
  promptIntentPolicy: {
    forbiddenImportPattern:
      /import\s+(?!type\b)[\s\S]*?from\s+["'][^"']*RunCurrentTurnIntent(?:\.js)?["']/,
    allowedFiles: [
      "packages/execution-engine/src/runtime/engine/RunCurrentTurnIntent.ts",
    ],
  },
  finalAnswerRegexRepair: {
    patterns: [
      {
        name: "final-answer scaffold literal repair",
        pattern:
          /\b(?:User says|Direct Answer|Helpful Details)\b|["'`/]Intent\s*:/,
      },
      {
        name: "leaked internal preface stripping",
        pattern:
          /\b(?:LEAKED_INTERNAL_PREFACE_PATTERNS|stripLeakedInternalPreface|stripOrphanPunctuationBeforeInternalPreface|readLeadingSentence|isLeakedInternalPrefaceSentence)\b/,
      },
      {
        name: "assistant self-talk string repair",
        pattern:
          /\b(?:sanitizeAssistantVisibleContent|stripInternalSelfTalkPrefix|stripOrphanPunctuationBeforeInternalSelfTalk|readLeadingAssistantSentence|isInternalSelfTalkSentence)\b/,
      },
    ],
    quarantinedFiles: [],
  },
  duplicateToolRegistries: {
    canonicalFiles: [
      "packages/execution-engine/src/runtime/tools/CodingToolRegistry.ts",
    ],
    quarantinedFiles: [
      {
        path: "packages/execution-engine/src/tools/ToolRegistry.ts",
        owner: "runtime-harness-stabilization",
        reason:
          "Legacy generic registry predates the runtime capability manifest/tool metadata registry and is not the product authority.",
        deletionTrigger:
          "Delete or convert in slice 036.4 when tool execution is behind the canonical registry/gateway boundary.",
        gate: "scripts/gates/check-architecture-boundaries.mjs",
      },
    ],
    declarationPattern: /\bclass\s+(?:Coding)?ToolRegistry\s*\{/,
  },
  clientSideTurnIdDerivation: {
    // The companion validator (validateClientSideTurnIdDerivation in
    // check-architecture-boundaries.mjs) only scans apps/web/src.
    // No Web product code may derive turn identity client-side; the
    // canonical turnId arrives via the X-Turn-Id response header.
    forbiddenImportPattern:
      /\b(?:turnIdFromRunId|turnSeedFromLatestUserMessage)\b/,
    allowedFiles: [],
    description:
      "Web product code must not derive turn identity client-side; use canonical server-provided turnId from the X-Turn-Id response header.",
  },
activeStateRunSummaryAuthority: {
    forbiddenImportPattern:
      /\b(?:isRunEventActivityOpen|isApprovalRequiredRunStatus|isTerminalRunStatus|normalizeRunStatus)\b/,
    allowedFiles: [
      "apps/web/src/hooks/useRunSummary.ts",
      "apps/web/src/lib/run-status.ts",
      "apps/web/src/services/activity/RunEventActivitySnapshot.ts",
      "apps/web/src/components/chat/chat-interface/useActivityPresentation.ts",
      "apps/web/src/components/chat/chat-interface/useChangedFilesController.ts",
      "apps/web/src/components/layout/Workspace.tsx",
      "apps/web/src/components/layout/workspace/runUiState.ts",
    ],
    description:
      "Active Web chat components (especially ChatInterface.tsx) must not use run-summary status helpers as turn-state authority; active workflow/thinking/approval/terminal state must come from the canonical lifecycle projection only.",
  },
};
