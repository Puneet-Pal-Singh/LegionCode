import { randomUUID } from "node:crypto";
import { HarnessHostError } from "./errors.js";
import type {
  ProcessLaunch,
  ProcessGroupSettlement,
  SupervisedProcess,
} from "./ProcessSupervisor.js";
import {
  createInstanceEnvironment,
  resolveInstanceDirectory,
  resolveWorkspaceDirectory,
} from "./InstanceEnvironment.js";

/** The composition root supplies a real OS launch boundary; there is no unrestricted default. */
export interface HarnessLaunchPolicy {
  /** Must prove the granted filesystem/shell/Git and descendant boundary, including denial of privileged control-plane sockets. UID alone is insufficient. */
  assertEnforced(input: {
    readonly workspaceRoot: string;
    readonly instanceDirectory: string;
    readonly journalDirectory: string;
    readonly processGeneration: string;
  }): Promise<void>;
  launch(request: ProcessLaunch): Promise<SupervisedProcess>;
}

/** Host-local paths and process services. Never serialized into product events or client metadata. */
export interface HarnessHost {
  readonly workspaceRoot: string;
  readonly instanceDirectory: string;
  /** Host-owned delivery files, excluded from provider write grants and snapshots. */
  readonly journalDirectory: string;
  /** Fresh UUID per supervised host; runtime persists this learned identity before execute. */
  readonly processGeneration: string;
  readonly environment: Readonly<Record<string, string>>;
  launch(request: {
    readonly executable: string;
    readonly args: readonly string[];
  }): Promise<SupervisedProcess>;
  fence(): void;
  terminateProcesses(input: {
    readonly graceMs: number;
    readonly killWaitMs: number;
  }): Promise<readonly ProcessGroupSettlement[]>;
}

export async function createHarnessHost(input: {
  readonly workspaceRoot: string;
  readonly instanceDirectory: string;
  readonly journalDirectory: string;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly selectedEnvironment: Readonly<Record<string, string>>;
  readonly launchPolicy: HarnessLaunchPolicy;
}): Promise<HarnessHost> {
  const processGeneration = randomUUID();
  const launchPolicy = input.launchPolicy;
  const workspaceRoot = await resolveWorkspaceDirectory(
    input.workspaceRoot,
    input.workspaceRoot,
  );
  const instanceDirectory = await resolveInstanceDirectory(
    workspaceRoot,
    input.instanceDirectory,
  );
  const journalDirectory = await resolveInstanceDirectory(
    workspaceRoot,
    input.journalDirectory,
  );
  // A provider-config grant must never include the delivery journal, or vice versa.
  await resolveInstanceDirectory(instanceDirectory, journalDirectory);
  await launchPolicy.assertEnforced({
    workspaceRoot,
    instanceDirectory,
    journalDirectory,
    processGeneration,
  });
  const environment = createInstanceEnvironment(
    input.inheritedEnvironment,
    input.selectedEnvironment,
  );
  const children = new Set<SupervisedProcess>();
  const launches = new Set<Promise<SupervisedProcess>>();
  let fenced = false;
  let launchOutcomeUnknown = false;
  const terminate = async (options: {
    readonly graceMs: number;
    readonly killWaitMs: number;
  }) => {
    if (
      [options.graceMs, options.killWaitMs].some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > 60_000,
      )
    )
      throw new HarnessHostError("invalid_launch");
    fenced = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Start cleanup immediately, even when another launch is stuck at its policy boundary.
    const stopping = [...children].map((child) => child.terminate(options));
    const cleanup = (async () => {
      await Promise.allSettled([...launches]);
      const results = await Promise.all([
        ...stopping,
        ...[...children].map((child) => child.terminate(options)),
      ]);
      if (launchOutcomeUnknown)
        results.push({
          kind: "unknown",
          processGeneration,
          reason: "inspection_failed",
        });
      return results;
    })();
    try {
      return await Promise.race([
        cleanup,
        new Promise<readonly ProcessGroupSettlement[]>((resolve) => {
          timer = setTimeout(
            () =>
              resolve([
                {
                  kind: "unknown",
                  processGeneration,
                  reason: "timeout",
                },
              ]),
            options.graceMs + options.killWaitMs + 50,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return Object.freeze({
    workspaceRoot,
    instanceDirectory,
    journalDirectory,
    processGeneration,
    environment,
    launch: (request: {
      readonly executable: string;
      readonly args: readonly string[];
    }) => {
      if (fenced) return Promise.reject(new HarnessHostError("stale_session"));
      const launchRequest = {
        executable: request.executable,
        args: [...request.args],
      };
      const pending = (async () => {
        const cwd = await resolveWorkspaceDirectory(
          workspaceRoot,
          workspaceRoot,
        );
        if (fenced || cwd !== workspaceRoot)
          throw new HarnessHostError("invalid_launch");
        await launchPolicy.assertEnforced({
          workspaceRoot,
          instanceDirectory,
          journalDirectory,
          processGeneration,
        });
        if (fenced) throw new HarnessHostError("stale_session");
        let child: SupervisedProcess;
        try {
          child = await launchPolicy.launch({
            ...launchRequest,
            cwd,
            env: environment,
            processGeneration,
          });
        } catch {
          // A launch policy can lose its receipt after an external process starts.
          launchOutcomeUnknown = true;
          fenced = true;
          throw new HarnessHostError("invalid_launch");
        }
        children.add(child);
        if (child.processGeneration !== processGeneration) {
          launchOutcomeUnknown = true;
          fenced = true;
        }
        if (fenced) {
          await child.terminate({ graceMs: 100, killWaitMs: 1000 });
          throw new HarnessHostError("stale_session");
        }
        return child;
      })();
      launches.add(pending);
      void pending
        .finally(() => launches.delete(pending))
        .catch(() => undefined);
      return pending;
    },
    fence: () => {
      fenced = true;
    },
    terminateProcesses: terminate,
  });
}
