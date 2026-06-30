import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUIRED_CAPABILITIES = [
  "session-reload",
  "live-workflow-projection",
  "prompt-terminal-state",
  "multi-file-review",
  "approval-continuation",
  "runtime-artifact-recovery",
  "git-status-diff",
];

const CAPABILITIES = [
  {
    id: "session-reload",
    owner: "@shadowbox/web",
    requiredTests: [
      [
        "apps/web/src/hooks/useChatHydration.test.tsx",
        "preserves transcript activity parts on hydrated assistant messages",
      ],
      [
        "apps/web/src/hooks/useChatPersistence.test.tsx",
        "does not replay a claimed pending query after switching scopes",
      ],
      [
        "apps/brain/src/services/PersistenceService.test.ts",
        "appends assistant turns for distinct user turns on the same run",
      ],
      [
        "apps/brain/src/runtime/RunEngineResponsePersistence.test.ts",
        "uses the latest user event as the assistant turn id when activity is empty",
      ],
      [
        "packages/platform-client-sdk/src/providers/cross-client-lifecycle-parity.test.ts",
        "keeps lifecycle outputs and request sequence aligned across web and cloud transports",
      ],
    ],
    commands: [
      [
        "pnpm",
        "--filter",
        "@shadowbox/web",
        "test",
        "--",
        "src/hooks/useChatHydration.test.tsx",
        "src/hooks/useChatPersistence.test.tsx",
        "src/services/__tests__/SessionStateService.test.ts",
      ],
      [
        "pnpm",
        "--filter",
        "@shadowbox/brain",
        "test",
        "--",
        "src/services/PersistenceService.test.ts",
        "src/runtime/RunEngineResponsePersistence.test.ts",
      ],
      [
        "pnpm",
        "--filter",
        "@repo/platform-client-sdk",
        "test",
        "--",
        "src/providers/cross-client-lifecycle-parity.test.ts",
      ],
    ],
  },
  {
    id: "live-workflow-projection",
    owner: "@shadowbox/web",
    requiredTests: [
      [
        "apps/web/src/components/chat/ChatInterface.test.tsx",
        "keeps activity polling alive while the run controller is stoppable",
      ],
      [
        "apps/web/src/components/chat/chat-interface/useActivityPresentation.test.tsx",
        "projects active thinking and elapsed time from canonical event timestamps",
      ],
      [
        "apps/web/src/services/activity/TranscriptActivityParts.test.ts",
        "prefers active live canonical activity over settled transcript rows",
      ],
      [
        "apps/web/src/hooks/useChatHydration.test.tsx",
        "collapses adjacent canonical and live user prompts with different ids",
      ],
    ],
    commands: [
      [
        "pnpm",
        "--filter",
        "@shadowbox/web",
        "test",
        "--",
        "src/components/chat/ChatInterface.test.tsx",
        "src/components/chat/chat-interface/useActivityPresentation.test.tsx",
        "src/services/activity/TranscriptActivityParts.test.ts",
        "src/hooks/useChatHydration.test.tsx",
      ],
    ],
  },
  {
    id: "prompt-terminal-state",
    owner: "@shadowbox/execution-engine",
    requiredTests: [
      [
        "packages/execution-engine/src/runtime/engine/RunEngine.test.ts",
        "persists completed build-mode runs before emitting terminal events",
      ],
      [
        "packages/execution-engine/src/runtime/engine/RunEngine.test.ts",
        "uses deterministic failed-tool final summary contract when enabled",
      ],
      [
        "packages/execution-engine/src/runtime/engine/RunEngine.test.ts",
        "keeps a run cancelled when approval waiting is interrupted by user cancellation",
      ],
      [
        "packages/execution-engine/src/runtime/engine/RunEngine.test.ts",
        "records interrupted terminal summary message on cancel when contract is enabled",
      ],
      [
        "apps/web/src/services/lifecycle/LifecycleTerminalViewModel.test.ts",
        "renders terminal failure content from canonical terminal projection",
      ],
    ],
    commands: [
      [
        "pnpm",
        "--filter",
        "@shadowbox/execution-engine",
        "test",
        "--",
        "src/runtime/engine/RunEngine.test.ts",
        "-t",
        [
          "persists completed build-mode runs before emitting terminal events",
          "uses deterministic failed-tool final summary contract when enabled",
          "keeps a run cancelled when approval waiting is interrupted by user cancellation",
          "records interrupted terminal summary message on cancel when contract is enabled",
        ].join("|"),
      ],
      [
        "pnpm",
        "--filter",
        "@shadowbox/web",
        "test",
        "--",
        "src/services/lifecycle/LifecycleTerminalViewModel.test.ts",
      ],
    ],
  },
  {
    id: "multi-file-review",
    owner: "@shadowbox/web",
    requiredTests: [
      [
        "apps/web/src/components/git/GitReviewContext.test.tsx",
        "refetches the saved edit diff after switching scopes away and back",
      ],
      [
        "apps/web/src/components/git/GitReviewContext.test.tsx",
        "preserves every changed file in a multi-file live review",
      ],
    ],
    commands: [
      [
        "pnpm",
        "--filter",
        "@shadowbox/web",
        "test",
        "--",
        "src/components/git/GitReviewContext.test.tsx",
      ],
    ],
  },
  {
    id: "approval-continuation",
    owner: "@repo/runtime-kernel",
    requiredTests: [
      [
        "packages/runtime-kernel/src/approval-flow.characterization.test.ts",
        "records request and decision before retrying the exact worker call",
      ],
      [
        "packages/execution-engine/src/runtime/engine/RunEngine.test.ts",
        "waits for approval and resumes tool execution after approval is resolved",
      ],
    ],
    commands: [
      [
        "pnpm",
        "--filter",
        "@repo/runtime-kernel",
        "test",
        "--",
        "src/approval-flow.characterization.test.ts",
        "src/RuntimeKernel.integration.test.ts",
      ],
      [
        "pnpm",
        "--filter",
        "@shadowbox/execution-engine",
        "test",
        "--",
        "src/runtime/engine/RunEngine.test.ts",
        "-t",
        "waits for approval and resumes tool execution after approval is resolved",
      ],
    ],
  },
  {
    id: "runtime-artifact-recovery",
    owner: "@shadowbox/execution-engine",
    requiredTests: [
      [
        "packages/execution-engine/src/runtime/engine/RunEngine.test.ts",
        "does not replay persisted workspace edits when bootstrap recreates the repo",
      ],
      [
        "packages/execution-engine/tests/integration/artifact-store.test.ts",
        "deletes run artifacts correctly",
      ],
    ],
    commands: [
      [
        "pnpm",
        "--filter",
        "@shadowbox/execution-engine",
        "test",
        "--",
        "src/runtime/engine/RunEngine.test.ts",
        "-t",
        "does not replay persisted workspace edits when bootstrap recreates the repo",
      ],
      [
        "pnpm",
        "--filter",
        "@shadowbox/execution-engine",
        "test",
        "--",
        "tests/integration/artifact-store.test.ts",
      ],
    ],
  },
  {
    id: "git-status-diff",
    owner: "@repo/git-service",
    requiredTests: [
      [
        "packages/git-service/src/GitService.test.ts",
        "runs read-only porcelain-v2 status through the executor",
      ],
      [
        "packages/git-service/src/GitService.test.ts",
        "runs canonical diff with optional staged mode and explicit paths",
      ],
      [
        "apps/web/src/lib/git-client.test.ts",
        "requests git diff through the canonical Brain endpoint",
      ],
    ],
    commands: [
      [
        "pnpm",
        "--filter",
        "@repo/git-service",
        "test",
        "--",
        "src/GitService.test.ts",
      ],
      [
        "pnpm",
        "--filter",
        "@shadowbox/web",
        "test",
        "--",
        "src/lib/git-client.test.ts",
        "src/hooks/useGitStatus.test.tsx",
      ],
    ],
  },
];

