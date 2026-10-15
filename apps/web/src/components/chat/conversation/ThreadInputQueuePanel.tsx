import { useState } from "react";
import type {
  ThreadInputQueueSnapshot,
  ThreadInputReceipt,
} from "@repo/platform-client-sdk";
import { updateComposerPreferences } from "../../../lib/composer-preferences";

interface ThreadInputQueuePanelProps {
  snapshot: ThreadInputQueueSnapshot | null;
  error: string | null;
  active: boolean;
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
      className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/75 px-3 py-2.5"
    >
      <header className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-zinc-200">
            Follow-up inbox{" "}
            <span className="text-zinc-500">({queuedCount} queued)</span>
          </h3>
          {props.snapshot?.paused ? (
            <p className="mt-1 text-[11px] text-amber-300">
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
          onClick={() =>
            updateComposerPreferences({ followUpBehavior: "steer" })
          }
        >
          Turn off queuing
        </button>
      </header>
      {props.error ? (
        <p role="alert" className="mb-2 text-[11px] text-rose-300">
          {props.error}
        </p>
      ) : null}
      <ol className="space-y-2">
        {items.map((item) => (
          <li
            key={item.itemId}
            className="rounded-md border border-zinc-800/80 bg-black/20 px-2.5 py-2"
          >
            {editingItemId === item.itemId ? (
              <div className="space-y-2">
                <textarea
                  aria-label="Edit queued follow-up"
                  className="min-h-16 w-full resize-y rounded border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-200 outline-none focus:border-zinc-500"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5"
                    onClick={() => {
                      setEditingItemId(null);
                      setEditingVersion(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded bg-zinc-700 px-2 py-1 text-[11px] text-white hover:bg-zinc-600"
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
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-xs text-zinc-200">
                  {item.text || "Image follow-up"}
                </p>
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                  <span>
                    #{item.order} ·{" "}
                    {item.configuration.providerId && item.configuration.modelId
                      ? `${item.configuration.providerId}/${item.configuration.modelId}`
                      : "session model"}
                    {item.mediaRefs.length > 0
                      ? ` · ${item.mediaRefs.length} image${item.mediaRefs.length === 1 ? "" : "s"}`
                      : ""}
                    {item.receipt?.status === "unconfirmed"
                      ? " · Input delivery could not be confirmed."
                      : item.delivery === "steer" &&
                          item.receipt?.status === "applied"
                        ? ` · Applied at model step ${item.receipt.modelStep}`
                        : item.delivery === "steer" &&
                            item.receipt?.status === "accepted"
                          ? " · Steering pending delivery"
                          : item.state === "consuming" ||
                              item.receipt?.status === "started"
                            ? " · Starting in a new run"
                            : ""}
                  </span>
                  <div className="flex shrink-0 gap-2">
                    {item.state === "pending" && item.delivery === "queue" ? (
                      <>
                        <button
                          type="button"
                          className="hover:text-zinc-200"
                          onClick={() => {
                            setEditingItemId(item.itemId);
                            setEditingVersion(item.version);
                            setDraft(item.text);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="hover:text-rose-300"
                          onClick={() =>
                            void props.onRemove(item.itemId, item.version)
                          }
                        >
                          Remove
                        </button>
                        {props.active && props.onSteer ? (
                          <button
                            type="button"
                            className="text-sky-300 hover:text-sky-200"
                            title="Submit without interrupting the model"
                            onClick={() =>
                              void props.onSteer?.(item.itemId, item.version)
                            }
                          >
                            Steer now
                          </button>
                        ) : !props.active && props.onStart ? (
                          <button
                            type="button"
                            className="text-emerald-300 hover:text-emerald-200"
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
                      </>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
