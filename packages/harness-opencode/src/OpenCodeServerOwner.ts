import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { HarnessHost, SupervisedProcess } from "@repo/harness-core/server";
import { OpenCodeClient, OpenCodeTransportError } from "./OpenCodeClient.js";
import {
  OPENCODE_SERVER_ARGUMENTS,
  readOpenCodeServerUrl,
  verifyOpenCodeProbe,
} from "./OpenCodeInstallation.js";

/** Native launch/readiness translation. Process tracking, OS policy and termination remain host-owned. */
export class OpenCodeServerOwner {
  private constructor(
    readonly transport: OpenCodeClient,
    readonly process: SupervisedProcess,
  ) {}

  static async start(input: {
    readonly host: HarnessHost;
    readonly executable: string;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeServerOwner> {
    const { host, executable, signal } = input;
    signal.throwIfAborted();
    if (!isAbsolute(executable))
      throw new OpenCodeTransportError("binary path", false);
    const password = host.environment.OPENCODE_PASSWORD;
    if (
      !password ||
      !/^[A-Za-z0-9_-]{43}$/.test(password) ||
      host.environment.OPENCODE_SERVER_PASSWORD ||
      host.environment.OPENCODE_PTY_HANDOFF !== undefined ||
      host.environment.OPENCODE_DB !== "opencode.db"
    ) {
      throw new OpenCodeTransportError("private server configuration", false);
    }
    await assertPrivateConfiguration(host);
    await claimFreshStore(host);
    let transport: OpenCodeClient | undefined;
    try {
      const probe = await host.launch({ executable, args: ["--version"] });
      await probe.ready;
      const version = await boundedOutput(probe, signal, false);
      const exit = await probe.exited;
      if (exit.kind !== "exited" || exit.code !== 0 || exit.signal !== null)
        throw new OpenCodeTransportError("binary probe", false);
      verifyOpenCodeProbe(version);
      signal.throwIfAborted();
      const process = await host.launch({
        executable,
        args: OPENCODE_SERVER_ARGUMENTS,
      });
      await process.ready;
      const url = readOpenCodeServerUrl(
        await boundedOutput(process, signal, true),
      );
      transport = new OpenCodeClient(url, password);
      if (!process.child.pid)
        throw new OpenCodeTransportError("process identity", false);
      await transport.verify(process.child.pid);
      signal.throwIfAborted();
      return new OpenCodeServerOwner(transport, process);
    } catch {
      host.fence();
      await host.terminateProcesses({ graceMs: 100, killWaitMs: 1000 });
      await transport?.close();
      throw new OpenCodeTransportError("server startup", true);
    }
  }
}

/** Native defaults otherwise read the real HOME's provider/config and saved state. */
async function assertPrivateConfiguration(host: HarnessHost): Promise<void> {
  const instance = await realpath(host.instanceDirectory);
  const names = ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];
  if (host.environment.OPENCODE_CONFIG_DIR !== undefined)
    names.push("OPENCODE_CONFIG_DIR");
  if (host.environment.OPENCODE_TEST_HOME !== undefined)
    throw new OpenCodeTransportError("native home override unavailable", false);
  for (const name of names) {
    const configured = host.environment[name];
    if (!configured || !isAbsolute(configured))
      throw new OpenCodeTransportError(
        "isolated native configuration required",
        false,
      );
    const directory = await realpath(configured);
    const child = relative(instance, directory);
    const metadata = await stat(directory);
    if (
      !child ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      isAbsolute(child) ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0
    )
      throw new OpenCodeTransportError(
        "unisolated native configuration",
        false,
      );
  }
}

/** Do not boot a reused store: service recovery and schedules can execute before reconciliation. */
async function claimFreshStore(host: HarnessHost): Promise<void> {
  const configured = host.environment.XDG_DATA_HOME;
  if (!configured || !isAbsolute(configured))
    throw new OpenCodeTransportError("fresh data directory", false);
  const [instance, data] = await Promise.all([
    realpath(host.instanceDirectory),
    realpath(configured),
  ]);
  const child = relative(instance, data);
  const metadata = await stat(data);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    (await readdir(data)).length !== 0
  ) {
    throw new OpenCodeTransportError(
      "reused or unisolated data directory",
      false,
    );
  }
  // An exclusive native launch claim prevents accidental reuse after any ambiguous startup.
  const claim = await open(
    join(data, ".legioncode-native-generation"),
    "wx",
    0o600,
  );
  try {
    await claim.writeFile(host.processGeneration);
    await claim.sync();
  } finally {
    await claim.close();
  }
}

/** Retain no raw logs; keep draining server stdout after the one JSON readiness announcement. */
function boundedOutput(
  process: SupervisedProcess,
  signal: AbortSignal,
  announcement: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let lines = 0;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (value === undefined)
        reject(new OpenCodeTransportError("bounded process output", true));
      else resolve(value);
      buffer = "";
    };
    const abort = () => finish();
    const timeout = setTimeout(abort, announcement ? 15000 : 5000);
    signal.addEventListener("abort", abort, { once: true });
    process.child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > 4096) {
        finish();
        return;
      }
      if (!announcement) return;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (++lines > 32) {
          finish();
          return;
        }
        if (line.startsWith("{")) {
          finish(line);
          return;
        }
      }
    });
    process.child.stdout.once("end", () =>
      finish(announcement ? undefined : buffer),
    );
    process.child.stdout.once("error", abort);
    void process.exited.then(() => {
      if (announcement) finish();
    });
    if (signal.aborted) abort();
  });
}
