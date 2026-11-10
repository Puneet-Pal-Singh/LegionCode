import {
  HarnessStartCommandSchema,
  type HarnessStartCommand,
} from "@repo/worker-protocol";
import { HarnessHostError } from "./errors.js";
import type { HarnessDriver } from "./HarnessDriver.js";
import type { HarnessHost } from "./HarnessHost.js";

type Selection = HarnessStartCommand["selection"];
export type HarnessInstanceScope = Pick<
  Selection,
  | "userId"
  | "workspaceId"
  | "environmentId"
  | "workspaceGrantId"
  | "harness"
  | "instanceId"
  | "connectionId"
  | "authOwnerGeneration"
  | "runtimeVersion"
  | "protocolVersion"
  | "transport"
>;

export interface HarnessOpeningAuthority {
  reserve(input: { command: HarnessStartCommand; host: HarnessHost }): Promise<{
    beginDispatch(): Promise<void>;
    acknowledge(
      session: import("@repo/worker-protocol").HarnessSession,
    ): Promise<void>;
  }>;
}
export interface HarnessInstance {
  readonly scope: HarnessInstanceScope;
  readonly driver: HarnessDriver;
  readonly openingAuthority: HarnessOpeningAuthority;
  /** Existing credential and grant authorities resolve host services for this admission. */
  readonly createHost: (command: HarnessStartCommand) => Promise<HarnessHost>;
}

const scopeFields = [
  "userId",
  "workspaceId",
  "environmentId",
  "workspaceGrantId",
  "harness",
  "instanceId",
  "connectionId",
  "authOwnerGeneration",
  "runtimeVersion",
  "protocolVersion",
  "transport",
] as const;

export class HarnessRegistry {
  private readonly instances = new Map<string, HarnessInstance>();

  register(instance: HarnessInstance): void {
    if (
      !instance.scope.instanceId ||
      this.instances.has(instance.scope.instanceId) ||
      instance.driver.kind !== instance.scope.harness
    ) {
      throw new HarnessHostError("duplicate_instance");
    }
    this.instances.set(
      instance.scope.instanceId,
      Object.freeze({
        ...instance,
        scope: Object.freeze({ ...instance.scope }),
      }),
    );
  }

  resolve(raw: HarnessStartCommand): {
    readonly command: HarnessStartCommand;
    readonly instance: HarnessInstance;
  } {
    const command = HarnessStartCommandSchema.parse(raw);
    const instance = this.instances.get(command.selection.instanceId);
    if (
      !instance ||
      scopeFields.some(
        (field) => instance.scope[field] !== command.selection[field],
      )
    ) {
      throw new HarnessHostError("stale_session");
    }
    return { command, instance };
  }

  unregister(instanceId: string): void {
    this.instances.delete(instanceId);
  }
}
