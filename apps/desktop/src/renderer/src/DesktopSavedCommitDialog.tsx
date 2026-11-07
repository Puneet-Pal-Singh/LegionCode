import {
  ChangeItem,
  PickerModal,
  GitCommitDialogView,
  GitCommitSelectionControl,
  type CommitNextStep,
} from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import {
  CommitTurnArtifactRequestSchema,
  CommitTurnArtifactResponseSchema,
  type CommitTurnArtifactResponse,
  type TurnDiffPayload,
} from "@repo/platform-protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopSavedReviewScope,
  DesktopSavedReviewTurn,
} from "./useDesktopSavedReviewSelection";

export interface DesktopSavedCommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  client: Pick<AppServerClient, "commitTurnArtifact">;
  selection: DesktopSavedReviewTurn | null;
  diff: TurnDiffPayload | null;
  scope: Pick<
    DesktopSavedReviewScope,
    "workspaceId" | "threadId" | "grantedAt" | "readiness"
  > | null;
  availability: { available: true } | { available: false; reason: string };
  onCommitted?: (receipt: CommitTurnArtifactResponse) => void;
}

type AttemptEvidence =
  | { status: "unconfirmed" }
  | { status: "confirmed"; receipt: CommitTurnArtifactResponse };

/** Mutation over the selected immutable evidence supplied by the one review owner.
 * Keep this adapter mounted while closed so an uncertain command cannot be retried
 * merely by reopening the same target. The server derives all artifact/Git scope.
 */
export function DesktopSavedCommitDialog(props: DesktopSavedCommitDialogProps) {
  // Delivery bookkeeping only, retained across temporary read loading/null.
  const attempts = useRef(
    new Map<
      DesktopSavedCommitDialogProps["client"],
      Map<string, AttemptEvidence>
    >(),
  );
  const [, refreshEvidence] = useState(0);
  const { scope, selection, diff } = props;
  if (
    !scope ||
    scope.readiness !== "ready" ||
    !selection ||
    !diff ||
    selection.workspaceId !== scope.workspaceId ||
    selection.threadId !== scope.threadId ||
    diff.turnId !== selection.turnId ||
    diff.startSnapshot.turnId !== selection.turnId ||
    diff.terminalSnapshot.turnId !== selection.turnId
  )
    return null;
  const identity = JSON.stringify([
    scope.workspaceId,
    scope.threadId,
    scope.grantedAt,
    selection.turnId,
    diff.startSnapshot.snapshotKey,
    diff.startSnapshot.treeId,
    diff.startSnapshot.headSha,
    diff.terminalSnapshot.snapshotKey,
    diff.terminalSnapshot.treeId,
    diff.terminalSnapshot.headSha,
  ]);
  let byTarget = attempts.current.get(props.client);
  if (!byTarget) {
    byTarget = new Map();
    attempts.current.set(props.client, byTarget);
  }
  const records = byTarget;
  return (
    <SelectedSavedCommit
      key={identity}
      {...props}
      selection={selection}
      diff={diff}
      identity={identity}
      evidence={records.get(identity)}
      markUnconfirmed={() => {
        const record: AttemptEvidence = { status: "unconfirmed" };
        records.set(identity, record);
        refreshEvidence((value) => value + 1);
        return record;
      }}
      confirm={(record, receipt) => {
        if (records.get(identity) !== record) return;
        records.set(identity, { status: "confirmed", receipt });
        refreshEvidence((value) => value + 1);
      }}
    />
  );
}

