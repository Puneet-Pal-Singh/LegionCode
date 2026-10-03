import {
  AppServerRequestSchema,
  type AppServerRequest,
} from "@legioncode/app-server/protocol";

export type TrustedFrameFacts = {
  senderFrameRoutingId: number | undefined;
  mainFrameRoutingId: number | undefined;
  senderFrameUrl: string | undefined;
  expectedRendererUrl: string | undefined;
  hasDesktopWindow: boolean;
};

export function assertTrustedDesktopFrame(facts: TrustedFrameFacts): void {
  if (
    !facts.hasDesktopWindow ||
    facts.mainFrameRoutingId === undefined ||
    facts.senderFrameRoutingId === undefined ||
    facts.senderFrameRoutingId !== facts.mainFrameRoutingId ||
    facts.senderFrameUrl === undefined ||
    facts.senderFrameUrl !== facts.expectedRendererUrl
  ) {
    throw new Error("Untrusted Desktop renderer");
  }
}

export class WorkspaceSelectionTokens {
  private readonly selections = new Map<
    string,
    { path: string; senderId: number; expiresAt: number }
  >();

  issue(
    token: string,
    path: string,
    senderId: number,
    expiresAt: number,
  ): void {
    this.clearForSender(senderId);
    this.selections.set(token, { path, senderId, expiresAt });
  }

  consume(token: string, senderId: number, now = Date.now()): string | null {
    const selection = this.selections.get(token);
    if (!selection || selection.senderId !== senderId) return null;
    this.selections.delete(token);
    if (selection.expiresAt <= now) return null;
    return selection.path;
  }

  clearForSender(senderId: number): void {
    for (const [token, selection] of this.selections) {
      if (selection.senderId === senderId) this.selections.delete(token);
    }
  }

  clear(): void {
    this.selections.clear();
  }
}

export function resolveDesktopAppServerRequest(
  value: unknown,
  senderId: number,
  selections: WorkspaceSelectionTokens,
): AppServerRequest {
  const request = AppServerRequestSchema.parse(value);
  if (request.method !== "workspace/grant") return request;
  if (!("selectionToken" in request.params)) {
    throw new Error("Desktop workspace grants require a picker selection");
  }

  const path = selections.consume(request.params.selectionToken, senderId);
  if (!path) throw new Error("Workspace selection is expired or unavailable");

  return AppServerRequestSchema.parse({
    ...request,
    params: { path },
  });
}
