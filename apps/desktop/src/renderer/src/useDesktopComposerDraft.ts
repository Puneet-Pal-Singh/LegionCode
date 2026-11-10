import { useCallback, useMemo, useRef, useState } from "react";
import {
  LocalTurnConfigurationSchema,
  type LocalTurnConfiguration,
} from "@legioncode/sdk";
import type { Thread, ThreadId, WorkspaceId } from "@repo/platform-protocol";

export interface DesktopComposerDraftValue {
  readonly input: string;
  readonly configuration: LocalTurnConfiguration;
  readonly configurationTouched: boolean;
}

export interface DesktopComposerDraftBinding {
  readonly value: DesktopComposerDraftValue;
  update(update: (current: DesktopComposerDraftValue) => DesktopComposerDraftValue): void;
}

export interface DesktopComposerDraftTicket {
  readonly id: number;
  readonly draftId: number;
}

export interface DesktopComposerDraftHandoff {
  readonly id: number;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly value: DesktopComposerDraftValue;
  consume(): void;
}

export function createDesktopComposerDraft(
  configuration = LocalTurnConfigurationSchema.parse({}),
): DesktopComposerDraftValue {
  return { input: "", configuration: { ...configuration }, configurationTouched: false };
}

/** Volatile UI draft only. Canonical Thread creation stays with the SDK caller. */
export function useDesktopComposerDraft() {
  const [draft, setDraft] = useState(() => ({ id: 0, value: createDesktopComposerDraft() }));
  const currentDraft = useRef(draft);
  const nextTicketId = useRef(0);
  const pendingTicket = useRef<DesktopComposerDraftTicket | null>(null);
  const [transfer, setTransfer] = useState<Omit<DesktopComposerDraftHandoff, "consume"> | null>(null);

  const unbound = useMemo<DesktopComposerDraftBinding>(() => ({
    value: draft.value,
    update(update) {
      // A removed composer cannot repopulate a consumed draft through a late event.
      if (currentDraft.current.id !== draft.id) return;
      const value = update(currentDraft.current.value);
      if (value === currentDraft.current.value) return;
      const next = { id: draft.id, value };
      currentDraft.current = next;
      setDraft(next);
    },
  }), [draft]);

  const captureHandoff = useCallback((): DesktopComposerDraftTicket => {
    const ticket = { id: ++nextTicketId.current, draftId: currentDraft.current.id };
    pendingTicket.current = ticket;
    return ticket;
  }, []);

  const adoptCreatedThread = useCallback((
    ticket: DesktopComposerDraftTicket,
    thread: Pick<Thread, "id" | "workspaceId">,
  ): boolean => {
    if (pendingTicket.current !== ticket || ticket.draftId !== currentDraft.current.id) return false;
    pendingTicket.current = null;
    const value = currentDraft.current.value;
    setTransfer(value.input.length > 0 || value.configurationTouched ? {
      id: ticket.id,
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      value: { ...value, configuration: { ...value.configuration } },
    } : null);
    const next = { id: currentDraft.current.id + 1, value: createDesktopComposerDraft() };
    currentDraft.current = next;
    setDraft(next);
    return true;
  }, []);

  const cancelHandoff = useCallback(() => {
    pendingTicket.current = null;
    setTransfer(null);
    const next = { ...currentDraft.current, id: currentDraft.current.id + 1 };
    currentDraft.current = next;
    setDraft(next);
  }, []);

  const handoff = useMemo<DesktopComposerDraftHandoff | null>(() => transfer ? {
    ...transfer,
    consume: () => setTransfer((current) => current?.id === transfer.id ? null : current),
  } : null, [transfer]);

  const handoffFor = useCallback((thread: Pick<Thread, "id" | "workspaceId"> | null) =>
    thread && handoff?.workspaceId === thread.workspaceId && handoff.threadId === thread.id
      ? handoff
      : null,
  [handoff]);

  return {
    unbound,
    hasUnboundDraft: draft.value.input.length > 0 || draft.value.configurationTouched,
    captureHandoff,
    adoptCreatedThread,
    cancelHandoff,
    handoffFor,
  };
}
