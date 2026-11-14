import { useEffect, useMemo, useRef, useState } from "react";
import { readCanonicalTurnId, RunIdSchema, type ConversationScope } from "@legioncode/sdk";
import type { HostedNativeDraft } from "@legioncode/client-ui";
import { ChatRequestBodySchema, HostedSessionSchema, type HostedSession } from "@repo/platform-protocol";
import { BYOKResolutionSchema, type BYOKResolution } from "@repo/shared-types";
import type { DesktopHostedConversationController } from "./DesktopHostedConversation";

export type HostedComposerCapturePhase = "creating" | "creation-unconfirmed" | "waiting" |
  "submitting" | "unconfirmed" | "accepted" | "cancelled";
export interface HostedComposerCapture {
  readonly draft: HostedNativeDraft;
  readonly selection: Readonly<BYOKResolution>;
  readonly workspaceId: string;
  readonly session: Readonly<HostedSession> | null;
  readonly runId: string | null;
  readonly phase: HostedComposerCapturePhase;
  readonly error: string | null;
  readonly locked: boolean;
  readonly retryable: boolean;
}
interface Options {
  readonly accountKey: string | null;
  readonly accountId?: string | null;
  /** Existing metadata owner must retry/recover its same retained creation request. */
  readonly createSession: (input: { title?: string; mode?: string }) => Promise<HostedSession>;
  readonly retrySessionCreation: () => Promise<HostedSession>;
  readonly onAccepted: (capture: HostedComposerCapture) => void;
  readonly onSessionReady?: (session: HostedSession) => void;
}
type Outcome = Awaited<ReturnType<DesktopHostedConversationController["submit"]>>;
interface Capture {
  readonly draft: HostedNativeDraft;
  readonly selection: Readonly<BYOKResolution>;
  readonly workspaceId: string;
  readonly accountId: string | null;
  readonly fingerprint: string;
  readonly creator: Options["createSession"];
  readonly retryCreator: Options["retrySessionCreation"];
  readonly creationInput: Readonly<{ title: string; mode: string }>;
  readonly navigation: number;
  session: HostedSession | null;
  runId: string | null;
  phase: HostedComposerCapturePhase;
  error: string | null;
  automatic: boolean;
  started: boolean;
  accepted: boolean;
  expectedScope: ConversationScope | null;
  original: Promise<Outcome> | null;
  operation: Promise<boolean> | null;
  creation: Promise<boolean> | null;
}
interface Owner {
  readonly key: string | null;
  readonly sessions: Map<string, Capture>;
  welcome: Capture | null;
  navigation: number;
}
const pendingPhases: readonly HostedComposerCapturePhase[] = [
  "creating", "creation-unconfirmed", "waiting", "submitting", "unconfirmed",
];
const locked = (capture: Capture) => capture.original !== null || capture.creation !== null || pendingPhases.includes(capture.phase);
const view = (capture: Capture): HostedComposerCapture => Object.freeze({
  draft: capture.draft, selection: capture.selection, workspaceId: capture.workspaceId,
  session: capture.session, runId: capture.runId, phase: capture.phase,
  error: capture.error, locked: locked(capture),
  retryable: !capture.accepted && !capture.original && !capture.creation &&
    (capture.phase === "unconfirmed" || capture.phase === "creation-unconfirmed" ||
      (capture.phase === "waiting" && !capture.automatic)),
});
function fingerprint(draft: HostedNativeDraft, selection: BYOKResolution, workspaceId: string): string {
  return JSON.stringify([workspaceId, draft.id, draft.prompt, draft.configuration,
    selection.providerId, selection.credentialId, selection.modelId]);
}
function freezeSession(session: HostedSession, workspaceId: string, accountId: string | null): { session: HostedSession; runId: string } {
  const saved = HostedSessionSchema.parse(session);
  if ((accountId !== null && saved.userId !== accountId) || saved.workspaceId !== workspaceId || saved.archivedAt !== null) throw new Error("The cloud task does not match the selected repository.");
  return { session: Object.freeze(saved), runId: RunIdSchema.parse(saved.activeRunId ?? saved.latestRunId) };
}