function SelectedSavedCommit({
  isOpen,
  onClose,
  client,
  selection,
  diff,
  availability,
  onCommitted,
  identity,
  evidence,
  markUnconfirmed,
  confirm,
}: DesktopSavedCommitDialogProps & {
  selection: DesktopSavedReviewTurn;
  diff: TurnDiffPayload;
  identity: string;
  evidence: AttemptEvidence | undefined;
  markUnconfirmed: () => AttemptEvidence;
  confirm: (
    record: AttemptEvidence,
    receipt: CommitTurnArtifactResponse,
  ) => void;
}) {
  const [includeAll, setIncludeAll] = useState(true);
  const [paths, setPaths] = useState(
    () => new Set(diff.files.map((file) => file.path)),
  );
  const [message, setMessage] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const uncertain = evidence?.status === "unconfirmed";
  const confirmedReceipt =
    evidence?.status === "confirmed" ? evidence.receipt : null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextStep, setNextStep] = useState<CommitNextStep>("commit");
  const command = useRef(false);
  const mounted = useRef(false);
  const active = useRef({
    client,
    identity,
    available: availability.available,
    isOpen,
  });
  useLayoutEffect(() => {
    active.current = {
      client,
      identity,
      available: availability.available,
      isOpen,
    };
  }, [client, identity, availability.available, isOpen]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current
      ?.querySelector<HTMLButtonElement>('button[title="Close commit dialog"]')
      ?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [isOpen, onClose]);
  const request = CommitTurnArtifactRequestSchema.safeParse({
    turnId: selection.turnId,
    selection: includeAll
      ? { kind: "all" }
      : { kind: "paths", paths: [...paths] },
    message,
    author: { name: authorName, email: authorEmail },
  });
  const locked = busy || uncertain || confirmedReceipt !== null;
  const stepOptions = useMemo(
    () => [
      {
        id: "commit" as const,
        label: "Commit",
        detail: "Selected saved changes only",
        enabled: true,
      },
      {
        id: "commit-and-push" as const,
        label: "Commit and push",
        detail: "Push is unavailable in this Desktop environment",
        enabled: false,
      },
      {
        id: "commit-and-pr" as const,
        label: "Commit and create PR",
        detail:
          "Pull request creation is unavailable in this Desktop environment",
        enabled: false,
      },
    ],
    [],
  );
  const counts = (field: "additions" | "deletions") =>
    diff.files.some((file) => file[field] === null)
      ? null
      : diff.files.reduce((sum, file) => sum + (file[field] ?? 0), 0);

  const commit = async () => {
    if (confirmedReceipt) {
      onClose();
      return;
    }
    if (
      !request.success ||
      !isOpen ||
      !availability.available ||
      command.current ||
      uncertain ||
      nextStep !== "commit"
    )
      return;
    const captured = active.current;
    if (
      captured.client !== client ||
      captured.identity !== identity ||
      !captured.available ||
      !captured.isOpen
    )
      return;
    command.current = true;
    setBusy(true);
    const delivery = markUnconfirmed();
    setError(null);
    try {
      const receipt = CommitTurnArtifactResponseSchema.parse(
        await client.commitTurnArtifact(request.data),
      );
      if (receipt.turnId !== selection.turnId)
        throw new Error("Commit receipt belongs to another turn");
      confirm(delivery, receipt);
      if (!mounted.current) return;
      if (
        active.current.client !== captured.client ||
        active.current.identity !== captured.identity ||
        !active.current.available
      ) {
        setError(
          "The commit target changed while delivery was pending. Inspect the repository before another commit.",
        );
        return;
      }
      onCommitted?.(receipt);
      onClose();
    } catch {
      if (mounted.current)
        setError(
          "The commit outcome could not be confirmed. Automatic retry is disabled. Inspect the repository before another commit.",
        );
    } finally {
      if (mounted.current) setBusy(false);
      command.current = false;
    }
  };
  if (!isOpen) return null;
  return (
    <PickerModal layer="dialog">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Commit saved changes"
        className="contents"
      >
        <GitCommitDialogView
          onClose={onClose}
          controlsDisabled={locked}
          branchLabel="Resolved by the saved-change commit"
          totalChanges={diff.files.length}
          additions={counts("additions")}
          deletions={counts("deletions")}
          includeUnstaged={includeAll}
          setIncludeUnstaged={setIncludeAll}
          selectionControl={
            <div className="space-y-3">
              <GitCommitSelectionControl
                included={includeAll}
                onChange={setIncludeAll}
                disabled={locked}
                label="Include all saved changes"
                detail="Commit immutable changes from this selected settled turn"
              />
              {!includeAll ? (
                <div
                  role="group"
                  aria-label="Saved paths to commit"
                  className="ui-surface-section max-h-60 overflow-y-auto"
                >
                  {diff.files.map((file) => (
                    <ChangeItem
                      key={file.path}
                      file={file}
                      depth={0}
                      isSelected={paths.has(file.path)}
                      pressed={paths.has(file.path)}
                      disabled={locked}
                      showFullPath
                      onSelect={() => {
                        if (!locked)
                          setPaths((previous) => {
                            const next = new Set(previous);
                            if (next.has(file.path)) next.delete(file.path);
                            else next.add(file.path);
                            return next;
                          });
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          }
          resolvedCommitIdentity={null}
          authorFormVisible
          requiresAuthorInput
          setUseCustomAuthor={() => {}}
          authorName={authorName}
          authorEmail={authorEmail}
          setAuthorName={setAuthorName}
          setAuthorEmail={setAuthorEmail}
          commitMessage={message}
          setCommitMessage={setMessage}
          messagePlaceholder="Describe these saved changes"
          stepOptions={stepOptions}
          nextStep={nextStep}
          setNextStep={setNextStep}
          requiresBranchInput={false}
          currentBranch=""
          defaultBranch=""
          branchName=""
          setBranchName={() => {}}
          requiresPullRequestInput={false}
          repo={false}
          pullRequestTitle=""
          setPullRequestTitle={() => {}}
          pullRequestBody=""
          setPullRequestBody={() => {}}
          flowSuccess={
            confirmedReceipt
              ? { kind: "commit", branch: confirmedReceipt.branchName }
              : null
          }
          errorMessage={
            !availability.available
              ? availability.reason
              : (error ??
                (uncertain && !busy
                  ? "The earlier commit outcome is unconfirmed. Automatic retry is disabled. Inspect the repository before another commit."
                  : null))
          }
          handleContinue={commit}
          canContinue={
            Boolean(confirmedReceipt) ||
            (availability.available &&
              request.success &&
              !locked &&
              diff.files.length > 0)
          }
          submittingFlow={busy}
        />
      </div>
    </PickerModal>
  );
}
