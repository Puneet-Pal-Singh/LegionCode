import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SERVER_PROTOCOL_VERSION, AppServerResultSchemas } from "@legioncode/app-server/protocol";
import { AppServerEnvironmentSnapshotSchema } from "@repo/platform-protocol";
import { ProviderIdSchema } from "@repo/shared-types";

const releaseDirectory = fileURLToPath(new URL("../release", import.meta.url));
const execFile = promisify(execFileCallback);

// These are unsigned macOS package regressions. Fixture credentials never invoke
// a provider and do not constitute selected-provider golden-loop acceptance.
test.setTimeout(90_000);

async function findPackagedExecutable(): Promise<string> {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("Packaged Desktop acceptance requires a supported macOS architecture");
  }
  const appDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
  return join(
    releaseDirectory,
    appDirectory,
    "LegionCode Desktop.app",
    "Contents",
    "MacOS",
    "LegionCode Desktop",
  );
}

// Ready has no banner in the shared shell; inspect the validated public receipt.
async function expectEnvironmentReady(page: Page): Promise<void> {
  await expect.poll(async () => AppServerEnvironmentSnapshotSchema.parse(
    await page.evaluate(() => window.desktop.getEnvironment()),
  ).status).toBe("ready");
}

async function readProviderSelection(page: Page) {
  const response = await page.evaluate((protocolVersion) => window.desktop.request({
    protocolVersion, method: "provider/current", params: {},
  }), APP_SERVER_PROTOCOL_VERSION);
  if (typeof response !== "object" || response === null || !("result" in response)) {
    throw new Error("Provider selection receipt was unavailable");
  }
  return AppServerResultSchemas["provider/current"].parse(response.result).selection;
}

