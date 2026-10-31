import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(process.cwd(), "src");
const SDK_IMPORT_PATH = "@legioncode/sdk";
const ALLOWED_IMPORT_FILES = new Set([
  "services/api/appServerClient.ts",
  "services/api/artifactReads.ts",
  "services/api/sessionMetadata.ts",
  "services/api/workspaceSelection.ts",
  "services/ChatHydrationService.ts",
  "services/ChatPersistenceService.ts",
  "services/api/providerClient.ts",
  "services/api/platformClient.ts",
  "services/GitHubService.ts",
  "services/settings/HookSettingsViewModel.ts",
  "components/chat/ChatInterface.tsx",
  "components/chat/chat-interface/useReviewCommentSubmission.ts",
  "components/chat/chat-interface/ChatComposerControls.tsx",
  "components/chat/chat-interface/useChangedFilesController.ts",
  "hooks/useActiveTurnProjection.ts",
  "components/chat/chat-interface/useApprovalController.ts",
  "components/layout/workspace/useWorkspaceState.ts",
  "components/layout/workspace/useFileLoader.ts",
  "hooks/useChatCore.ts",
  "hooks/useChatPersistence.ts",
  "hooks/chat/useConversationInputCommands.ts",
  "hooks/chat/useThreadInputQueue.ts",
  "hooks/chat/submissionTransport.ts",
  "hooks/useChat.ts",
  "store/agentStore.ts",
  "App.tsx",
  "components/layout/Workspace.tsx",
  "components/settings/HooksSettingsPanel.tsx",
  "components/settings/SettingsDialog.tsx",
  "hooks/conversationScope.ts",
  "hooks/useConversationLifecycleProjections.ts",
  "hooks/useTurnLifecycleProjection.ts",
  "lib/session-sidebar-selectors.ts",
  "lib/chat-request.ts",
  "lib/provider-recovery.ts",
  "components/chat/chat-interface/TurnLifecycleStatus.tsx",
  "components/layout/workspace/runUiState.ts",
  "components/layout/SessionConversationSurface.tsx",
  "hooks/useSessionWorkspaceContext.ts",
  "hooks/useSessionPullRequests.ts",
  // UI surfaces render the canonical verified pull-request response DTO;
  // querying and transport ownership stay in useSessionPullRequests.
  "components/layout/AgentSidebar.tsx",
  "components/layout/TopNavBar.tsx",
  "components/layout/workspace/EnvironmentSummaryMenu.tsx",
  "components/navigation/TopEnvironmentSummary.tsx",
  "services/provider/ProviderStore.ts",
  "services/provider/ProviderSelectionPreferences.ts",
]);

describe("Architecture Boundary: Provider SDK import ownership", () => {
  it("allows API, transcript, and canonical workflow SDK boundaries", () => {
    const violations = collectSourceFiles(SOURCE_ROOT)
      .filter((filePath) => !isAllowedImportFile(filePath))
      .filter((filePath) => containsSdkImport(filePath))
      .map((filePath) => relative(SOURCE_ROOT, filePath));

    expect(violations).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!isSourceFile(fullPath) || isTestFile(fullPath)) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function isSourceFile(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".jsx")
  );
}

function isTestFile(filePath: string): boolean {
  return filePath.includes(".test.");
}

function isAllowedImportFile(filePath: string): boolean {
  const relativePath = relative(SOURCE_ROOT, filePath);
  return (
    ALLOWED_IMPORT_FILES.has(relativePath) ||
    relativePath.startsWith("components/chat/workflow/")
  );
}

function containsSdkImport(filePath: string): boolean {
  return readFileSync(filePath, "utf8").includes(SDK_IMPORT_PATH);
}
