import { _electron as electron, expect, test } from "@playwright/test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const releaseDirectory = fileURLToPath(new URL("../release", import.meta.url));

test("the packaged Desktop app renders without Node.js privileges", async () => {
  const releaseEntries = await readdir(releaseDirectory, {
    withFileTypes: true,
  });
  const appDirectory = releaseEntries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith("mac"),
  );

  if (!appDirectory) {
    throw new Error("Packaged macOS application directory was not found");
  }

  const executablePath = join(
    releaseDirectory,
    appDirectory.name,
    "LegionCode Desktop.app",
    "Contents",
    "MacOS",
    "LegionCode Desktop",
  );
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
