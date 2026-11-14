import { describe, expect, it, vi } from "vitest";
import { DesktopHostedAccount } from "./hosted-account";
import { DesktopHostedAppServer } from "./hosted-app-server";
import { HostedRequestSchema, parseHostedEnvelope, type HostedResponseEvent } from "../shared/hosted-request";

import {
  assertTrustedDesktopFrame,
  resolveDesktopAppServerRequest,
  WorkspaceSelectionTokens,
} from "./request-security";

const hostedSession = vi.hoisted(() => ({ fetch: vi.fn(), flush: vi.fn(async () => undefined) }));
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  session: { fromPartition: () => ({
    fetch: hostedSession.fetch,
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    on: () => undefined,
    clearStorageData: async () => undefined,
    cookies: { flushStore: hostedSession.flush },
  }) },
}));

describe("Desktop App Server request security", () => {
  it("rejects malformed and unknown request envelopes", async () => {
    const selections = new WorkspaceSelectionTokens();
    expect(() =>
      resolveDesktopAppServerRequest(
        { protocolVersion: "wrong", method: "thread/list", params: {} },
        1,
        selections,
      ),
    ).toThrow();
    expect(() =>
      resolveDesktopAppServerRequest(
        { protocolVersion: "1.0.0", method: "filesystem/read", params: {} },
        1,
        selections,
      ),
    ).toThrow();
    const scope = { target: "production" as const, accountId: "account-fixture", generation: 3 };
    const input = {
      requestId: crypto.randomUUID(), scope,
      serializedEnvelope: JSON.stringify({ protocolVersion: "1.0.0", method: "initialize", params: {
        client: { id: "desktop-fixture", version: "1" }, requestedCapabilities: [],
      } }),
    };
    expect(() => HostedRequestSchema.parse({ ...input, url: "https://untrusted.example" })).toThrow();
    expect(() => HostedRequestSchema.parse({ ...input, scope: { ...scope, target: "arbitrary" } })).toThrow();
    for (const method of ["workspace/current", "thread/list", "provider/current"]) {
      expect(() => parseHostedEnvelope(JSON.stringify({ protocolVersion: "1.0.0", method, params: {} }))).toThrow();
    }
    let releaseBody!: () => void;
    let metadataReady!: () => void;
    let drained = false;
    const released = new Promise<void>((resolve) => { releaseBody = resolve; });
    const observed = new Promise<void>((resolve) => { metadataReady = resolve; });
    const events: HostedResponseEvent[] = [];
    const hosted = new DesktopHostedAppServer({
      run: async (captured, operation) => {
        expect(captured).toEqual(scope);
        return operation({
          fetch: async (url: string, options: RequestInit) => {
            expect(url).toBe("https://brain.legioncode.dev/app-server/request");
            expect(options.credentials).toBe("include");
            expect(new Headers(options.headers).has("Authorization")).toBe(false);
            expect(new Headers(options.headers).has("Cookie")).toBe(false);
            return new Response(new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("{broken"));
                await released;
                drained = true;
                controller.close();
              },
            }), { headers: { "Content-Type": "application/json", "X-Run-Id": "run_fixture", "Set-Cookie": "private-fixture" } });
          },
        } as unknown as Electron.Session);
      },
    });
    let settled = false;
    const result = hosted.request(input, (event) => {
      events.push(event);
      metadataReady();
      throw new Error("Renderer observer failed");
    }).then((value) => { settled = true; return value; });
    await observed;
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    await expect(hosted.request(input, () => undefined)).rejects.toThrow("pending");
    releaseBody();
    expect(await result).toMatchObject({
      requestId: input.requestId, scope, ok: false,
      metadata: { status: 200, runId: "run_fixture", threadId: null, turnId: null, runAttemptId: null },
    });
    expect(drained).toBe(true);
    expect(events).toEqual([{ requestId: input.requestId, scope, metadata: {
      status: 200, runId: "run_fixture", threadId: null, turnId: null, runAttemptId: null,
    } }]);
  });

  it("rejects renderer-supplied paths and rewrites a sender-bound picker token", () => {
    const selections = new WorkspaceSelectionTokens();
    const request = {
      protocolVersion: "1.0.0",
      method: "workspace/grant",
      params: { path: "/private/repository" },
    };
    expect(() => resolveDesktopAppServerRequest(request, 14, selections)).toThrow(
      "Desktop workspace grants require a picker selection",
    );

    selections.issue(
      "one-time-selection-token",
      "/private/repository",
      14,
      Date.now() + 5_000,
    );
    expect(() =>
      resolveDesktopAppServerRequest(
        {
          protocolVersion: "1.0.0",
          method: "workspace/grant",
          params: { selectionToken: "one-time-selection-token" },
        },
        15,
        selections,
      ),
    ).toThrow("Workspace selection is expired or unavailable");

    const resolved = resolveDesktopAppServerRequest(
      {
        protocolVersion: "1.0.0",
        method: "workspace/grant",
        params: { selectionToken: "one-time-selection-token" },
      },
      14,
      selections,
    );
    expect(resolved.params).toEqual({ path: "/private/repository" });
    expect(() =>
      resolveDesktopAppServerRequest(
        {
          protocolVersion: "1.0.0",
          method: "workspace/grant",
          params: { selectionToken: "one-time-selection-token" },
        },
        14,
        selections,
      ),
    ).toThrow("Workspace selection is expired or unavailable");
  });

  it("invalidates replaced selections and expires at the exact deadline", () => {
    const selections = new WorkspaceSelectionTokens();
    selections.issue("first-token", "/first", 14, 100);
    selections.issue("second-token", "/second", 14, 200);
    expect(selections.consume("first-token", 14, 50)).toBeNull();
    expect(selections.consume("second-token", 14, 200)).toBeNull();
  });

  it("rejects subframes, unregistered windows, and renderer URL changes", async () => {
    const base = {
      senderFrameRoutingId: 3,
      mainFrameRoutingId: 3,
      senderFrameUrl: "file:///app/renderer/index.html",
      expectedRendererUrl: "file:///app/renderer/index.html",
      hasDesktopWindow: true,
    };
    expect(() => assertTrustedDesktopFrame(base)).not.toThrow();
    expect(() =>
      assertTrustedDesktopFrame({ ...base, senderFrameRoutingId: 4 }),
    ).toThrow("Untrusted Desktop renderer");
    expect(() =>
      assertTrustedDesktopFrame({ ...base, hasDesktopWindow: false }),
    ).toThrow("Untrusted Desktop renderer");
    expect(() =>
      assertTrustedDesktopFrame({ ...base, senderFrameUrl: "https://example.com" }),
    ).toThrow("Untrusted Desktop renderer");

    for (const operation of ["disconnect", "close"] as const) {
      const endpoints: string[] = [];
      hostedSession.fetch.mockImplementation(async (url: string) => {
        endpoints.push(new URL(url).pathname);
        if (url.endsWith("/auth/logout")) return Response.json({ success: true });
        if (!url.endsWith("/auth/session")) throw new Error("Unexpected hosted operation");
        return Response.json({ authenticated: true, user: {
          id: "account-fixture", login: "fixture", avatar: "", email: null, name: null,
        } });
      });
      const account = new DesktopHostedAccount();
      const status = await account.status();
      const scope = { target: status.target, accountId: "account-fixture", generation: status.generation };
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const original = account.run(scope, async () => { started(); await held; return "completed"; });
      await entered;
      let closed = false;
      const closing = account[operation]().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(() => account.run(scope, async () => "must not start")).toThrow("changed");
      release();
      await expect(original).rejects.toThrow("changed");
      await closing;
      expect(closed).toBe(true);
      expect(endpoints).toEqual(operation === "disconnect" ? ["/auth/session", "/auth/logout"] : ["/auth/session"]);
    }
  });
});
