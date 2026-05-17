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
import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";

interface RuntimeSessionRecord {
  runId: string;
  taskId: string;
  repoPath: string;
  expiresAt: number;
  token: string;
  createdAt: number;
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

export class AgentRuntime extends DurableObject {
  private sandbox: Sandbox | null = null;
  private composedRuntime: ComposedRuntime | null = null;
  private plugins: Map<string, IPlugin> = new Map();
  private stream = new StreamHandler();
  private storageService: StorageService;
  private readonly artifactBucket: ComposeRuntimeInput["r2Bucket"];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.artifactBucket = env.ARTIFACTS as unknown as ComposeRuntimeInput["r2Bucket"];
    this.storageService = new StorageService(env.ARTIFACTS);
    this.setupRegistry();
  }

  // 1. SRP: Separate Registry logic
  private setupRegistry() {
    [
      new PythonPlugin(),
      new RedisPlugin(),
      new FileSystemPlugin(),
      new GitPlugin(),
      new GitHubPlugin(),
      new GitHubCliPlugin(),
      new BashPlugin(),
      new NodePlugin(),
      new RustPlugin(),
    ].forEach((p) => this.plugins.set(p.name, p));
  }

  // 2. SRP: Sandbox Lifecycle only
  private async ensureSandbox(): Promise<Sandbox> {
    if (!this.sandbox) {
      const shortId = this.ctx.id.toString().substring(0, 50);
      this.sandbox = getSandbox(this.env.Sandbox, shortId);

      // Async boot - don't block the caller
      this.bootPlugins();
    }
    return this.sandbox;
  }

  private async ensureComposedRuntime(): Promise<ComposedRuntime> {
    if (this.composedRuntime) {
      return this.composedRuntime;
    }

    const sandbox = await this.ensureSandbox();
    this.composedRuntime = composeRuntime({
      durableObjectState: this.ctx as unknown as LegacyDurableObjectState,
      sandbox,
      plugins: this.plugins,
      r2Bucket: this.artifactBucket,
    });
    return this.composedRuntime;
  }

  private async bootPlugins() {
    if (!this.sandbox) return;

    // Log to terminal console for you, but don't spam the user's UI terminal
    console.log("[AgentRuntime] Booting plugins in background...");

    const promises = Array.from(this.plugins.values()).map(async (plugin) => {
      if (plugin.setup) {
        await plugin.setup(this.sandbox!);
      }
    });

    await Promise.all(promises).catch((e) => {
      this.stream.broadcast(
        "error",
        "One or more background services failed to start.",
      );
    });

    // Only one clean message to the user
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
    const runtime = await this.ensureComposedRuntime();
    return runtime.executionPort.executeTask(sessionId, input, hooks);
  }

  getManifest() {
    return Array.from(this.plugins.values()).flatMap((p) => p.tools);
  }

  async storeExecutionSession(
    sessionId: string,
    session: RuntimeSessionRecord,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(this.getExecutionSessionKey(sessionId), session);
    });
  }

  async getExecutionSession(sessionId: string): Promise<RuntimeSessionRecord | null> {
    const session = await this.ctx.storage.get<RuntimeSessionRecord>(
      this.getExecutionSessionKey(sessionId),
    );
    return session ?? null;
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
    await this.ctx.blockConcurrencyWhile(async () => {
      const logs = await this.ctx.storage.list({
        prefix: this.getExecutionLogPrefix(sessionId),
      });
      const logKeys = Array.from(logs.keys());
      const keysToDelete = [
        this.getExecutionSessionKey(sessionId),
        ...logKeys,
      ];
      for (let i = 0; i < keysToDelete.length; i += 128) {
        const chunk = keysToDelete.slice(i, i + 128);
        await this.ctx.storage.delete(chunk);
      }
    });
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
