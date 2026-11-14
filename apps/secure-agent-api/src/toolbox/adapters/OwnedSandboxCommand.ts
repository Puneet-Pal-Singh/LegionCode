import type { NativeCommandCapability, NativeCommandSpec } from "../contracts/OwnedSandboxCommand";
import type { ToolboxCommandExecutor, ToolboxCommandResult } from "../contracts/ToolboxSession";

/** Toolbox policy/events stay shared; this adapter never evaluates its shell string. */
export class OwnedSandboxCommand implements ToolboxCommandExecutor {
  constructor(private readonly owner: NativeCommandCapability, private readonly input: NativeCommandSpec) {}
  execute(): Promise<ToolboxCommandResult> { return this.owner.execute(this.input); }
}