function validateRegistry() {
  const ids = CAPABILITIES.map(({ id }) => id);
  const missing = REQUIRED_CAPABILITIES.filter((id) => !ids.includes(id));
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const invalid = CAPABILITIES.filter(
    ({ owner, requiredTests, commands }) =>
      owner.length === 0 || requiredTests.length === 0 || commands.length === 0,
  );

  if (missing.length > 0 || duplicates.length > 0 || invalid.length > 0) {
    throw new Error(
      `Invalid capability registry: missing=${missing.join(",") || "none"} ` +
        `duplicates=${duplicates.join(",") || "none"} ` +
        `invalid=${invalid.map(({ id }) => id).join(",") || "none"}`,
    );
  }
}

function validateRequiredTests(capabilities) {
  const missing = [];
  for (const capability of capabilities) {
    for (const [file, testName] of capability.requiredTests) {
      const source = readFileSync(file, "utf8");
      if (
        !source.includes(`"${testName}"`) &&
        !source.includes(`'${testName}'`)
      ) {
        missing.push(`${capability.id}: ${file} -> ${testName}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing capability regression tests:\n${missing.join("\n")}`,
    );
  }
}

function selectCapabilities(requested) {
  if (requested.length === 0) {
    return CAPABILITIES;
  }

  const selected = CAPABILITIES.filter(({ id }) => requested.includes(id));
  const unknown = requested.filter(
    (id) => !CAPABILITIES.some((capability) => capability.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown capabilities: ${unknown.join(", ")}`);
  }
  return selected;
}

function runCommand(command) {
  const normalizedCommand = normalizePackageManagerCommand(command);
  console.log(`[capability-preservation] ${normalizedCommand.join(" ")}`);
  const result = spawnSync(normalizedCommand[0], normalizedCommand.slice(1), {
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function normalizePackageManagerCommand(command) {
  if (command[0] !== "pnpm") {
    return command;
  }
  return ["corepack", "pnpm", ...command.slice(1)];
}

validateRegistry();

const requestedCapabilities = process.argv
  .slice(2)
  .filter((argument) => argument !== "--");

if (requestedCapabilities.includes("--list")) {
  for (const { id, owner } of CAPABILITIES) {
    console.log(`${id}\t${owner}`);
  }
  process.exit(0);
}

const selectedCapabilities = selectCapabilities(requestedCapabilities);
validateRequiredTests(selectedCapabilities);

for (const capability of selectedCapabilities) {
  console.log(
    `[capability-preservation] Running ${capability.id} (owner: ${capability.owner})`,
  );
  for (const command of capability.commands) {
    runCommand(command);
  }
}

console.log("[capability-preservation] All selected capabilities passed.");
