import { useState } from "react";
import { Image as ImageIcon, MoreHorizontal } from "lucide-react";
import type {
  ThreadInputQueueSnapshot,
  ThreadInputReceipt,
} from "@legioncode/sdk";

interface ThreadInputQueuePanelProps {
  snapshot: ThreadInputQueueSnapshot | null;
  error: string | null;
  active: boolean;
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
      aria-label="Queued follow-ups"
      className="mb-2 rounded-lg border border-zinc-800 bg-zinc-950/75 px-2.5 py-2"
    >
      <header className="mb-1 flex items-center justify-between gap-3">
        <div className="min-w-0 text-xs font-semibold text-zinc-200">
          Queued follow-ups{" "}
          <span className="text-zinc-500">({queuedCount})</span>
          {props.snapshot?.paused ? (
            <p className="mt-0.5 truncate text-[11px] font-normal text-amber-300">
              Queue paused
              {props.snapshot.pauseReason
                ? `: ${props.snapshot.pauseReason}`
                : "."}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="shrink-0 text-[11px] text-zinc-400 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200"
          onClick={props.onDisableQueuing}
        >
          Turn off queuing
        </button>
      </header>
      {props.error ? (
        <p role="alert" className="mb-1 text-[11px] text-rose-300">
          {props.error}
        </p>
      ) : null}
      <ol className="max-h-32 space-y-1 overflow-y-auto">
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
              className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-800/80 bg-black/20 px-2 py-1.5"
            >
              {editingItemId === item.itemId ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <textarea
                    aria-label="Edit queued follow-up"
                    className="min-h-9 min-w-0 flex-1 resize-y rounded border border-zinc-700 bg-zinc-950 p-1.5 text-xs text-zinc-200 outline-none focus:border-zinc-500"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5"
                    onClick={() => {
                      setEditingItemId(null);
                      setEditingVersion(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded bg-zinc-700 px-2 py-1 text-[11px] text-white hover:bg-zinc-600"
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
                        className="h-8 w-8 shrink-0 rounded border border-zinc-700 object-cover"
                      />
                    ) : (
                      <span
                        aria-label={`Image attachment: ${image.name}`}
                        role="img"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-500"
                      >
                        <ImageIcon size={15} aria-hidden="true" />
                      </span>
                    )
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-xs text-zinc-200"
                      title={item.text || "Image follow-up"}
                    >
                      {item.text || "Image follow-up"}
                    </p>
                    <p className="truncate text-[10px] text-zinc-500">
                      #{item.order}
                      {item.configuration.providerId &&
                      item.configuration.modelId
                        ? ` · ${item.configuration.providerId}/${item.configuration.modelId}`
                        : " · session model"}
                      {item.mediaRefs.length > 1
                        ? ` · ${item.mediaRefs.length} images`
                        : ""}
                      {status ? ` · ${status}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {props.active && canEditOrRemove && props.onSteer ? (
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-950/40 hover:text-sky-200"
                        title="Submit this queued message without waiting for the run to finish"
                        onClick={() =>
                          void props.onSteer?.(item.itemId, item.version)
                        }
                      >
                        Steer
                      </button>
                    ) : !props.active && canEditOrRemove && props.onStart ? (
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200"
                        disabled={!props.snapshot}
                        onClick={() =>
                          void props.onStart?.(
                            item.itemId,
                            item.version,
                            props.snapshot!.revision,
                          )
                        }
                      >
                        Start
                      </button>
                    ) : null}
                    {canEditOrRemove ? (
                      <>
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                          onClick={() =>
                            void props.onRemove(item.itemId, item.version)
                          }
                        >
                          Remove
                        </button>
                        <details className="flex flex-col items-end">
                          <summary
                            aria-label="More queued follow-up actions"
                            className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded text-zinc-400 hover:bg-white/5 hover:text-zinc-200 [&::-webkit-details-marker]:hidden"
                            title="More actions"
                          >
                            <MoreHorizontal size={16} aria-hidden="true" />
                          </summary>
                          <div className="ui-surface-popover mt-1 min-w-28 p-1">
                            <button
                              type="button"
                              className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/5"
                              onClick={(event) => {
                                setEditingItemId(item.itemId);
                                setEditingVersion(item.version);
                                setDraft(item.text);
                                const details =
                                  event.currentTarget.closest("details");
                                if (details) details.open = false;
                              }}
                            >
                              Edit
                            </button>
                          </div>
                        </details>
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
