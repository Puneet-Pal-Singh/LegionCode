import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type {
  HarnessDriver,
  HarnessLiveSession,
} from "@repo/harness-core/server";
import { HarnessHostError } from "@repo/harness-core/server";
import { HarnessStartCommandSchema } from "@repo/worker-protocol";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  CLAUDE_TRANSPORT_FAMILY,
} from "../settings.js";
import {
  ClaudeSelectedAccountGuard,
  type ClaudeSelectedAccountBinding,
  frozenClaudeLaunchEnvironment,
} from "./ClaudeAuthentication.js";
import { ClaudeSession } from "./ClaudeSession.js";

/** Same thin driver is composed by local App Server and the cloud Node host. */
export class ClaudeDriver implements HarnessDriver {
  readonly kind = "claude" as const;

  private readonly selectedAccount: ClaudeSelectedAccountBinding;

  constructor(selectedAccount: ClaudeSelectedAccountBinding) {
    this.selectedAccount = Object.freeze({
      ...selectedAccount,
      scope: Object.freeze({ ...selectedAccount.scope }),
      credentialReference: Object.freeze({
        ...selectedAccount.credentialReference,
      }),
    });
  }

  async open(
    input: Parameters<HarnessDriver["open"]>[0],
  ): Promise<HarnessLiveSession> {
    const command = HarnessStartCommandSchema.parse(input.command);
    if (input.signal.aborted) throw new HarnessHostError("stale_session");
    const selection = command.selection;
    if (
      selection.harness !== this.kind ||
      selection.transport !== CLAUDE_TRANSPORT_FAMILY ||
      selection.runtimeVersion !== CLAUDE_CODE_VERSION ||
      selection.protocolVersion !== CLAUDE_AGENT_SDK_VERSION ||
      selection.billingSource !== "api_key"
    )
      throw new HarnessHostError("invalid_launch");
    // Recovery must reconcile the prior journal and fence old work before a native resume.
    if (command.resumeSession !== null)
      throw new HarnessHostError("request_unavailable");
    if (command.filesystemRoot !== input.host.workspaceRoot)
      throw new HarnessHostError("invalid_launch");
    const account = new ClaudeSelectedAccountGuard(
      this.selectedAccount,
      command,
      input.host,
      input.signal,
    );
    const assertCurrent = await account.authorize(input.signal);
    const environment = frozenClaudeLaunchEnvironment(input.host.environment);
    // Host.launch uses its frozen env, not SDK SpawnOptions.env. Require exact agreement.
    const keys = new Set([
      ...Object.keys(environment),
      ...Object.keys(input.host.environment),
    ]);
    if (
      [...keys].some((key) => environment[key] !== input.host.environment[key])
    )
      throw new HarnessHostError("invalid_launch");
    const configuration = await realpath(environment.CLAUDE_CONFIG_DIR!);
    const fromInstance = relative(input.host.instanceDirectory, configuration);
    if (
      isAbsolute(fromInstance) ||
      fromInstance === ".." ||
      fromInstance.startsWith(`..${sep}`)
    )
      throw new HarnessHostError("invalid_launch");
    assertCurrent();
    return new ClaudeSession({ ...input, command }, account);
  }
}