/** Volatile parent-owned draft delivery only. The injected controller owns every runtime command. */
export function useDesktopHostedComposerHandoff(options: Options) {
  const owner = useMemo<Owner>(() => ({ key: options.accountKey, sessions: new Map(), welcome: null, navigation: 0 }), [options.accountKey, options.accountId]);
  const current = useRef(owner);
  const latest = useRef(options);
  current.current = owner;
  latest.current = options;
  const mounted = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isCurrent = () => mounted.current && current.current === owner && owner.key !== null;
  const publish = () => { if (isCurrent()) setRevision((value) => value + 1); };
  const requireCurrent = () => { if (!isCurrent()) throw new Error("The hosted account changed. Your original request has not been resent."); };
  const makeCapture = (draft: HostedNativeDraft, selection: BYOKResolution, workspaceId: string, automatic: boolean): Capture => {
    requireCurrent();
    const resolved = BYOKResolutionSchema.parse(selection);
    const configuration = ChatRequestBodySchema.pick({ providerId: true, modelId: true, mode: true,
      productMode: true, reasoningEffort: true }).parse(draft.configuration);
    if (!workspaceId || !draft.id.trim() || !draft.prompt.trim() ||
        configuration.providerId !== resolved.providerId || configuration.modelId !== resolved.modelId ||
        !["build", "plan"].includes(configuration.mode ?? "")) {
      throw new Error("Confirm the repository, provider, model and unchanged prompt before sending.");
    }
    if (resolved.pricing) Object.freeze(resolved.pricing);
    if (resolved.quota) Object.freeze(resolved.quota);
    const frozen = Object.freeze({ id: draft.id, prompt: draft.prompt, configuration: Object.freeze(configuration) });
    return { draft: frozen, selection: Object.freeze(resolved), workspaceId, accountId: options.accountId ?? null,
      fingerprint: fingerprint(frozen, resolved, workspaceId), creator: options.createSession,
      retryCreator: options.retrySessionCreation,
      creationInput: Object.freeze({ title: draft.prompt.trim().replace(/\s+/gu, " ").slice(0, 160), mode: configuration.mode! }),
      navigation: owner.navigation, session: null, runId: null, phase: automatic ? "creating" : "waiting",
      error: null, automatic, started: false, accepted: false, expectedScope: null,
      original: null, operation: null, creation: null };
  };
  const accept = (capture: Capture) => {
    if (!isCurrent() || capture.accepted || !capture.session) return;
    capture.accepted = true;
    capture.phase = "accepted";
    capture.error = null;
    publish();
    try { latest.current.onAccepted(view(capture)); }
    catch { /* A draft-view failure cannot turn confirmed admission into a retry. */ }
  };
  const releaseAccepted = (capture: Capture) => {
    if (!isCurrent() || !capture.accepted || capture.original || capture.creation) return;
    if (capture.session && owner.sessions.get(capture.session.id) === capture) owner.sessions.delete(capture.session.id);
    if (owner.welcome === capture) owner.welcome = null;
    publish();
  };
  const sameTask = (capture: Capture, session: HostedSession) => Boolean(capture.session &&
    capture.session.id === session.id && capture.session.userId === session.userId &&
    (capture.accountId === null || session.userId === capture.accountId) && capture.workspaceId === session.workspaceId && session.archivedAt === null);
  const scopeMatches = (capture: Capture, scope: ConversationScope | null) => Boolean(scope && capture.session &&
    scope.sessionId === capture.session.id && scope.runId === capture.runId && scope.workspaceId === capture.workspaceId &&
    (capture.session.threadId === null || scope.threadId === capture.session.threadId));

  const execute = (capture: Capture, controller: DesktopHostedConversationController, session: HostedSession): Promise<boolean> => {
    requireCurrent();
    if (!sameTask(capture, session)) return Promise.reject(new Error("The kept prompt belongs to another cloud task or repository."));
    if (capture.operation) return capture.operation;
    if (capture.accepted) return Promise.resolve(true);
    if (controller.pendingDraft && controller.pendingDraft.id !== capture.draft.id) {
      return Promise.reject(new Error("Confirm this task's earlier prompt before sending another."));
    }
    // Claim this parent invocation before entering the controller. Re-rendering
    // or replacing the welcome view cannot authorize a second automatic call.
    capture.started = true;
    capture.automatic = false;
    capture.phase = "submitting";
    capture.error = null;
    const original = Promise.resolve().then(() => {
      requireCurrent();
      return controller.submit(capture.draft);
    });
    capture.original = original;
    const operation = original.then((outcome) => {
      if (!isCurrent()) return false;
      if (outcome.scope && scopeMatches(capture, outcome.scope)) capture.expectedScope = outcome.scope;
      if (outcome.status === "accepted" || (outcome.status === "cancelled" && outcome.admission === "accepted")) {
        accept(capture);
      } else if (!capture.accepted) {
        capture.phase = outcome.status === "cancelled" && outcome.admission === "not-dispatched" ? "cancelled" : "unconfirmed";
        capture.error = capture.phase === "cancelled" ? "The prompt was not sent. Your text has been kept."
          : outcome.status === "unconfirmed" ? outcome.message : "Delivery is not confirmed. Read saved status or retry the unchanged prompt.";
        publish();
      }
      return capture.accepted;
    }).catch((error: unknown) => {
      if (isCurrent() && !capture.accepted) {
        capture.phase = "unconfirmed";
        capture.error = error instanceof Error ? error.message : "Delivery could not be confirmed. Your unchanged prompt has been kept.";
        publish();
      }
      return capture.accepted && isCurrent();
    }).finally(() => {
      if (capture.original === original) capture.original = null;
      if (capture.operation === operation) capture.operation = null;
      if (isCurrent()) { publish(); releaseAccepted(capture); }
    });
    capture.operation = operation;
    publish();
    return operation;
  };
  const create = (capture: Capture, retry = false): Promise<boolean> => {
    requireCurrent();
    if (capture.creation) return capture.creation;
    if (capture.session) return Promise.resolve(false);
    capture.phase = "creating";
    capture.error = null;
    const original = Promise.resolve().then(() => {
      requireCurrent();
      return retry ? capture.retryCreator() : capture.creator(capture.creationInput);
    });
    const operation = original.then((session) => {
      if (!isCurrent()) return false;
      const saved = freezeSession(session, capture.workspaceId, capture.accountId);
      capture.session = saved.session;
      capture.runId = saved.runId;
      capture.phase = "waiting";
      owner.sessions.set(saved.session.id, capture);
      publish();
      if (capture.automatic && capture.navigation === owner.navigation) {
        try { latest.current.onSessionReady?.(saved.session); }
        catch { /* Task creation is already confirmed; no new creation is authorized. */ }
      }
      return false;
    }).catch((error: unknown) => {
      if (isCurrent()) {
        capture.automatic = false;
        capture.phase = "creation-unconfirmed";
        capture.error = error instanceof Error ? error.message : "Task creation is unconfirmed. Reload or retry the same creation request.";
        publish();
      }
      return false;
    }).finally(() => {
      if (capture.creation === operation) capture.creation = null;
      publish();
    });
    capture.creation = operation;
    publish();
    return operation;
  };

  return {
    revision,
    submitWelcome: (draft: HostedNativeDraft, selection: BYOKResolution, workspaceId: string): Promise<boolean> => {
      requireCurrent();
      const existing = owner.welcome;
      if (existing && locked(existing)) {
        if (existing.fingerprint !== fingerprint(draft, selection, workspaceId)) {
          return Promise.reject(new Error("Confirm the unchanged pending cloud prompt before starting another."));
        }
        return existing.creation ?? Promise.resolve(false);
      }
      const capture = makeCapture(draft, selection, workspaceId, true);
      owner.welcome = capture;
      publish();
      return create(capture);
    },
    submit: (controller: DesktopHostedConversationController, session: HostedSession,
      draft: HostedNativeDraft, selection: BYOKResolution): Promise<boolean> => {
      requireCurrent();
      if (!session.workspaceId) return Promise.reject(new Error("This cloud task has no authorized repository."));
      let capture = owner.sessions.get(session.id);
      if (capture && locked(capture)) {
        if (capture.fingerprint !== fingerprint(draft, selection, session.workspaceId)) {
          return Promise.reject(new Error("Retry the unchanged pending prompt before changing its model or text."));
        }
      } else {
        capture = makeCapture(draft, selection, session.workspaceId, false);
        Object.assign(capture, freezeSession(session, session.workspaceId, capture.accountId));
        owner.sessions.set(session.id, capture);
      }
      return execute(capture, controller, session);
    },
    observe: (controller: DesktopHostedConversationController, session: HostedSession): void => {
      if (!isCurrent()) return;
      const capture = owner.sessions.get(session.id);
      if (!capture || !sameTask(capture, session) || controller.workspaceContext?.sessionId !== session.id ||
          controller.workspaceContext.workspaceId !== capture.workspaceId) return;
      if (controller.pendingDraft?.id === capture.draft.id && scopeMatches(capture, controller.scope)) {
        capture.expectedScope ??= controller.scope;
      }
      if (!capture.accepted && capture.expectedScope && controller.canonicalMessages.some((message) =>
        message.role === "user" && message.id === capture.draft.id && message.content === capture.draft.prompt &&
        readCanonicalTurnId(message) === capture.expectedScope!.turnId)) {
        accept(capture);
        releaseAccepted(capture);
      }
      if (capture.automatic && !capture.started && capture.navigation === owner.navigation &&
          capture.phase === "waiting" && controller.canSubmit && !capture.creation) {
        void execute(capture, controller, session).catch(() => undefined);
      }
    },
    retryUnchanged: (controller: DesktopHostedConversationController, session: HostedSession): Promise<boolean> => {
      requireCurrent();
      const capture = owner.sessions.get(session.id);
      return capture ? execute(capture, controller, session) : Promise.resolve(false);
    },
    retryCreation: (): Promise<boolean> => {
      requireCurrent();
      const capture = owner.welcome;
      if (!capture || capture.session) return Promise.resolve(false);
      capture.automatic = false;
      return create(capture, true);
    },
    captureFor: (sessionId: string | null, workspaceId?: string): HostedComposerCapture | null => {
      if (current.current !== owner || !owner.key) return null;
      const capture = sessionId === null ? owner.welcome : owner.sessions.get(sessionId);
      return capture && (workspaceId === undefined || capture.workspaceId === workspaceId) ? view(capture) : null;
    },
    bindingSessionFor: (session: HostedSession): HostedSession => {
      const capture = owner.sessions.get(session.id);
      return current.current === owner && capture && sameTask(capture, session) && locked(capture)
        ? capture.session! : session;
    },
    relinquishAutomaticHandoffOnNavigation: (): void => {
      if (!isCurrent()) return;
      owner.navigation += 1;
      if (owner.welcome) owner.welcome.automatic = false;
    },
  };
}