async function readWorkspaceGrant(page: Page) {
  const response = await page.evaluate((protocolVersion) => window.desktop.request({
    protocolVersion, method: "workspace/current", params: {},
  }), APP_SERVER_PROTOCOL_VERSION);
  if (typeof response !== "object" || response === null || !("result" in response)) {
    throw new Error("Workspace grant receipt was unavailable");
  }
  return AppServerResultSchemas["workspace/current"].parse(response.result).grant;
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
    const openSidebar = page.getByRole("button", { name: "Open sidebar" });
    const workspaceSidebar = page.getByTestId("workspace-sidebar");
    const closeSidebar = workspaceSidebar.getByRole("button", { name: "Close sidebar" });
    await expect(openSidebar).toBeVisible();
    await expect(workspaceSidebar).toBeHidden();
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(openSidebar).toBeVisible();
    await expect(workspaceSidebar).toBeHidden();
    await expect(page.getByRole("heading", { name: "What should we build?", exact: true })).toBeVisible();
    await openSidebar.click();
    await workspaceSidebar.getByRole("button", { name: "Settings", exact: true }).click();
    const settingsDialog = page.getByRole("dialog", { name: "General", exact: true });
    await expect(settingsDialog.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    const buildInfo = await page.evaluate(() => window.desktop.getBuildInfo());
    expect(buildInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(buildInfo.platform).toBe("darwin");
    expect(buildInfo.arch).toBe(process.arch);
    await settingsDialog.getByRole("button", { name: "Close settings", exact: true }).click();
    await closeSidebar.click();
    await expectEnvironmentReady(page);
    const environment = AppServerEnvironmentSnapshotSchema.parse(
      await page.evaluate(() => window.desktop.getEnvironment()),
    );
    expect(environment.kind).toBe("local");
    expect(environment.status).toBe("ready");
    expect(environment.protocolVersion).toBe(APP_SERVER_PROTOCOL_VERSION);
    // The strict public schema excludes the private listener address/credential.
    expect(await page.evaluate(() => window.desktop.getBuildInfo())).toMatchObject({
      packaged: true,
      platform: "darwin",
      arch: process.arch,
    });
    const actualUserData = await launchedApplication.evaluate(({ app }) => app.getPath("userData"));
    expect(await realpath(actualUserData)).toBe(await realpath(join(testRoot, "user-data")));
    await openSidebar.click();
    await expect(workspaceSidebar).toBeVisible();
    await expect(closeSidebar).toBeVisible();
    await expect(openSidebar).toBeHidden();
    await closeSidebar.click();
    await expect(workspaceSidebar).toBeHidden();
    await expect(openSidebar).toBeVisible();
    await openSidebar.click();
    await expect(workspaceSidebar).toBeVisible();
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(workspaceSidebar).toBeHidden();
    await expect(openSidebar).toBeVisible();
    await openSidebar.click();
    await expect(workspaceSidebar).toBeVisible();
    await expect(workspaceSidebar).toHaveAttribute("aria-modal", "true");
    await expect(closeSidebar).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(workspaceSidebar).toBeHidden();
    await expect(openSidebar).toBeFocused();
    await page.setViewportSize({ width: 1100, height: 800 });
    const appMetrics = await launchedApplication.evaluate(({ app }) => app.getAppMetrics());
    const appServerMetric = appMetrics.find(
      (metric) => metric.name === "LegionCode Local App Server",
    );
    if (!appServerMetric) {
      throw new Error("Packaged Local App Server process was not found");
    }
    const { stdout: listeners } = await execFile("lsof", [
      "-nP", "-a", "-p", String(appServerMetric.pid), "-iTCP", "-sTCP:LISTEN", "-Fn",
    ]);
    const addresses = listeners.split("\n").filter((line) => line.startsWith("n"));
    expect(addresses).toHaveLength(1);
    expect(addresses[0]).toMatch(/^n127\.0\.0\.1:\d+$/);
    const endpoint = `http://${addresses[0]!.slice(1)}/app-server/request`;
    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    expect(unauthorized.status).toBe(401);
    await unauthorized.arrayBuffer();
    const wrongCredential = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fixture-only-invalid-app-server-credential",
      },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    expect(wrongCredential.status).toBe(401);
    await wrongCredential.arrayBuffer();
    const foreignOrigin = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    expect(foreignOrigin.status).toBe(403);
    await foreignOrigin.arrayBuffer();
    process.kill(appServerMetric.pid, "SIGKILL");
    await expect(page.getByText("Environment offline", { exact: true })).toBeVisible();
    const restartPromise = page.evaluate(() => window.desktop.restartEnvironment());
    await expect(page.getByText("Starting environment", { exact: true })).toBeVisible();
    await restartPromise;
    await expectEnvironmentReady(page);

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

    const restartedMetrics = await launchedApplication.evaluate(({ app }) => app.getAppMetrics());
    const restartedServers = restartedMetrics.filter(
      (metric) => metric.name === "LegionCode Local App Server",
    );
    expect(restartedServers).toHaveLength(1);
    expect(restartedServers[0]!.pid).not.toBe(appServerMetric.pid);
    await launchedApplication.close();
    application = undefined;
    await expect.poll(() => {
      try {
        process.kill(restartedServers[0]!.pid, 0);
        return false;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
        throw error;
      }
    }, { timeout: 10_000, message: "Local App Server must exit after Desktop quits" }).toBe(true);
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
    await expectEnvironmentReady(page);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog", { name: "General", exact: true }).getByRole("button", { name: "Providers", exact: true }).click();
    const providersDialog = page.getByRole("dialog", { name: "Providers", exact: true });
    await expect(providersDialog.getByRole("heading", { name: "Connected providers", exact: true })).toBeVisible();

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
        if (!isRecord(provider) || provider.providerId === "openai" || String(provider.providerId).startsWith("cloudflare-") || provider.launchStage !== "supported" || !Array.isArray(provider.authModes) || !provider.authModes.includes("api_key")) continue;
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

    const availableProvider = providersDialog.getByRole("heading", { name: "Popular providers", exact: true }).locator("..").locator("div.flex.min-h-20").filter({ has: page.getByText(candidate.displayName, { exact: true }) });
    await availableProvider.getByRole("button", { name: "Connect", exact: true }).click();
    const credentialInput = providersDialog.getByLabel(`${candidate.displayName} API key`);
    await credentialInput.fill(firstSentinel);
    await providersDialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(providersDialog.getByText("API key saved and provider connected.", { exact: true })).toBeVisible();
    await expect.poll(() => readProviderSelection(page)).toMatchObject({ providerId: candidate.providerId, modelId: candidate.modelId });
    // The shared form unmounts after save; reopening it must not restore plaintext.
    await expect(credentialInput).toHaveCount(0);
    const connectedProvider = providersDialog.getByRole("heading", { name: "Connected providers", exact: true }).locator("..").locator("div.flex.min-h-20").filter({ has: page.getByText(candidate.displayName, { exact: true }) });
    await expect(connectedProvider.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    // Shared Web management replaces a key by disconnecting, then reconnecting.
    await connectedProvider.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect.poll(() => readProviderSelection(page)).toBeNull();
    await availableProvider.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(credentialInput).toHaveValue("");
    await credentialInput.fill(replacementSentinel);
    await providersDialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(connectedProvider.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await expect.poll(() => readProviderSelection(page)).toMatchObject({ providerId: candidate.providerId, modelId: candidate.modelId });
    await expect(credentialInput).toHaveCount(0);

    // The chooser retains Web's two-column icon/text rows at both sizes.
    // Use a different available provider to reopen the catalog without changing the saved key.
    await providersDialog.getByRole("heading", { name: "Popular providers", exact: true }).locator("..").getByRole("button", { name: "Connect", exact: true }).first().click();
    await providersDialog.getByRole("button", { name: "Back to providers", exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 900 });
    const wideProviderButton = providersDialog.getByRole("button", { name: new RegExp(candidate.displayName) }).first();
    const wideLayout = await wideProviderButton.evaluate((element) => ({
      display: getComputedStyle(element).display,
      columns: getComputedStyle(element).gridTemplateColumns,
    }));
    expect(wideLayout.display).toBe("grid");
    const wideTracks = wideLayout.columns.trim().split(/\s+/);
    expect(wideTracks).toHaveLength(2);
    expect(Number.parseFloat(wideTracks[0]!)).toBe(32);
    expect(Number.parseFloat(wideTracks[1]!)).toBeGreaterThan(0);
    await providersDialog.getByRole("heading", { name: "Providers", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("provider-setup-wide.png"), fullPage: true });

    await page.setViewportSize({ width: 420, height: 900 });
    await expect(providersDialog.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
    await expect.poll(() => readProviderSelection(page)).toMatchObject({ providerId: candidate.providerId, modelId: candidate.modelId });
    const narrowProviderButton = providersDialog.getByRole("button", { name: new RegExp(candidate.displayName) }).first();
    const narrowLayout = await narrowProviderButton.evaluate((element) => ({
      display: getComputedStyle(element).display,
      columns: getComputedStyle(element).gridTemplateColumns,
    }));
    expect(narrowLayout.display).toBe("grid");
    const narrowTracks = narrowLayout.columns.trim().split(/\s+/);
    expect(narrowTracks).toHaveLength(2);
    expect(Number.parseFloat(narrowTracks[0]!)).toBe(32);
    expect(Number.parseFloat(narrowTracks[1]!)).toBeGreaterThan(0);
    await providersDialog.getByRole("heading", { name: "Providers", exact: true }).scrollIntoViewIfNeeded();
    const narrowOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(narrowOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("provider-setup-narrow.png"), fullPage: true });
    await providersDialog.getByRole("button", { name: "Back", exact: true }).click();

    const ciphertextPath = join(userDataDirectory, "provider-credentials", "credentials.enc.json");
    const ciphertextBeforeSecondLaunch = await readFile(ciphertextPath, "utf8");
    expect(ciphertextBeforeSecondLaunch).not.toContain(firstSentinel);
    expect(ciphertextBeforeSecondLaunch).not.toContain(replacementSentinel);
    await execFile(executablePath, [`--user-data-dir=${userDataDirectory}`], { timeout: 10_000 });
    expect(await readFile(ciphertextPath, "utf8")).toBe(ciphertextBeforeSecondLaunch);
    await expect.poll(() => application!.windows().length).toBe(1);
    await expect(connectedProvider.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();

    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const restartedPage = await application.firstWindow();
    await expectEnvironmentReady(restartedPage);
    await restartedPage.getByRole("button", { name: "Open sidebar" }).click();
    await restartedPage.getByRole("button", { name: "Settings", exact: true }).click();
    await restartedPage.getByRole("dialog", { name: "General", exact: true }).getByRole("button", { name: "Providers", exact: true }).click();
    const restartedProviders = restartedPage.getByRole("dialog", { name: "Providers", exact: true });
    await expect.poll(() => readProviderSelection(restartedPage)).toMatchObject({ providerId: candidate.providerId, modelId: candidate.modelId });
    const restoredProvider = restartedProviders.getByRole("heading", { name: "Connected providers", exact: true }).locator("..").locator("div.flex.min-h-20").filter({ has: restartedPage.getByText(candidate.displayName, { exact: true }) });
    await expect(restoredProvider.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();

    await restoredProvider.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect.poll(() => readProviderSelection(restartedPage)).toBeNull();
    await expect(restoredProvider).toHaveCount(0);
    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const deletedPage = await application.firstWindow();
    await expectEnvironmentReady(deletedPage);
    await deletedPage.getByRole("button", { name: "Open sidebar" }).click();
    await deletedPage.getByRole("button", { name: "Settings", exact: true }).click();
    await deletedPage.getByRole("dialog", { name: "General", exact: true }).getByRole("button", { name: "Providers", exact: true }).click();
    await expect.poll(() => readProviderSelection(deletedPage)).toBeNull();
    await expect(deletedPage.getByText("No provider keys connected yet.", { exact: true })).toBeVisible();
    await expect.poll(() => deletedPage.evaluate((providerId) => window.desktop.credential({
      operation: "status", providerId,
    }), ProviderIdSchema.parse(candidate.providerId))).toMatchObject({ providerId: candidate.providerId, status: "missing" });

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
    const initialOpenSidebar = page.getByRole("button", { name: "Open sidebar" });
    const workspaceSidebar = page.getByTestId("workspace-sidebar");
    const initialCloseSidebar = workspaceSidebar.getByRole("button", { name: "Close sidebar" });
    await expect(initialOpenSidebar).toBeVisible();
    await expect(workspaceSidebar).toBeHidden();
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(initialOpenSidebar).toBeVisible();
    await expect(workspaceSidebar).toBeHidden();
    await expectEnvironmentReady(page);

    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
      });
    }, repositoryRoot);
    await initialOpenSidebar.click();
    await workspaceSidebar.getByRole("button", { name: "Add project", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Grant workspace access", exact: true }).getByRole("region", { name: "Selected folder" }).getByText("repository", { exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "Grant workspace access", exact: true }).getByRole("button", { name: "Grant access", exact: true }).click();
    try {
      await expect(page.getByRole("heading", { level: 1 }).filter({ has: page.getByRole("button", { name: "Change project from repository", exact: true }) })).toBeVisible();
    } catch (failure) {
      // Fresh synthetic profile only: visible UI text, never transport/storage data.
      // Diagnostics are best-effort and must not replace the original assertion.
      try {
        const sidebar = await workspaceSidebar.evaluate((element) =>
          element.getClientRects().length ? (element as HTMLElement).innerText.slice(0, 4096) : "",
          undefined, { timeout: 1_000 },
        );
        const alerts = await page.getByRole("alert").evaluateAll((elements) =>
          elements.filter((element) => element.getClientRects().length)
            .slice(0, 8).map((element) => (element as HTMLElement).innerText.slice(0, 512))
            .join("\n").slice(0, 4096),
        );
        await test.info().attach("workspace-grant-failure-visible-text", {
          body: JSON.stringify({ sidebar, alerts }), contentType: "application/json",
        });
      } catch { /* Preserve the original failure if the page is unavailable. */ }
      try {
        await test.info().attach("workspace-grant-failure-screenshot", {
          body: await page.screenshot({ timeout: 1_000 }), contentType: "image/png",
        });
      } catch { /* Preserve the original failure if the page is unavailable. */ }
      throw failure;
    }
    await expect(workspaceSidebar.getByRole("group", { name: "repository", exact: true })).toBeVisible();
    await expect.poll(() => readWorkspaceGrant(page)).toMatchObject({ displayName: "repository", branch: "main", readiness: "ready" });
    await expect(workspaceSidebar).toBeVisible();
    await expect(initialCloseSidebar).toBeVisible();
    await initialCloseSidebar.click();
    await expect(workspaceSidebar).toBeHidden();
    await initialOpenSidebar.click();
    await expect(workspaceSidebar).toBeVisible();

    await workspaceSidebar.getByRole("button", { name: "New task", exact: true }).click();
    const firstCreatedThread = page.getByRole("option", { name: "New local thread", exact: true });
    await expect(firstCreatedThread).toHaveAttribute("aria-selected", "true");
    await firstCreatedThread.hover();
    const firstDetails = page.getByRole("dialog", { name: "New local thread details", exact: true });
    await firstDetails.getByRole("button", { name: "Rename New local thread", exact: true }).click();
    await firstDetails.getByRole("textbox", { name: "Rename New local thread", exact: true }).fill("Initial thread");
    await firstDetails.getByRole("textbox", { name: "Rename New local thread", exact: true }).press("Enter");
    const initialThread = page.getByRole("option", { name: "Initial thread", exact: true });
    await expect(initialThread).toHaveAttribute("aria-selected", "true");
    await expect(workspaceSidebar).toBeVisible();
    await expect(page.getByRole("group", { name: "repository", exact: true })).toBeVisible();

    await workspaceSidebar.getByRole("button", { name: "New task", exact: true }).click();
    const secondCreatedThread = page.getByRole("option", { name: "New local thread", exact: true });
    await expect(secondCreatedThread).toHaveAttribute("aria-selected", "true");
    await secondCreatedThread.hover();
    const createdDetails = page.getByRole("dialog", { name: "New local thread details", exact: true });
    await createdDetails.getByRole("button", { name: "Rename New local thread", exact: true }).click();
    await createdDetails.getByRole("textbox", { name: "Rename New local thread", exact: true }).fill("Second thread");
    await createdDetails.getByRole("textbox", { name: "Rename New local thread", exact: true }).press("Enter");
    const secondThread = page.getByRole("option", { name: "Second thread", exact: true });
    await expect(secondThread).toHaveAttribute("aria-selected", "true");
    await expect(initialThread).toHaveAttribute("aria-selected", "false");
    await secondThread.hover();
    const secondDetails = page.getByRole("dialog", { name: "Second thread details", exact: true });
    await secondDetails.getByRole("button", { name: "Rename Second thread", exact: true }).click();
    const titleInput = secondDetails.getByRole("textbox", { name: "Rename Second thread", exact: true });
    await expect(titleInput).toHaveValue("Second thread");
    await titleInput.fill("Renamed thread");
    await titleInput.press("Enter");
    const renamedThread = page.getByRole("option", { name: "Renamed thread", exact: true });
    await expect(renamedThread).toHaveAttribute("aria-selected", "true");
    await renamedThread.hover();
    await page.getByRole("button", { name: "Archive Renamed thread", exact: true }).click();
    await page.getByRole("button", { name: "Confirm archive for Renamed thread", exact: true }).click();
    await workspaceSidebar.getByRole("button", { name: /Archived/ }).click();
    await renamedThread.hover();
    await expect(page.getByRole("button", { name: "Unarchive Renamed thread", exact: true })).toBeVisible();

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
    await expect(reopenedPage.getByRole("heading", { level: 1 }).filter({ has: reopenedPage.getByRole("button", { name: "Change project from repository", exact: true }) })).toBeVisible();
    const reopenedOpenSidebar = reopenedPage.getByRole("button", { name: "Open sidebar" });
    const reopenedSidebar = reopenedPage.getByTestId("workspace-sidebar");
    const reopenedCloseSidebar = reopenedSidebar.getByRole("button", { name: "Close sidebar" });
    await expect(reopenedOpenSidebar).toBeVisible();
    await reopenedOpenSidebar.click();
    await expect(reopenedSidebar).toHaveAttribute(
      "aria-modal",
      "true",
    );
    await expect(reopenedCloseSidebar).toBeFocused();
    await expect(reopenedSidebar.getByRole("group", { name: "repository", exact: true })).toBeVisible();
    await expect.poll(() => readWorkspaceGrant(reopenedPage)).toMatchObject({ displayName: "repository", branch: "main", readiness: "ready" });
    await reopenedPage.getByRole("button", { name: /Archived/ }).click();
    await expect(reopenedPage.getByRole("option", { name: "Renamed thread" })).toBeVisible();
    await reopenedPage.getByRole("option", { name: "Renamed thread" }).click();
    await expect(reopenedSidebar).toBeHidden();
    await expect(reopenedOpenSidebar).toBeVisible();
    await reopenedOpenSidebar.click();
    const reopenedThread = reopenedPage.getByRole("option", { name: "Renamed thread", exact: true });
    await expect(reopenedThread).toHaveAttribute("aria-selected", "true");
    await reopenedThread.hover();
    await expect(reopenedPage.getByRole("button", { name: "Unarchive Renamed thread", exact: true })).toBeVisible();
    await reopenedPage.getByRole("button", { name: "Unarchive Renamed thread", exact: true }).click();
    await reopenedThread.hover();
    await expect(reopenedPage.getByRole("button", { name: "Archive Renamed thread", exact: true })).toBeVisible();
    await expect(reopenedThread).toHaveAttribute("aria-selected", "true");
    await reopenedCloseSidebar.focus();
    await reopenedPage.keyboard.press("Escape");
    await expect(reopenedSidebar).toBeHidden();
    await expect(reopenedOpenSidebar).toBeFocused();
    await reopenedOpenSidebar.click();
    const reopenedProject = reopenedSidebar.getByRole("group", { name: "repository", exact: true });
    await reopenedProject.hover();
    await reopenedProject.getByRole("button", { name: "Workspace actions for repository", exact: true }).click();
    await reopenedProject.getByRole("menuitem", { name: "Remove", exact: true }).click();
    await reopenedProject.getByRole("group", { name: "Confirm removal of repository", exact: true }).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(reopenedPage.getByRole("heading", { name: "What should we build?", exact: true })).toBeVisible();
    await expect(reopenedSidebar.getByRole("group", { name: "repository", exact: true })).toHaveCount(0);
    await expect.poll(() => readWorkspaceGrant(reopenedPage)).toBeNull();

    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const revokedPage = await application.firstWindow();
    await expect(revokedPage.getByRole("heading", { name: "What should we build?", exact: true })).toBeVisible();
    await revokedPage.getByRole("button", { name: "Open sidebar" }).click();
    await expect(revokedPage.getByTestId("workspace-sidebar").getByRole("group", { name: "repository", exact: true })).toHaveCount(0);
    await expect.poll(() => readWorkspaceGrant(revokedPage)).toBeNull();
  } finally {
    await application?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
