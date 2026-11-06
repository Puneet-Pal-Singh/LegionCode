import { ChangesList, DiffViewer } from "@legioncode/client-ui";
import { buildDiffContentFromTurnDiff, type AppServerClient } from "@legioncode/sdk";
import type { ThreadId, TurnDiffPayload, TurnId, WorkspaceId } from "@repo/platform-protocol";
import type { FileStatus } from "@repo/shared-types";
import { useEffect, useState } from "react";

export interface DesktopReviewSelection {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  turnId: TurnId;
}

export interface DesktopReviewProps {
  client: Pick<AppServerClient, "getTurnDiff">;
  selection: DesktopReviewSelection | null;
  availability: { available: true } | { available: false; reason: string };
}

type ReviewRead = { client: DesktopReviewProps["client"] } & (
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; diff: TurnDiffPayload | null });

/** The parent supplies a replay-selected turn and the actual advertised capability. */
export function DesktopReview({ client, selection, availability }: DesktopReviewProps) {
  if (!selection) return <p role="status">Select a completed turn to review.</p>;
  if (!availability.available) return <p role="status">Saved turn review unavailable: {availability.reason}</p>;
  return (
    <SelectedTurnReview
      key={`${selection.workspaceId}:${selection.threadId}:${selection.turnId}`}
      client={client}
      turnId={selection.turnId}
    />
  );
}

function SelectedTurnReview({ client, turnId }: {
  client: DesktopReviewProps["client"];
  turnId: TurnId;
}) {
  const [read, setRead] = useState<ReviewRead>({ client, status: "loading" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setRead({ client, status: "loading" });
    void client.getTurnDiff({ turnId }).then(({ diff }) => {
      if (!active) return;
      if (diff && diff.turnId !== turnId) {
        setRead({ client, status: "error" });
        return;
      }
      setRead({ client, status: "ready", diff });
    }).catch(() => {
      if (active) setRead({ client, status: "error" });
    });
    return () => { active = false; };
  }, [client, turnId, request]);

  if (read.client !== client || read.status === "loading") return <p role="status">Loading saved turn changes…</p>;
  if (read.status === "error") return (
    <div role="alert">
      <p>Saved turn changes could not be loaded.</p>
      <button type="button" onClick={() => setRequest((value) => value + 1)}>Retry</button>
    </div>
  );
  if (!read.diff) return <p role="status">No saved diff is available for this turn.</p>;

  const savedDiff = read.diff;
  const files: FileStatus[] = savedDiff.files.map((file) => ({
    path: file.path,
    status: file.status === "copied" || file.status === "unchanged" ? "modified" : file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    isStaged: false,
  }));
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const diff = selectedFile ? buildDiffContentFromTurnDiff(savedDiff, selectedFile.path) : null;

  return (
    <section aria-label="Saved turn review">
      <h2>Saved turn changes</h2>
      <p>Immutable review for turn {turnId}</p>
      <div className="flex min-h-0 flex-col gap-4 lg:flex-row">
        <ChangesList
          files={files}
          selectedFile={selectedFile}
          onSelectFile={(file) => setSelectedPath(file.path)}
          reviewScope="turn-diff"
          onReviewScopeChange={() => {}}
          showToolbar={false}
          emptyLabel="No changes in this saved turn."
        />
        {selectedFile ? diff ? (
          <DiffViewer key={selectedFile.path} diff={diff} />
        ) : <p role="status">Saved patch content is unavailable for {selectedFile.path}.</p> : null}
      </div>
    </section>
  );
}
