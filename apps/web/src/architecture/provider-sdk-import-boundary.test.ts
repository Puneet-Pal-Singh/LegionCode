import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(process.cwd(), "src");
const SDK_IMPORT_PATH = "@repo/platform-client-sdk";
const ALLOWED_IMPORT_FILES = new Set([
  "services/api/providerClient.ts",
  "services/api/lifecycleClient.ts",
  "components/chat/workflow/CanonicalWorkflowSurface.tsx",
  "services/lifecycle/LifecycleProjection.ts",
  "components/chat/ChatInputBar.tsx",
  "components/chat/ChatInterface.tsx",
  "components/chat/ContextWindowIndicator.tsx",
  "components/chat/chat-interface/ChatComposerControls.tsx",
  "hooks/useActiveTurnProjection.ts",
  "components/chat/chat-interface/useApprovalController.ts",
  "components/chat/context/ContextDetailsPanel.tsx",
  "components/chat/messageMetadata.ts",
  "components/layout/workspace/useWorkspaceState.ts",
  "hooks/useChatCore.ts",
  "hooks/useConversationLifecycleProjections.ts",
  "hooks/useTurnLifecycleProjection.ts",
]);

describe("Architecture Boundary: Provider SDK import ownership", () => {
  it("allows the provider API and canonical workflow projection boundaries", () => {
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
