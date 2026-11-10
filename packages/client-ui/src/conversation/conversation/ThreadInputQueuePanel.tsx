import { useLayoutEffect, useRef, useState } from "react";
import {
  CornerDownRight,
  Image as ImageIcon,
  List,
  Play,
  Trash2,
} from "lucide-react";
import type {
  ThreadInputQueueSnapshot,
  ThreadInputReceipt,
} from "@legioncode/sdk";

import { QueueActionsMenu } from "./QueueActionsMenu.js";

interface ThreadInputQueuePanelProps {
  snapshot: ThreadInputQueueSnapshot | null;
  error: string | null;
  onRetry?: () => void | Promise<unknown>;
  active: boolean;
  queuingEnabled: boolean;
  onQueuingChange: (enabled: boolean) => void;
  onUpdate: (
    itemId: string,
    version: number,
    text: string,
  ) => Promise<ThreadInputReceipt | null>;
  onRemove: (
    itemId: string,
    version: number,
  ) => Promise<ThreadInputReceipt | null>;
  onSteer?: (
    itemId: string,
    version: number,
  ) => Promise<ThreadInputReceipt | null>;
  onStart?: (
    itemId: string,
    version: number,
    revision: number,
  ) => Promise<ThreadInputReceipt | null>;
  resolveImageSource?: (attachmentId: string) => string | undefined;
}

type QueueActionKind = "save" | "remove" | "steer" | "start" | "retry";
type PendingAction = { scope: string | null; itemId: string | null; kind: QueueActionKind };
type QueueEdit = { scope: string; itemId: string; version: number; draft: string };
const ACTION_LABELS: Record<QueueActionKind, string> = {
  save: "Saving queued message…", remove: "Removing queued message…",
  steer: "Sending steering input…", start: "Starting queued message…", retry: "Refreshing queue…",
};

