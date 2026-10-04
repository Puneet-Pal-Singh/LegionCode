import { _electron as electron, expect, test } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";

const releaseDirectory = fileURLToPath(new URL("../release", import.meta.url));
const execFile = promisify(execFileCallback);

async function findPackagedExecutable(): Promise<string> {
  const releaseEntries = await readdir(releaseDirectory, {
    withFileTypes: true,
  });
  const appDirectory = releaseEntries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith("mac"),
  );
  if (!appDirectory) {
    throw new Error("Packaged macOS application directory was not found");
  }
  return join(
    releaseDirectory,
    appDirectory.name,
    "LegionCode Desktop.app",
    "Contents",
    "MacOS",
    "LegionCode Desktop",
  );
}

test("the packaged Desktop app renders without Node.js privileges", async () => {
  const executablePath = await findPackagedExecutable();
  const testRoot = await mkdtemp(join("/tmp", "legioncode-desktop-boundary-"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    const launchedApplication = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${join(testRoot, "user-data")}`],
    });
    application = launchedApplication;
    const page = await launchedApplication.firstWindow();
    await page.setViewportSize({ width: 420, height: 900 });
    const sidebarToggle = page.locator(".lc-workspace-menu-button");
    const workspaceSidebar = page.getByTestId("workspace-sidebar");
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceSidebar).toBeHidden();
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceSidebar).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "LegionCode Desktop" }),
    ).toBeVisible();
    await expect(page.getByText("Packaged", { exact: true })).toBeVisible();
    await expect(page.getByText("Environment ready", { exact: true })).toBeVisible();
    await expect(page.getByText("2 capability slices unavailable", { exact: true })).toBeVisible();
    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
    await expect(workspaceSidebar).toBeVisible();
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceSidebar).toBeHidden();
    await sidebarToggle.click();
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
    await expect(workspaceSidebar).toBeVisible();
    await expect(workspaceSidebar.getByLabel("Search")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(sidebarToggle).toBeFocused();
    await page.setViewportSize({ width: 1100, height: 800 });
    const appMetrics = await launchedApplication.evaluate(({ app }) => app.getAppMetrics());
    const appServerMetric = appMetrics.find(
      (metric) => metric.name === "LegionCode Local App Server",
    );
    if (!appServerMetric) {
      throw new Error("Packaged Local App Server process was not found");
    }
    process.kill(appServerMetric.pid, "SIGKILL");
    await expect(page.getByText("Environment offline", { exact: true })).toBeVisible();
    const restartPromise = page.evaluate(() => window.desktop.restartEnvironment());
    await expect(page.getByText("Starting environment", { exact: true })).toBeVisible();
    await restartPromise;
    await expect(page.getByText("Environment ready", { exact: true })).toBeVisible();

    const rendererBoundary = await page.evaluate(() => ({
      processType: typeof (globalThis as { process?: unknown }).process,
      requireType: typeof (globalThis as { require?: unknown }).require,
      desktopMethods: Object.keys(window.desktop),
    }));

    expect(rendererBoundary).toEqual({
      processType: "undefined",
      requireType: "undefined",
      desktopMethods: [
        "request",
        "getBuildInfo",
        "getEnvironment",
        "onEnvironmentStatus",
        "restartEnvironment",
        "pickWorkspace",
        "credential",
      ],
    });

    const invalidRequestChecks = await page.evaluate(async () => {
      const request = window.desktop.request as (envelope: unknown) => Promise<unknown>;
      const rejected = async (envelope: unknown): Promise<boolean> => {
        try {
          await request(envelope);
          return false;
        } catch {
          return true;
        }
      };
      return {
        unknownMethod: await rejected({
          protocolVersion: "1.0.0",
          method: "filesystem/read",
          params: {},
        }),
        malformedVersion: await rejected({
          protocolVersion: "0.0.0",
          method: "thread/list",
          params: {},
        }),
        rawWorkspacePath: await rejected({
          protocolVersion: "1.0.0",
          method: "workspace/grant",
          params: { path: "/private/renderer-controlled" },
        }),
      };
    });
    expect(invalidRequestChecks).toEqual({
      unknownMethod: true,
      malformedVersion: true,
      rawWorkspacePath: true,
    });

    const rendererUrl = page.url();
    await page.evaluate(() => {
      window.open("https://example.com");
      window.location.href = "https://example.com";
    });
    await expect.poll(() => launchedApplication.windows().length).toBe(1);
    await expect.poll(() => page.url()).toBe(rendererUrl);
  } finally {
    await application?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the packaged Desktop app stores a shared-catalog provider credential in OS-protected storage", async ({}, testInfo) => {
  const executablePath = await findPackagedExecutable();
  const testRoot = await mkdtemp(join("/tmp", "legioncode-desktop-provider-"));
  const userDataDirectory = join(testRoot, "user-data");
  const firstSentinel = "fixture-only-provider-secret-first";
  const replacementSentinel = "fixture-only-provider-secret-replaced";
  const consoleText: string[] = [];
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const page = await application.firstWindow();
    page.on("console", (message) => consoleText.push(message.text()));
    page.on("pageerror", (error) => consoleText.push(error.message));
    await expect(page.getByText("Environment ready", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Provider setup" })).toBeVisible();

    const candidate = await page.evaluate(async (protocolVersion) => {
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      const request = window.desktop.request as (envelope: unknown) => Promise<unknown>;
      const rawCatalog = await window.desktop.request({
        protocolVersion,
        method: "provider/catalog",
        params: {},
      });
      if (!isRecord(rawCatalog) || !isRecord(rawCatalog.result) || !Array.isArray(rawCatalog.result.providers)) {
        throw new Error("Provider catalog response was invalid");
      }
      for (const provider of rawCatalog.result.providers) {
        if (!isRecord(provider) || provider.providerId === "openai" || provider.launchStage !== "supported" || !Array.isArray(provider.authModes) || !provider.authModes.includes("api_key")) continue;
        const rawModels = await request({
          protocolVersion,
          method: "provider/models",
          params: { providerId: String(provider.providerId) },
        });
        if (!isRecord(rawModels) || !isRecord(rawModels.result) || !Array.isArray(rawModels.result.models)) continue;
        const model = rawModels.result.models.find((item) =>
          isRecord(item) && item.deprecated !== true && item.availability !== "unsupported_transport",
        );
        if (isRecord(model) && typeof model.id === "string") {
          return {
            providerId: String(provider.providerId),
            displayName: String(provider.displayName),
            modelId: model.id,
          };
        }
      }
      return null;
    }, APP_SERVER_PROTOCOL_VERSION);
    expect(candidate, "a supported non-OpenAI registry model from the local catalog").not.toBeNull();
    if (!candidate) throw new Error("No supported non-OpenAI registry model was returned by the local catalog");

    const providerButton = page.getByRole("button", { name: new RegExp(candidate.displayName) });
    await providerButton.click();
    const credentialInput = page.getByLabel(`${candidate.displayName} API key`);
    await credentialInput.fill(firstSentinel);
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText("Provider credential saved and route selected.", { exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(`Selected route: ${candidate.displayName} / ${candidate.modelId}`))).toBeVisible();
    await expect(credentialInput).toHaveValue("");

    await credentialInput.fill(replacementSentinel);
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText("Provider credential saved and route selected.", { exact: true })).toBeVisible();
    await expect(credentialInput).toHaveValue("");

    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByRole("button", { name: "Back to providers" }).click();
    const wideProviderButton = page.getByRole("button", { name: new RegExp(candidate.displayName) }).first();
    const wideLayout = await wideProviderButton.evaluate((element) => ({
      display: getComputedStyle(element).display,
      columns: getComputedStyle(element).gridTemplateColumns,
    }));
    expect(wideLayout.display).toBe("grid");
    const wideTracks = wideLayout.columns.trim().split(/\s+/);
    expect(wideTracks).toHaveLength(2);
    expect(Number.parseFloat(wideTracks[0]!)).toBe(32);
    expect(Number.parseFloat(wideTracks[1]!)).toBeGreaterThan(0);
    await page.getByRole("heading", { name: "Provider setup" }).evaluate((heading) => {
      const scrollHost = heading.closest(".lc-workspace-content");
      if (!(scrollHost instanceof HTMLElement)) throw new Error("Workspace content scroll container was not found");
      scrollHost.scrollTop += heading.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - 8;
    });
    await page.screenshot({ path: testInfo.outputPath("provider-setup-wide.png"), fullPage: true });

    await page.setViewportSize({ width: 420, height: 900 });
    await expect(page.getByRole("heading", { name: "Provider setup" })).toBeVisible();
    await expect(page.getByText(new RegExp(`Selected route: ${candidate.displayName} / ${candidate.modelId}`))).toBeVisible();
    const narrowProviderButton = page.getByRole("button", { name: new RegExp(candidate.displayName) }).first();
    const narrowLayout = await narrowProviderButton.evaluate((element) => ({
      display: getComputedStyle(element).display,
      columns: getComputedStyle(element).gridTemplateColumns,
    }));
    expect(narrowLayout.display).toBe("grid");
    const narrowTracks = narrowLayout.columns.trim().split(/\s+/);
    expect(narrowTracks).toHaveLength(2);
    expect(Number.parseFloat(narrowTracks[0]!)).toBe(32);
    expect(Number.parseFloat(narrowTracks[1]!)).toBeGreaterThan(0);
    await page.getByRole("heading", { name: "Provider setup" }).evaluate((heading) => {
      const scrollHost = heading.closest(".lc-workspace-content");
      if (!(scrollHost instanceof HTMLElement)) throw new Error("Workspace content scroll container was not found");
      scrollHost.scrollTop += heading.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - 8;
    });
    const narrowOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(narrowOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("provider-setup-narrow.png"), fullPage: true });

    const ciphertextPath = join(userDataDirectory, "provider-credentials", "credentials.enc.json");
    const ciphertextBeforeSecondLaunch = await readFile(ciphertextPath, "utf8");
    expect(ciphertextBeforeSecondLaunch).not.toContain(firstSentinel);
    expect(ciphertextBeforeSecondLaunch).not.toContain(replacementSentinel);
    await execFile(executablePath, [`--user-data-dir=${userDataDirectory}`], { timeout: 10_000 });
    expect(await readFile(ciphertextPath, "utf8")).toBe(ciphertextBeforeSecondLaunch);
    await expect.poll(() => application!.windows().length).toBe(1);
    await expect(page.getByText(`${candidate.displayName}: Saved`, { exact: true })).toBeVisible();

    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const restartedPage = await application.firstWindow();
    await expect(restartedPage.getByText("Environment ready", { exact: true })).toBeVisible();
    await expect(restartedPage.getByText(new RegExp(`Selected route: ${candidate.displayName} / ${candidate.modelId}`))).toBeVisible();
    await expect(restartedPage.getByText(new RegExp(`${candidate.displayName}: Saved`))).toBeVisible();

    await restartedPage.getByRole("button", { name: "Delete key", exact: true }).click();
    await expect(restartedPage.getByText("No provider route selected.", { exact: true })).toBeVisible();
    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const deletedPage = await application.firstWindow();
    await expect(deletedPage.getByText("Environment ready", { exact: true })).toBeVisible();
    await expect(deletedPage.getByText("No provider route selected.", { exact: true })).toBeVisible();
    await expect(deletedPage.getByText(new RegExp(`${candidate.displayName}: Missing`))).toBeVisible();

    const rendererEvidence = await deletedPage.evaluate(() => ({
      credentialMethods: Object.keys(window.desktop).filter((name) => name.toLowerCase().includes("credential") || name.toLowerCase().includes("apikey")),
      hasGetApiKey: "getApiKey" in window.desktop,
      localStorage: JSON.stringify(localStorage),
      sessionStorage: JSON.stringify(sessionStorage),
      text: document.body.innerText,
    }));
    expect(rendererEvidence.credentialMethods).toEqual(["credential"]);
    expect(rendererEvidence.hasGetApiKey).toBe(false);
    expect(rendererEvidence.localStorage).not.toContain("fixture-only-provider-secret");
    expect(rendererEvidence.sessionStorage).not.toContain("fixture-only-provider-secret");
    expect(rendererEvidence.text).not.toContain("fixture-only-provider-secret");
    expect(consoleText.join("\n")).not.toContain("fixture-only-provider-secret");
    await expect.poll(async () => (await readAllFiles(testRoot)).join("\n")).not.toContain("fixture-only-provider-secret");
  } finally {
    await application?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function readAllFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) return await readAllFiles(entryPath);
    if (entry.isFile()) {
      try { return [(await readFile(entryPath)).toString("utf8")]; } catch { return []; }
    }
    return [];
  }));
  return contents.flat();
}


test("the packaged Desktop app reopens and revokes a local workspace grant", async () => {
  const executablePath = await findPackagedExecutable();
  const testRoot = await mkdtemp(join("/tmp", "legioncode-desktop-smoke-"));
  const repositoryRoot = join(testRoot, "repository");
  const userDataDirectory = join(testRoot, "user-data");
  await execFile("git", ["init", "-b", "main", repositoryRoot]);
  await execFile("git", ["-C", repositoryRoot, "config", "remote.origin.url", "https://github.com/example/repository.git"]);

  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 420, height: 900 });
    const initialSidebarToggle = page.locator(".lc-workspace-menu-button");
    const workspaceSidebar = page.getByTestId("workspace-sidebar");
    await expect(initialSidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceSidebar).toBeHidden();
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(initialSidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceSidebar).toBeHidden();
    await expect(page.getByText("Environment ready", { exact: true })).toBeVisible();

    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
      });
    }, repositoryRoot);
    await page.getByRole("button", { name: "Choose folder" }).click();
    await expect(page.getByText("Selected: repository", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Grant access" }).click();
    await expect(page.getByRole("heading", { name: "repository" })).toBeVisible();
    await expect(page.getByText("main", { exact: true })).toBeVisible();
    await initialSidebarToggle.click();
    await expect(initialSidebarToggle).toHaveAttribute("aria-expanded", "true");
    await expect(workspaceSidebar).toBeVisible();
    await initialSidebarToggle.click();
    await expect(initialSidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceSidebar).toBeHidden();
    await initialSidebarToggle.click();
    await expect(initialSidebarToggle).toHaveAttribute("aria-expanded", "true");
    await expect(workspaceSidebar).toBeVisible();

    await page.getByLabel("New thread title").fill("Initial thread");
    await page.getByRole("button", { name: "Create thread" }).click();
    const initialThread = page.getByRole("option", { name: "Initial thread" });
    await expect(initialThread).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("workspace-sidebar")).toBeVisible();
    await expect(page.getByText("Local only", { exact: true })).toBeVisible();

    await page.getByLabel("New thread title").fill("Second thread");
    await page.getByRole("button", { name: "Create thread" }).click();
    const secondThread = page.getByRole("option", { name: "Second thread" });
    await expect(secondThread).toHaveAttribute("aria-selected", "true");
    await expect(initialThread).toHaveAttribute("aria-selected", "false");
    await expect(page.getByLabel("Thread title", { exact: true })).toHaveValue(
      "Second thread",
    );

    await page.getByLabel("Thread title", { exact: true }).fill("Renamed thread");
    await page.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByRole("option", { name: "Renamed thread" })).toBeVisible();
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();

    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const reopenedPage = await application.firstWindow();
    await reopenedPage.setViewportSize({ width: 960, height: 800 });
    await expect(reopenedPage.getByRole("heading", { name: "repository" })).toBeVisible();
    const reopenedSidebarToggle = reopenedPage.locator(".lc-workspace-menu-button");
    await expect(reopenedSidebarToggle).toHaveAttribute("aria-expanded", "false");
    await reopenedSidebarToggle.click();
    await expect(reopenedSidebarToggle).toHaveAttribute("aria-expanded", "true");
    await expect(reopenedPage.getByTestId("workspace-sidebar")).toHaveAttribute(
      "aria-modal",
      "true",
    );
    await reopenedPage.getByRole("button", { name: /Archived/ }).click();
    await expect(reopenedPage.getByRole("option", { name: "Renamed thread" })).toBeVisible();
    await reopenedPage.getByRole("option", { name: "Renamed thread" }).click();
    await expect(reopenedPage.getByRole("button", { name: "Unarchive" })).toBeVisible();
    await reopenedPage.getByRole("button", { name: "Unarchive" }).click();
    await expect(reopenedPage.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
    await expect(reopenedSidebarToggle).toHaveAttribute("aria-expanded", "false");
    await reopenedSidebarToggle.click();
    await expect(reopenedPage.getByRole("option", { name: "Renamed thread" })).toBeVisible();
    await reopenedPage.keyboard.press("Escape");
    await expect(reopenedSidebarToggle).toHaveAttribute("aria-expanded", "false");
    await expect(reopenedPage.getByTestId("workspace-sidebar")).toBeHidden();
    await reopenedPage.getByRole("button", { name: "Revoke access" }).click();
    await expect(reopenedPage.getByRole("heading", { name: "No workspace granted" })).toBeVisible();

    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    await expect((await application.firstWindow()).getByRole("heading", { name: "No workspace granted" })).toBeVisible();
  } finally {
    await application?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
