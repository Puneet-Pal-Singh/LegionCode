import { useState } from "react";
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
  active: boolean;
  queuingEnabled: boolean;
  onDisableQueuing: () => void;
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

export function ThreadInputQueuePanel(props: ThreadInputQueuePanelProps) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const items =
    props.snapshot?.items.filter(
      (item) =>
        item.state === "pending" ||
        item.state === "consuming" ||
        item.receipt?.status === "unconfirmed",
    ) ?? [];
  const queuedCount = items.filter(
    (item) => item.delivery === "queue" && item.state === "pending",
  ).length;
  if (!props.snapshot && !props.error) {
    return null;
  }
  if (
    props.snapshot &&
    items.length === 0 &&
    !props.snapshot.paused &&
    !props.error
  ) {
    return null;
  }

  return (
    <section
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
              className="shrink-0 rounded-md px-2 py-1 text-zinc-300 hover:bg-white/[0.06] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
              onClick={props.onDisableQueuing}
            >
              Turn off queuing
            </button>
          ) : null}
        </div>
      ) : null}
      {props.error ? (
        <p role="alert" className="px-1 py-1 text-[11px] text-rose-300">
          {props.error}
        </p>
      ) : null}
      <ol className="max-h-[min(28vh,10rem)] space-y-0 overflow-y-auto overscroll-contain">
        {items.map((item) => {
          const image = item.mediaRefs[0];
          const imageSource = image
            ? props.resolveImageSource?.(image.attachmentId)
            : undefined;
          const canEditOrRemove =
            item.state === "pending" && item.delivery === "queue";
          const status =
            item.receipt?.status === "unconfirmed"
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
              className="relative flex min-w-0 items-center gap-2 border-b border-zinc-700/50 px-1.5 py-1.5 last:border-b-0 sm:gap-2.5 sm:px-2"
            >
              {editingItemId === item.itemId ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
                  <List
                    size={17}
                    aria-hidden="true"
                    className="shrink-0 text-zinc-500"
                  />
                  <textarea
                    aria-label="Edit queued follow-up"
                    className="min-h-9 min-w-0 flex-1 resize-y rounded-lg border border-zinc-700 bg-zinc-900/80 p-2 text-xs text-zinc-100 outline-none focus-visible:border-zinc-500 focus-visible:ring-1 focus-visible:ring-zinc-500"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
                    onClick={() => {
                      setEditingItemId(null);
                      setEditingVersion(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-white hover:bg-zinc-600 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-300"
                    onClick={async () => {
                      if (editingVersion === null) return;
                      const result = await props.onUpdate(
                        item.itemId,
                        editingVersion,
                        draft,
                      );
                      if (result?.status === "pending") {
                        setEditingItemId(null);
                        setEditingVersion(null);
                      }
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
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 sm:px-3"
                        aria-label="Steer queued message"
                        title="Submit without interrupting the model"
                        onClick={() =>
                          void props.onSteer?.(item.itemId, item.version)
                        }
                      >
                        <CornerDownRight size={15} aria-hidden="true" />
                        <span>Steer</span>
                      </button>
                    ) : !props.active && canEditOrRemove && props.onStart ? (
                      <button
                        type="button"
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400 sm:px-3"
                        disabled={!props.snapshot}
                        onClick={() =>
                          void props.onStart?.(
                            item.itemId,
                            item.version,
                            props.snapshot!.revision,
                          )
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
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-400"
                          aria-label="Remove queued message"
                          title="Remove queued message"
                          onClick={() =>
                            void props.onRemove(item.itemId, item.version)
                          }
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                        <QueueActionsMenu
                          queuingEnabled={props.queuingEnabled}
                          onEdit={() => {
                            setEditingItemId(item.itemId);
                            setEditingVersion(item.version);
                            setDraft(item.text);
                          }}
                          onDisableQueuing={props.onDisableQueuing}
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