export function ThreadInputQueuePanel(props: ThreadInputQueuePanelProps) {
  const scope = props.snapshot ? JSON.stringify([props.snapshot.workspaceId, props.snapshot.threadId]) : null;
  const scopeRef = useRef(scope);
  const mounted = useRef(false);
  const pendingRef = useRef<PendingAction | null>(null);
  const [pendingState, setPending] = useState<PendingAction | null>(null);
  const [editState, setEdit] = useState<QueueEdit | null>(null);
  const editRef = useRef<QueueEdit | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const [localError, setLocalError] = useState<{ scope: string | null; message: string } | null>(null);
  const pending = pendingState?.scope === scope ? pendingState : null;
  const editing = editState?.scope === scope ? editState : null;
  const editingItemId = editing?.itemId;
  const error = props.error ?? (localError?.scope === scope ? localError.message : null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    pendingRef.current = null;
    editRef.current = null;
    setPending(null);
    setEdit(null);
    setLocalError(null);
  }, [scope]);
  useLayoutEffect(() => { if (editingItemId) editInputRef.current?.focus(); }, [scope, editingItemId]);
  async function runAction<T>(kind: QueueActionKind, itemId: string | null, action: () => Promise<T>, settle?: (result: T) => void) {
    if (!mounted.current || scopeRef.current !== scope || pendingRef.current) return;
    const request = { scope, itemId, kind };
    pendingRef.current = request;
    setPending(request);
    setLocalError(null);
    const current = () => mounted.current && scopeRef.current === scope && pendingRef.current === request;
    try {
      const result = await action();
      if (current()) settle?.(result);
    } catch {
      if (current()) setLocalError({ scope, message: "Queue action could not be confirmed. Refresh the queue before retrying." });
    } finally {
      if (current()) { pendingRef.current = null; setPending(null); }
    }
  }
  const mutate = (kind: Exclude<QueueActionKind, "retry">, itemId: string, action: () => Promise<ThreadInputReceipt | null>, settle?: (receipt: ThreadInputReceipt) => void) =>
    runAction(kind, itemId, action, (receipt) => {
      if (!receipt || receipt.status === "unconfirmed")
        setLocalError({ scope, message: "Input delivery could not be confirmed. Refresh the queue before retrying." });
      else if (receipt.status === "conflict") setLocalError({ scope, message: receipt.message });
      else settle?.(receipt);
    });
  const items =
    props.snapshot?.items.filter(
      (item) =>
        item.state === "pending" ||
        item.state === "consuming" ||
        item.receipt?.status === "unconfirmed" || item.receipt?.status === "conflict",
    ) ?? [];
  const queuedCount = items.filter(
    (item) => item.delivery === "queue" && item.state === "pending",
  ).length;
  if (!props.snapshot && !error && !pending) {
    return null;
  }
  if (
    props.snapshot &&
    items.length === 0 &&
    !props.snapshot.paused &&
    !error && !pending
  ) {
    return null;
  }

  return (
    <section
      aria-busy={Boolean(pending)}
      aria-label={`Queued follow-ups${queuedCount ? ` (${queuedCount})` : ""}`}
      className="relative rounded-t-2xl border border-zinc-800/80 border-b-0 bg-[#242425] px-2.5 py-1.5 sm:px-3"
    >
      {props.snapshot?.paused ? (
        <div className="flex min-h-8 items-center gap-2 px-1 text-[11px] text-amber-200">
          <span className="min-w-0 flex-1 truncate">
            Queue paused
            {props.snapshot.pauseReason
              ? `: ${props.snapshot.pauseReason}`
              : "."}
          </span>
          {items.length === 0 && props.queuingEnabled ? (
            <button
              type="button"
              disabled={Boolean(pending)}
              className="shrink-0 rounded-md px-2 py-1 text-zinc-300 hover:bg-white/[0.06] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 disabled:cursor-wait disabled:opacity-50"
              onClick={() => props.onQueuingChange(false)}
            >
              Turn off queuing
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-center gap-2 px-1 py-1 text-[11px] text-rose-300">
          <p className="min-w-0 flex-1">{error}</p>
          {props.onRetry ? (
            <button type="button" disabled={Boolean(pending)} className="shrink-0 rounded-md px-2 py-1 text-zinc-300 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 disabled:cursor-wait disabled:opacity-50" onClick={() => void runAction("retry", null, () => Promise.resolve(props.onRetry?.()))}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {pending ? <p role="status" className="px-1 py-1 text-[11px] text-zinc-400">{ACTION_LABELS[pending.kind]}</p> : null}
      <ol className="max-h-[min(28vh,10rem)] space-y-0 overflow-y-auto overscroll-contain">
        {items.map((item) => {
          const image = item.mediaRefs[0];
          const imageSource = image
            ? props.resolveImageSource?.(image.attachmentId)
            : undefined;
          const canEditOrRemove =
            item.state === "pending" && item.delivery === "queue";
          const status =
            item.receipt?.status === "conflict" ? item.receipt.message : item.receipt?.status === "unconfirmed"
              ? "Input delivery could not be confirmed."
              : item.delivery === "steer" && item.receipt?.status === "applied"
                ? `Applied at model step ${item.receipt.modelStep}`
                : item.delivery === "steer" &&
                    item.receipt?.status === "accepted"
                  ? "Steering pending delivery"
                  : item.state === "consuming" ||
                      item.receipt?.status === "started"
                    ? "Starting in a new run"
                    : null;
          return (
            <li
              key={item.itemId}
              aria-busy={pending?.itemId === item.itemId}
              className="relative flex min-w-0 items-center gap-2 border-b border-zinc-700/50 px-1.5 py-1.5 last:border-b-0 sm:gap-2.5 sm:px-2"
            >
              {editing?.itemId === item.itemId ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
                  <List
                    size={17}
                    aria-hidden="true"
                    className="shrink-0 text-zinc-500"
                  />
                  <textarea
                    ref={editInputRef}
                    aria-label="Edit queued follow-up"
                    disabled={Boolean(pending)}
                    className="min-h-9 min-w-0 flex-1 resize-y rounded-lg border border-zinc-700 bg-zinc-900/80 p-2 text-xs text-zinc-100 outline-none focus-visible:border-zinc-500 focus-visible:ring-1 focus-visible:ring-zinc-500"
                    value={editing.draft}
                    onChange={(event) => {
                      if (pendingRef.current || editRef.current !== editing) return;
                      const next = { ...editing, draft: event.target.value };
                      editRef.current = next;
                      setEdit(next);
                    }}
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
                    onClick={() => {
                      editRef.current = null;
                      setEdit(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(pending)}
                    className="shrink-0 rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-white hover:bg-zinc-600 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-300 disabled:cursor-wait disabled:opacity-50"
                    onClick={() => {
                      const captured = editRef.current;
                      if (!captured || captured !== editing) return;
                      void mutate("save", item.itemId, () => props.onUpdate(item.itemId, captured.version, captured.draft), (receipt) => {
                        if (receipt.status === "pending" && receipt.itemId === captured.itemId &&
                            receipt.version > captured.version && editRef.current === captured) {
                          editRef.current = null;
                          setEdit(null);
                        }
                      });
                    }}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <>
                  {image ? (
                    imageSource ? (
                      <img
                        src={imageSource}
                        alt={image.name}
                        className="h-8 w-8 shrink-0 rounded-md border border-zinc-700/80 object-cover"
                      />
                    ) : (
                      <span
                        aria-label={`Image attachment: ${image.name}`}
                        role="img"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-700/80 bg-zinc-900 text-zinc-500"
                      >
                        <ImageIcon size={15} aria-hidden="true" />
                      </span>
                    )
                  ) : (
                    <List
                      size={18}
                      aria-hidden="true"
                      className="shrink-0 text-zinc-500"
                    />
                  )}
                  <div className="min-w-0 flex-1 py-0.5">
                    <p
                      className="truncate text-[13px] leading-5 text-zinc-100"
                      title={item.text || "Image follow-up"}
                    >
                      {item.text || "Image follow-up"}
                    </p>
                    {status || item.mediaRefs.length > 1 ? (
                      <p className="truncate text-[10px] leading-4 text-zinc-400">
                        {status ?? `${item.mediaRefs.length} images attached`}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
                    {props.active && canEditOrRemove && props.onSteer ? (
                      <button
                        type="button"
                        disabled={Boolean(pending)}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 disabled:cursor-wait disabled:opacity-50 sm:px-3"
                        aria-label="Steer queued message"
                        title="Submit without interrupting the model"
                        onClick={() =>
                          void mutate("steer", item.itemId, () => props.onSteer!(item.itemId, item.version))
                        }
                      >
                        <CornerDownRight size={15} aria-hidden="true" />
                        <span>Steer</span>
                      </button>
                    ) : !props.active && canEditOrRemove && props.onStart ? (
                      <button
                        type="button"
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 disabled:cursor-wait disabled:opacity-50 sm:px-3"
                        disabled={!props.snapshot || Boolean(pending)}
                        onClick={() =>
                          void mutate("start", item.itemId, () => props.onStart!(
                            item.itemId,
                            item.version,
                            props.snapshot!.revision,
                          ))
                        }
                      >
                        <Play size={14} aria-hidden="true" />
                        <span>Start</span>
                      </button>
                    ) : null}
                    {canEditOrRemove ? (
                      <>
                        <button
                          type="button"
                          disabled={Boolean(pending)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 disabled:cursor-wait disabled:opacity-50"
                          aria-label="Remove queued message"
                          title="Remove queued message"
                          onClick={() =>
                            void mutate("remove", item.itemId, () => props.onRemove(item.itemId, item.version))
                          }
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                        <QueueActionsMenu
                          disabled={Boolean(pending)}
                          queuingEnabled={props.queuingEnabled}
                          onEdit={() => {
                            if (!scope || scopeRef.current !== scope || pendingRef.current) return;
                            const next = { scope, itemId: item.itemId, version: item.version, draft: item.text };
                            editRef.current = next;
                            setEdit(next);
                          }}
                          onQueuingChange={props.onQueuingChange}
                        />
                      </>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
