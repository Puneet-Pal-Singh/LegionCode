import { HarnessHostError } from "./errors.js";
import type { ProcessLaunch, SupervisedProcess } from "./ProcessSupervisor.js";
import {
  createInstanceEnvironment,
  resolveInstanceDirectory,
  resolveWorkspaceDirectory,
} from "./InstanceEnvironment.js";

/** The composition root supplies a real OS launch boundary; there is no unrestricted default. */
export interface HarnessLaunchPolicy {
  launch(request: ProcessLaunch): Promise<SupervisedProcess>;
}

/** Host-local paths and process services. Never serialized into product events or client metadata. */
export interface HarnessHost {
  readonly workspaceRoot: string;
  readonly instanceDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  launch(request: {
    readonly executable: string;
    readonly args: readonly string[];
  }): Promise<SupervisedProcess>;
}

export async function createHarnessHost(input: {
  readonly workspaceRoot: string;
  readonly instanceDirectory: string;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  /** Only the selected instance/connection's auth and configuration variables. */
  readonly selectedEnvironment: Readonly<Record<string, string>>;
  readonly launchPolicy: HarnessLaunchPolicy;
}): Promise<HarnessHost> {
  const workspaceRoot = await resolveWorkspaceDirectory(
    input.workspaceRoot,
    input.workspaceRoot,
  );
  const instanceDirectory = await resolveInstanceDirectory(
    workspaceRoot,
    input.instanceDirectory,
  );
  const environment = createInstanceEnvironment(
    input.inheritedEnvironment,
    input.selectedEnvironment,
  );
  return Object.freeze({
    workspaceRoot,
    instanceDirectory,
    environment,
    launch: async (request: {
      readonly executable: string;
      readonly args: readonly string[];
    }) => {
      // Recheck a renamed/symlink-substituted root immediately before the policy boundary.
      const cwd = await resolveWorkspaceDirectory(workspaceRoot, workspaceRoot);
      if (cwd !== workspaceRoot) throw new HarnessHostError("invalid_launch");
      return input.launchPolicy.launch({ ...request, cwd, env: environment });
    },
  });
}
