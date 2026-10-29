// apps/secure-agent-api/src/core/AgentRuntime.ts
// RECONSTRUCTABILITY: Execution sessions and logs exist only in DO storage.
// Chat history is dual-written to DO (runtime cache) and Postgres
// (via agent/brain -> PostgresTranscriptRepository). If DO storage is
// lost, active execution sessions fail (expected), but historical chat
// messages can be reloaded from Postgres. Execution logs are ephemeral
// debugging state with no Postgres equivalent.
import { DurableObject } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  IPlugin,
  Message,
} from "../interfaces/types";
import { StreamHandler } from "./StreamHandler";
import { StorageService } from "../services/StorageService";
import { PythonPlugin } from "../plugins/PythonPlugin";
import { RedisPlugin } from "../plugins/RedisPlugin";
import { FileSystemPlugin } from "../plugins/FileSystemPlugin";
import { GitPlugin } from "../plugins/GitPlugin";
import { GitHubPlugin } from "../plugins/GitHubPlugin";
import { GitHubCliPlugin } from "../plugins/GitHubCliPlugin";
import { BashPlugin } from "../plugins/BashPlugin";
import { NodePlugin } from "../plugins/NodePlugin";
import { RustPlugin } from "../plugins/RustPlugin";
import { Env } from "../index";
import {
  composeRuntime,
  type ComposedRuntime,
  type ComposeRuntimeInput,
} from "../factories/RuntimeCompositionFactory";
import type {
  TaskExecutionHooks,
  TaskExecutionInput,
  TaskExecutionResult,
} from "../ports/SandboxExecutionPort";
import {
  workspaceLeaseKey,
  type SandboxExecutionLease,
} from "../ports/SandboxExecutionLease";
import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";

interface RuntimeSessionRecord {
  runId: string;
  taskId: string;
  repoPath: string;
  expiresAt: number;
  token: string;
  createdAt: number;
  workspaceScope: {
    runId: string;
    threadId: string;
    turnId: string;
    runAttemptId: string;
    workspaceId: string;
    root: string;
  };
  lease: SandboxExecutionLease;
  cleanupAttempts?: number;
  cleanupFailureCode?: "SANDBOX_CLEANUP_FAILED";
  cleanupRetryAt?: number;
  cleanupInProgress?: boolean;
}

interface RuntimeSessionLogEntry {
  taskId?: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source?: "stdout" | "stderr";
}

const EXECUTION_SESSION_KEY_PREFIX = "execution:session:";
const EXECUTION_LOG_KEY_PREFIX = "execution:logs:";
const CLEANUP_RETRY_BASE_MS = 15_000;
const CLEANUP_RETRY_MAX_MS = 5 * 60_000;
const SANDBOX_DESTROY_TIMEOUT_MS = 15_000;

