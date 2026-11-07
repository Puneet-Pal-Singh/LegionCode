import { spawn } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNativeFileHelper } from "./build-file-helper.mjs";

export async function verifyBundledProcessHelper(
  executablePath,
  platform,
  architecture,
) {
  const diagnostics = await inspectNativeFileHelper(
    executablePath,
    platform,
    architecture,
  );
  const directory = await mkdtemp(join(tmpdir(), "legioncode-package-fence-"));
  let lease;
  try {
    lease = await open(join(directory, "fence"), "wx", 0o600);
    await new Promise((resolve, reject) => {
      const child = spawn(executablePath, ["--acquire-lease-fd", "6"], {
        env: {},
        shell: false,
        stdio: [
          "ignore",
          "ignore",
          "pipe",
          "ignore",
          "pipe",
          "ignore",
          lease.fd,
        ],
      });
      const chunks = [];
      let size = 0;
      let failed = false;
      const stop = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, 5_000);
      child.once("error", stop);
      child.stderr.on("error", stop);
      child.stderr.resume();
      const status = child.stdio[4];
      status.on("error", stop);
      status.on("data", (chunk) => {
        size += chunk.length;
        if (size > 128) {
          stop();
          return;
        }
        chunks.push(chunk);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const receipt = Buffer.concat(chunks).toString("utf8");
        if (
          failed ||
          code !== 0 ||
          signal !== null ||
          receipt !== '{"v":1,"event":"lease","state":"acquired"}\n'
        ) {
          reject(new Error("Bundled process helper FD6 invocation failed"));
        } else resolve();
      });
    });
    return { ...diagnostics, protocol: "guardian-fd6-v1" };
  } finally {
    try {
      await lease?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
