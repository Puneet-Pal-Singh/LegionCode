import { _electron as electron, expect, test } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const application = await electron.launch({ executablePath });

  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("heading", { name: "LegionCode Desktop" }),
    ).toBeVisible();
    await expect(page.getByText("Packaged", { exact: true })).toBeVisible();
    await expect(page.getByText("Environment ready", { exact: true })).toBeVisible();
    await expect(page.getByText("3 capability slices unavailable", { exact: true })).toBeVisible();
    const appMetrics = await application.evaluate(({ app }) => app.getAppMetrics());
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
        "getBuildInfo",
        "getEnvironment",
        "onEnvironmentStatus",
        "restartEnvironment",
        "pickWorkspace",
        "grantWorkspace",
        "getWorkspace",
        "revokeWorkspace",
      ],
    });

    const rendererUrl = page.url();
    await page.evaluate(() => {
      window.open("https://example.com");
      window.location.href = "https://example.com";
    });
    await expect.poll(() => application.windows().length).toBe(1);
    await expect.poll(() => page.url()).toBe(rendererUrl);
  } finally {
    await application.close();
  }
});

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

    await application.close();
    application = undefined;
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
    });
    const reopenedPage = await application.firstWindow();
    await expect(reopenedPage.getByRole("heading", { name: "repository" })).toBeVisible();
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
