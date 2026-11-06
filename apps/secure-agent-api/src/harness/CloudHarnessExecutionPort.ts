import type { DelegatedHarnessPort } from "@repo/runtime-kernel";
import {
  HarnessSessionSchema,
  type HarnessSession,
} from "@repo/worker-protocol";
import {
  CloudHarnessRequestSchema,
  sameCloudHarnessSession,
  cloudHarnessRequestTarget,
} from "./CloudHarnessBridgeProtocol";
import { encodeCloudHarnessBridgeFrame } from "./CloudHarnessBridgeLimits";
import { CloudHarnessBridgeClient } from "./CloudHarnessBridgeClient";
import { CloudHarnessSupervisor } from "./CloudHarnessSupervisor";

/** Real Worker-side kernel consumer. No concrete driver or Node runtime imports. */
export class CloudHarnessExecutionPort implements DelegatedHarnessPort {
  // Deliberately retained for this composition's lifetime: eviction requires
  // canonical terminal + physical quiescence + immutable artifact settlement,
  // plus a durable command tombstone requery. No such release port is supplied.
  private readonly clients = new Map<string, CloudHarnessBridgeClient>();
  private readonly dispatched = new Set<string>();

  constructor(
    private readonly supervisor: CloudHarnessSupervisor,
    private readonly requestTimeoutMs = 60_000,
  ) {
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 3_600_000
    )
      throw new Error("Invalid cloud harness request timeout");
  }

  async open(
    input: Parameters<DelegatedHarnessPort["open"]>[0],
  ): Promise<HarnessSession> {
    if (input.command.resumeSession !== null)
      throw new Error(
        "Cloud harness prior-generation resume unavailable; recovery required",
      );
    const request = CloudHarnessRequestSchema.parse({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "open",
      command: input.command,
    });
    encodeCloudHarnessBridgeFrame(request); // preflight BEFORE bootstrap or credential resolution
    if (this.clients.size >= 128)
      throw new Error("Cloud harness session capacity reached");
    const client = new CloudHarnessBridgeClient(
      this.supervisor,
      { operation: "open", command: input.command },
      this.requestTimeoutMs,
    );
    try {
      await client.connect(input.signal);
      const result = await client.request(request, () =>
        this.claim(`open:${input.command.commandId}`),
      );
      if (result.operation !== "open")
        throw new Error("Cloud harness open correlation mismatch");
      const session = HarnessSessionSchema.parse(result.value);
      if (
        session.runAttemptId !== input.command.selection.runAttemptId ||
        session.instanceId !== input.command.selection.instanceId
      )
        throw new Error("Cloud harness learned binding mismatch");
      await this.supervisor.authorize({ operation: "observe", session });
      this.clients.set(JSON.stringify(session), client);
      return session;
    } catch {
      client.fence();
      throw new Error("Cloud harness open unavailable; recovery required");
    }
  }

  async execute(
    input: Parameters<DelegatedHarnessPort["execute"]>[0],
  ): Promise<void> {
    const request = CloudHarnessRequestSchema.parse({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "execute",
      command: input.command,
      session: input.session,
    });
    encodeCloudHarnessBridgeFrame(request);
    const client = this.requireClient(input.session);
    client.setObserver(input.session, input.observe);
    await this.supervisor.authorize({
      operation: "execute",
      command: input.command,
    });
    await this.supervisor.authorize({
      operation: "execute",
      session: input.session,
    });
    if (input.signal.aborted)
      throw new Error("Cloud harness execution aborted; recovery required");
    const abort = () => client.fence();
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      await client.request(request, () =>
        this.claim(`execute:${input.command.commandId}`),
      );
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  }

  async observeExisting(
    input: Parameters<DelegatedHarnessPort["observeExisting"]>[0],
  ): Promise<void> {
    const key = JSON.stringify(HarnessSessionSchema.parse(input.session));
    if (input.signal.aborted) {
      this.clients.get(key)?.fence();
      throw new Error("Cloud harness observation aborted; recovery required");
    }
    const request = CloudHarnessRequestSchema.parse({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "observe",
      session: input.session,
    });
    encodeCloudHarnessBridgeFrame(request);
    // Explicit reattachment only. Never retry open/execute/control after loss.
    let client = this.clients.get(key);
    if (!client || client.isClosed) {
      if (!client && this.clients.size >= 128)
        throw new Error("Cloud harness session capacity reached");
      client = new CloudHarnessBridgeClient(
        this.supervisor,
        { operation: "observe", session: input.session },
        this.requestTimeoutMs,
      );
      client.setObserver(input.session, input.observe);
      await client.connect(input.signal);
      this.clients.set(key, client);
    } else {
      client.setObserver(input.session, input.observe);
    }
    // This is the canonical recovery operation's signal, not a browser socket.
    // A reused connection must honor the new caller just like a new connection.
    const activeClient = client;
    const abort = () => activeClient.fence();
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted) {
        activeClient.fence();
        throw new Error("Cloud harness observation aborted; recovery required");
      }
      await activeClient.request(request);
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  }

  async control(
    command: Parameters<DelegatedHarnessPort["control"]>[0],
  ): Promise<{ readonly accepted: boolean }> {
    const request = CloudHarnessRequestSchema.parse({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "control",
      command,
    });
    encodeCloudHarnessBridgeFrame(request);
    const target = cloudHarnessRequestTarget(request);
    await this.supervisor.authorize(target);
    const cleanup = command.kind === "interrupt" || command.kind === "dispose";
    const session =
      command.kind === "reply" || command.kind === "user_input_reply"
        ? command.reply.replyTo.session
        : command.session;
    if (!cleanup) {
      const result = await this.requireClient(session).request(request, () =>
        this.claim(`control:${command.commandId}`),
      );
      if (result.operation !== "control")
        throw new Error("Cloud harness control correlation mismatch");
      return result.value;
    }
    // Dedicated cleanup connection: revoked-auth observations on an old active
    // stream cannot block Stop's independently authorized response.
    const client = new CloudHarnessBridgeClient(
      this.supervisor,
      target,
      this.requestTimeoutMs,
    );
    try {
      await client.connect(new AbortController().signal);
      const result = await client.request(request, () =>
        this.claim(`control:${command.commandId}`),
      );
      if (result.operation !== "control")
        throw new Error("Cloud harness control correlation mismatch");
      return result.value;
    } finally {
      client.fence();
    }
  }

  async awaitQuiescence(
    input: Parameters<DelegatedHarnessPort["awaitQuiescence"]>[0],
  ) {
    const request = CloudHarnessRequestSchema.parse({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "quiescence",
      ...input,
    });
    encodeCloudHarnessBridgeFrame(request);
    const target = cloudHarnessRequestTarget(request);
    const client = new CloudHarnessBridgeClient(
      this.supervisor,
      target,
      this.requestTimeoutMs,
    );
    try {
      await client.connect(new AbortController().signal);
      const result = await client.request(request);
      if (
        result.operation !== "quiescence" ||
        !sameCloudHarnessSession(result.value.session, input.session)
      )
        throw new Error("Cloud harness quiescence binding mismatch");
      return result.value;
    } catch {
      return {
        status: "unknown" as const,
        session: input.session,
        reason: "transport_lost" as const,
      };
    } finally {
      client.fence();
    }
  }

  private requireClient(session: HarnessSession): CloudHarnessBridgeClient {
    const client = this.clients.get(
      JSON.stringify(HarnessSessionSchema.parse(session)),
    );
    if (!client)
      throw new Error("Cloud harness session unavailable; recovery required");
    return client;
  }

  private claim(key: string): void {
    if (this.dispatched.has(key) || this.dispatched.size >= 512)
      throw new Error("Cloud harness command unavailable; recovery required");
    // Runtime's durable admission/reply claim remains authoritative across restarts.
    this.dispatched.add(key);
  }
}