export class AgentRuntime extends DurableObject {
  private readonly workspaceRuntimes = new Map<string, ComposedRuntime>();
  private stream = new StreamHandler();
  private storageService: StorageService;
  private readonly artifactBucket: ComposeRuntimeInput["r2Bucket"];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.artifactBucket = env.ARTIFACTS as unknown as ComposeRuntimeInput["r2Bucket"];
    this.storageService = new StorageService(env.ARTIFACTS);
  }

  private createPluginRegistry(): Map<string, IPlugin> {
    const plugins = [
      new PythonPlugin(),
      new RedisPlugin(),
      new FileSystemPlugin(),
      new GitPlugin(),
      new GitHubPlugin(),
      new GitHubCliPlugin(),
      new BashPlugin(),
      new NodePlugin(),
      new RustPlugin(),
    ];
    return new Map(plugins.map((plugin) => [plugin.name, plugin]));
  }

  private async ensureComposedRuntime(
    lease: SandboxExecutionLease,
  ): Promise<ComposedRuntime> {
    const workspaceKey = workspaceLeaseKey(lease);
    const existing = this.workspaceRuntimes.get(workspaceKey);
    if (existing) {
      existing.executionPort.registerLease(lease);
      return existing;
    }

    const sandbox = getSandbox(this.env.Sandbox, lease.sandboxId);
    const plugins = this.createPluginRegistry();
    await this.bootPlugins(sandbox, plugins);
    const runtime = composeRuntime({
      durableObjectState: this.ctx as unknown as LegacyDurableObjectState,
      sandbox,
      plugins,
      r2Bucket: this.artifactBucket,
      executionLease: lease,
    });
    this.workspaceRuntimes.set(workspaceKey, runtime);
    return runtime;
  }

  private async bootPlugins(sandbox: Sandbox, plugins: Map<string, IPlugin>) {
    console.log("[AgentRuntime] Booting plugins for scoped sandbox lease...");

    const promises = Array.from(plugins.values()).map(async (plugin) => {
      if (plugin.setup) {
        await plugin.setup(sandbox);
      }
    });
    await Promise.all(promises);
    this.stream.broadcast("system", "Environment Optimized & Ready");
  }

  // 3. SRP: Pure Protocol Handling (WebSocket Upgrade)
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (
      url.pathname === "/connect" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.stream.add(server as unknown as WebSocket);
      (server as unknown as WebSocket).accept();
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  async executeTask(
    sessionId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    if (!input.lease) {
      return {
        taskId: input.taskId,
        leaseId: "",
        correlationId: "",
        status: "failure",
        retryable: false,
        error: {
          code: "LEASE_REQUIRED",
          message: "A scoped sandbox execution lease is required",
        },
      };
    }
    const runtime = await this.ctx.blockConcurrencyWhile(async () => {
      const persisted = await this.ctx.storage.get<RuntimeSessionRecord>(
        this.getExecutionSessionKey(sessionId),
      );
      if (
        !persisted ||
        persisted.cleanupInProgress ||
        persisted.lease.leaseId !== input.lease.leaseId ||
        persisted.lease.sandboxId !== input.lease.sandboxId ||
        persisted.lease.generation !== input.lease.generation
      ) {
        return null;
      }
      return await this.ensureComposedRuntime(input.lease);
    });
    if (!runtime) {
      return {
        taskId: input.taskId,
        leaseId: input.lease.leaseId,
        correlationId: input.lease.correlationId,
        status: "sandbox_unavailable",
        retryable: true,
        error: {
          code: "SANDBOX_CLEANUP_IN_PROGRESS",
          message: "The persisted sandbox lease is unavailable for execution",
        },
      };
    }
    const result = await runtime.executionPort.executeTask(
      input.lease.leaseId,
      input,
      hooks,
    );
    if (result.status === "sandbox_unavailable") {
      const health = await runtime.executionPort.getHealth(input.lease.leaseId);
      if (!health.healthy) {
        this.workspaceRuntimes.delete(workspaceLeaseKey(input.lease));
      }
      await this.releaseLease(input.lease.leaseId);
    }
    return result;
  }

  async cancelTask(leaseId: string, taskId: string): Promise<boolean> {
    for (const [workspaceKey, runtime] of this.workspaceRuntimes) {
      const cancelled = await runtime.executionPort.cancelTask(leaseId, taskId);
      if (cancelled) {
        return true;
      }
      if (workspaceKey.includes(leaseId)) {
        return false;
      }
    }
    return false;
  }

  async releaseLease(leaseId: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const records = await this.listExecutionSessions();
      const owned = records.filter(
        ([, session]) => session.lease.leaseId === leaseId,
      );
      if (owned.length === 0) {
        await this.releaseLoadedLease(leaseId);
        return;
      }

      const now = Date.now();
      const ownedIds = new Set(owned.map(([key]) => key));
      const sandboxIds = new Set(
        owned.map(([, session]) => session.lease.sandboxId),
      );
      for (const sandboxId of sandboxIds) {
        const group = records.filter(
          ([, session]) => session.lease.sandboxId === sandboxId,
        );
        const hasOtherLiveReference = group.some(
          ([key, session]) =>
            !ownedIds.has(key) &&
            !session.cleanupInProgress &&
            session.lease.expiresAt > now,
        );

        if (hasOtherLiveReference) {
          await this.releaseLoadedLease(leaseId);
          continue;
        }

        await this.markSandboxCleanupInProgress(group);
        try {
          await this.releaseLoadedLease(leaseId);
        } catch {
          await this.persistSandboxCleanupRetry(group, now);
          await this.scheduleExecutionSessionAlarm();
          throw new Error(
            "Sandbox lease release failed; cleanup will be retried",
          );
        }

        const cleaned = await this.cleanupSandbox(sandboxId, group, now);
        if (!cleaned) {
          await this.scheduleExecutionSessionAlarm();
          throw new Error("Sandbox cleanup failed; cleanup will be retried");
        }
      }
      await this.scheduleExecutionSessionAlarm();
    });
  }

  private async releaseLoadedLease(leaseId: string): Promise<void> {
    for (const [workspaceKey, runtime] of this.workspaceRuntimes) {
      const release = await runtime.executionPort.releaseLease(leaseId, {
        destroySandbox: false,
      });
      if (release.sandboxReleased) {
        this.workspaceRuntimes.delete(workspaceKey);
      }
      if (release.released) return;
    }
  }

  getManifest() {
    return Array.from(this.createPluginRegistry().values()).flatMap(
      (plugin) => plugin.tools,
    );
  }

  async storeExecutionSession(
    sessionId: string,
    session: RuntimeSessionRecord,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const sessions = await this.listExecutionSessions();
      const sessionKey = this.getExecutionSessionKey(sessionId);
      if (
        sessions.some(
          ([key, existing]) =>
            existing.cleanupInProgress &&
            (key === sessionKey ||
              existing.lease.sandboxId === session.lease.sandboxId),
        )
      ) {
        throw new Error("Sandbox cleanup is in progress for this lease");
      }
      await this.ctx.storage.put(
        this.getExecutionSessionKey(sessionId),
        session,
      );
      await this.scheduleExecutionSessionAlarm();
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const records = await this.listExecutionSessions();
      const now = Date.now();
      const bySandbox = new Map<
        string,
        Array<[string, RuntimeSessionRecord]>
      >();
      for (const entry of records) {
        const group = bySandbox.get(entry[1].lease.sandboxId) ?? [];
        group.push(entry);
        bySandbox.set(entry[1].lease.sandboxId, group);
      }

      for (const [sandboxId, group] of bySandbox) {
        const cleanupCandidates = group.filter(
          ([, session]) =>
            session.cleanupInProgress || session.lease.expiresAt <= now,
        );
        const due = cleanupCandidates.filter(
          ([, session]) =>
            session.cleanupRetryAt === undefined ||
            session.cleanupRetryAt <= now,
        );
        if (due.length === 0) continue;

        const hasLiveReference = group.some(
          ([, session]) =>
            !session.cleanupInProgress && session.lease.expiresAt > now,
        );
        if (hasLiveReference) continue;

        await this.markSandboxCleanupInProgress(cleanupCandidates);
        await this.cleanupSandbox(sandboxId, cleanupCandidates, now);
      }

      await this.scheduleExecutionSessionAlarm();
    });
  }

  async getExecutionSession(
    sessionId: string,
  ): Promise<RuntimeSessionRecord | null> {
    const session = await this.ctx.storage.get<RuntimeSessionRecord>(
      this.getExecutionSessionKey(sessionId),
    );
    return session && !session.cleanupInProgress ? session : null;
  }

  async appendExecutionLog(
    sessionId: string,
    entry: RuntimeSessionLogEntry,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const key = this.getExecutionLogKey(sessionId, entry.timestamp);
      await this.ctx.storage.put(key, entry);
    });
  }

  async getExecutionLogs(
    sessionId: string,
    since?: number,
    taskId?: string,
  ): Promise<RuntimeSessionLogEntry[]> {
    const list = await this.ctx.storage.list<RuntimeSessionLogEntry>({
      prefix: this.getExecutionLogPrefix(sessionId),
    });
    const entries = Array.from(list.values()).sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    return entries.filter((entry) => {
      const matchesSince = since === undefined || entry.timestamp > since;
      const matchesTask = taskId === undefined || entry.taskId === taskId;
      return matchesSince && matchesTask;
    });
  }

  async deleteExecutionSession(sessionId: string): Promise<void> {
    const existing = await this.ctx.storage.get<RuntimeSessionRecord>(
      this.getExecutionSessionKey(sessionId),
    );
    if (existing) {
      await this.releaseLease(existing.lease.leaseId);
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const session = await this.ctx.storage.get<RuntimeSessionRecord>(
        this.getExecutionSessionKey(sessionId),
      );
      if (session?.cleanupInProgress) {
        throw new Error("Sandbox cleanup is pending for this session");
      }
      await this.deleteExecutionSessionRecord(sessionId);
      await this.scheduleExecutionSessionAlarm();
    });
  }

  private async listExecutionSessions(): Promise<
    Array<[string, RuntimeSessionRecord]>
  > {
    const sessions = await this.ctx.storage.list<RuntimeSessionRecord>({
      prefix: EXECUTION_SESSION_KEY_PREFIX,
    });
    return Array.from(sessions.entries());
  }

  private async scheduleExecutionSessionAlarm(): Promise<void> {
    const sessions = await this.listExecutionSessions();
    if (sessions.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    let nextAlarm = Number.POSITIVE_INFINITY;
    for (const [, session] of sessions) {
      if (session.cleanupInProgress) {
        nextAlarm = Math.min(
          nextAlarm,
          Math.max(session.cleanupRetryAt ?? now + 1, now + 1),
        );
        continue;
      }
      if (session.lease.expiresAt > now) {
        nextAlarm = Math.min(nextAlarm, session.lease.expiresAt);
        continue;
      }
      const protectedUntil = sessions
        .map(([, other]) => other)
        .filter(
          (other) =>
            other.lease.sandboxId === session.lease.sandboxId &&
            other.lease.expiresAt > now,
        )
        .reduce(
          (earliest, other) => Math.min(earliest, other.lease.expiresAt),
          Number.POSITIVE_INFINITY,
        );
      const nextEligible = Number.isFinite(protectedUntil)
        ? Math.max(protectedUntil, session.cleanupRetryAt ?? now)
        : Math.max(session.cleanupRetryAt ?? now, now + 1);
      nextAlarm = Math.min(nextAlarm, nextEligible);
    }
    await this.ctx.storage.setAlarm(nextAlarm);
  }

  private async markSandboxCleanupInProgress(
    group: Array<[string, RuntimeSessionRecord]>,
  ): Promise<void> {
    for (const [key] of group) {
      const session = await this.ctx.storage.get<RuntimeSessionRecord>(key);
      if (!session) continue;
      await this.ctx.storage.put(key, { ...session, cleanupInProgress: true });
    }
  }

  private async persistSandboxCleanupRetry(
    group: Array<[string, RuntimeSessionRecord]>,
    now: number,
  ): Promise<void> {
    for (const [key] of group) {
      const session = await this.ctx.storage.get<RuntimeSessionRecord>(key);
      if (!session) continue;
      const attempts = (session.cleanupAttempts ?? 0) + 1;
      const delay = Math.min(
        CLEANUP_RETRY_BASE_MS * 2 ** (attempts - 1),
        CLEANUP_RETRY_MAX_MS,
      );
      await this.ctx.storage.put(key, {
        ...session,
        cleanupInProgress: true,
        cleanupAttempts: attempts,
        cleanupFailureCode: "SANDBOX_CLEANUP_FAILED",
        cleanupRetryAt: now + delay,
      });
    }
  }

  private async cleanupSandbox(
    sandboxId: string,
    group: Array<[string, RuntimeSessionRecord]>,
    now: number,
  ): Promise<boolean> {
    try {
      // The ID comes from persisted leases; no replacement lease is issued.
      await destroySandboxWithTimeout(
        getSandbox(this.env.Sandbox, sandboxId),
        SANDBOX_DESTROY_TIMEOUT_MS,
      );
      for (const [, session] of group) {
        this.workspaceRuntimes.delete(workspaceLeaseKey(session.lease));
      }
      for (const [key] of group) {
        const sessionId = key.slice(EXECUTION_SESSION_KEY_PREFIX.length);
        await this.deleteExecutionSessionRecord(sessionId);
      }
      return true;
    } catch {
      await this.persistSandboxCleanupRetry(group, now);
      return false;
    }
  }

  private async deleteExecutionSessionRecord(sessionId: string): Promise<void> {
    const logs = await this.ctx.storage.list({
      prefix: this.getExecutionLogPrefix(sessionId),
    });
    const logKeys = Array.from(logs.keys());
    const keysToDelete = [this.getExecutionSessionKey(sessionId), ...logKeys];
    for (let i = 0; i < keysToDelete.length; i += 128) {
      await this.ctx.storage.delete(keysToDelete.slice(i, i + 128));
    }
  }

  private getExecutionSessionKey(sessionId: string): string {
    return `${EXECUTION_SESSION_KEY_PREFIX}${sessionId}`;
  }

  private getExecutionLogPrefix(sessionId: string): string {
    return `${EXECUTION_LOG_KEY_PREFIX}${sessionId}:`;
  }

  private getExecutionLogKey(sessionId: string, timestamp: number): string {
    const paddedTimestamp = timestamp.toString().padStart(15, "0");
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${this.getExecutionLogPrefix(sessionId)}${paddedTimestamp}-${suffix}`;
  }

  // 5. SRP: History Management
  async getHistory(
    runId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<{ messages: Message[]; nextCursor?: string }> {
    const listOptions: { prefix: string; limit: number; start?: string } = {
      prefix: `chat:${runId}:`,
      limit: limit + 1,
    };

    if (cursor) {
      listOptions.start = cursor;
    }

    const list = await this.ctx.storage.list<Message>(listOptions);
    const entries = Array.from(list.entries());

    let nextCursor: string | undefined;
    if (entries.length > limit) {
      const lastEntry = entries.pop();
      if (lastEntry) {
        nextCursor = lastEntry[0];
      }
    }

    // Ensure all messages have unique IDs for React rendering
    const messages = entries.map(([_, msg], index) => ({
      ...msg,
      id: msg.id || `${runId}-${index}-${Date.now()}`,
    }));

    return { messages, nextCursor };
  }

  async appendMessage(
    runId: string,
    message: Message,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const sessionId = this.ctx.id.toString();

      // Check idempotency
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:${idempotencyKey}`;
        const exists = await this.ctx.storage.get<string>(existingKey);
        if (exists) {
          console.log(
            `[AgentRuntime] Duplicate message ignored for idempotency key: ${idempotencyKey}`,
          );
          return;
        }
      }

      // Ensure message has an ID
      const messageWithId: Message = {
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
        id:
          message.id ||
          `${runId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      };

      const processedMessage = await this.storageService.processMessage(
        runId,
        sessionId,
        messageWithId,
      );

      const existing = await this.ctx.storage.list<Message>({
        prefix: `chat:${runId}:`,
        reverse: true,
        limit: 1,
      });

      const lastEntry = Array.from(existing.entries())[0];
      const isPartial =
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.includes("▌");

      if (lastEntry && isPartial) {
        const [lastKey, lastMsg] = lastEntry;
        if (
          lastMsg.role === "assistant" &&
          typeof lastMsg.content === "string" &&
          lastMsg.content.includes("▌")
        ) {
          await this.ctx.storage.put(lastKey, processedMessage);
          return;
        }
      }

      const timestamp = Date.now().toString().padStart(15, "0");
      const disambiguator = Math.random().toString(36).substring(2, 7);
      const key = `chat:${runId}:${timestamp}-${disambiguator}`;
      await this.ctx.storage.put(key, processedMessage);

      // Store idempotency key
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:${idempotencyKey}`;
        await this.ctx.storage.put(existingKey, key);
      }
    });
  }

  async saveHistory(
    runId: string,
    messages: Message[],
    idempotencyKey?: string,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const sessionId = this.ctx.id.toString();

      // Check idempotency
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:batch:${idempotencyKey}`;
        const exists = await this.ctx.storage.get<string>(existingKey);
        if (exists) {
          console.log(
            `[AgentRuntime] Duplicate batch ignored for idempotency key: ${idempotencyKey}`,
          );
          return;
        }
      }

      const existing = await this.ctx.storage.list({
        prefix: `chat:${runId}:`,
      });
      const chatKeys = Array.from(existing.keys());

      const idempotency = await this.ctx.storage.list({
        prefix: `idempotency:${runId}:`,
      });
      const idempotencyKeys = Array.from(idempotency.keys());

      const allKeysToDelete = [...chatKeys, ...idempotencyKeys];
      if (allKeysToDelete.length > 0) {
        // Durable Object storage.delete() has a limit of 128 keys per call
        for (let i = 0; i < allKeysToDelete.length; i += 128) {
          const chunk = allKeysToDelete.slice(i, i + 128);
          await this.ctx.storage.delete(chunk);
        }
      }

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;

        // Ensure message has an ID
        const msgWithId: Message = {
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          id: msg.id || `${runId}-msg-${i}-${Date.now()}`,
        };
        const processedMessage = await this.storageService.processMessage(
          runId,
          sessionId,
          msgWithId,
        );
        const timestamp = Date.now().toString().padStart(15, "0");
        const key = `chat:${runId}:${timestamp}-${i.toString().padStart(3, "0")}`;
        await this.ctx.storage.put(key, processedMessage);
      }

      // Store idempotency key
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:batch:${idempotencyKey}`;
        await this.ctx.storage.put(existingKey, "saved");
      }
    });
  }

  async getArtifact(key: string): Promise<string | null> {
    return await this.storageService.getArtifact(key);
  }
}

async function destroySandboxWithTimeout(
  sandbox: Sandbox,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sandbox.destroy(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Sandbox cleanup timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
