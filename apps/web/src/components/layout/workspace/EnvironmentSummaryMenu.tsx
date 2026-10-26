import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ChevronDown,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Image,
  List as ListIcon,
  Loader2,
  GitMerge,
  GitPullRequest,
} from "lucide-react";
import type {
  Branch,
  Repository,
} from "../../../services/GitHubService";
import type { HostedSessionPullRequestsResponse } from "@legioncode/sdk";
import { listBranches } from "../../../services/GitHubService";
import { useOutsideDismiss } from "../../../hooks/useOutsideDismiss";
import { cn } from "@legioncode/client-ui";
import { BranchSelectorPanel } from "../../github/BranchSelector";
import type { SavedChatSourcesProjection } from "../../../lib/saved-chat-sources";

export interface EnvironmentSummaryMenuProps {
  repo: Repository | null;
  branch: string;
  changedFileCount?: number;
  pullRequestResult?: HostedSessionPullRequestsResponse;
  savedSources?: SavedChatSourcesProjection;
  onBranchChange?: (branch: string) => void;
  onOpenChanges?: () => void;
  onOpenCommit?: () => void;
  onOpenSources?: () => void;
  onOpen?: () => void;
}

export function EnvironmentSummaryMenu(props: EnvironmentSummaryMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchPanelRef = useRef<HTMLDivElement>(null);
  const panelPosition = useViewportPopoverPosition(isOpen, triggerRef, panelRef);
  const branchPanelPosition = useViewportPopoverPosition(
    isBranchOpen && Boolean(props.repo),
    branchTriggerRef,
    branchPanelRef,
  );
  const close = useCallback(() => {
    setIsOpen(false);
    setIsBranchOpen(false);
  }, []);
  const { branches, loading } = useBranches(props.repo);
  useOutsideDismiss(rootRef, isOpen || isBranchOpen, close);
  useEffect(() => {
    if (!isOpen && !isBranchOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close, isBranchOpen, isOpen]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          if (next) props.onOpen?.();
        }}
        aria-label="Toggle environment summary"
        aria-expanded={isOpen}
        className={cn(
          "rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white",
          isOpen && "bg-zinc-800 text-white",
        )}
      >
        <ListIcon size={16} />
      </button>
      {isOpen ? (
        <EnvironmentPanel
          {...props}
          onClose={close}
          panelRef={panelRef}
          panelPosition={panelPosition}
          branchTriggerRef={branchTriggerRef}
          onOpenBranch={() => setIsBranchOpen((current) => !current)}
        />
      ) : null}
      {isBranchOpen && props.repo ? (
        <BranchSelectorPanel
          branches={branches}
          currentBranch={props.branch}
          isLoading={loading}
          panelRef={branchPanelRef}
          style={branchPanelPosition}
          className="fixed left-0 top-0 z-[130]"
          onBranchSelect={(branch) => {
            props.onBranchChange?.(branch);
            setIsBranchOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function EnvironmentPanel(
  props: EnvironmentSummaryMenuProps & {
    onClose: () => void;
    onOpenBranch: () => void;
    panelRef: RefObject<HTMLDivElement | null>;
    panelPosition: CSSProperties;
    branchTriggerRef: RefObject<HTMLButtonElement | null>;
  },
) {
  const closeAfter = (action: () => void) => () => {
    action();
    props.onClose();
  };
  const actions = {
    ...props,
    onOpenChanges: props.onOpenChanges
      ? closeAfter(props.onOpenChanges)
      : undefined,
    onOpenCommit: props.onOpenCommit
      ? closeAfter(props.onOpenCommit)
      : undefined,
    onOpenSources: props.onOpenSources
      ? closeAfter(props.onOpenSources)
      : undefined,
    pullRequestLoading: props.pullRequestResult === undefined,
    branchTriggerRef: props.branchTriggerRef,
  };
  return (
    <EnvironmentPanelView
      actions={actions}
      panelRef={props.panelRef}
      panelPosition={props.panelPosition}
    />
  );
}

function EnvironmentPanelView({
  actions,
  panelRef,
  panelPosition,
}: {
  actions: EnvironmentActionsProps;
  panelRef: RefObject<HTMLDivElement | null>;
  panelPosition: CSSProperties;
}) {
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Environment summary"
      className="ui-surface-popover fixed left-0 top-0 z-[120] max-h-[min(70vh,560px)] w-[min(21.25rem,calc(100vw-1rem))] overflow-y-auto !rounded-[20px] p-2"
      style={panelPosition}
    >
      <EnvironmentActions {...actions} />
    </div>
  );
}

interface EnvironmentActionsProps extends EnvironmentSummaryMenuProps {
  pullRequestLoading: boolean;
  onOpenBranch: () => void;
  branchTriggerRef: RefObject<HTMLButtonElement | null>;
}

function EnvironmentActions(props: EnvironmentActionsProps) {
  const {
    repo,
    branch,
    changedFileCount,
    pullRequestLoading,
    onOpenBranch,
    onOpenChanges,
    onOpenCommit,
  } = props;
  const hasEnvironmentActions = Boolean(
    (repo && props.onBranchChange) ||
      (changedFileCount !== undefined && changedFileCount > 0 &&
        (onOpenChanges || onOpenCommit)),
  );
  const savedSources = props.savedSources ?? EMPTY_SOURCES;
  const showPullRequests =
    pullRequestLoading ||
    props.pullRequestResult?.status === "unavailable" ||
    (props.pullRequestResult?.status === "available" &&
      props.pullRequestResult.pullRequests.length > 0);
  const showSources =
    savedSources.status !== "ready" || savedSources.images.length > 0;
  const hasSummaryContent =
    showPullRequests || showSources || hasEnvironmentActions;
  return (
    <>
      {showPullRequests ? (
        <section
          aria-label="Pull requests"
          className="border-b border-zinc-800/80 px-1 pb-2"
        >
          <SectionHeading>Pull requests</SectionHeading>
          <PullRequestStatus
            loading={pullRequestLoading}
            result={props.pullRequestResult}
          />
        </section>
      ) : null}
      {showSources ? (
        <SourcesSummary
          sources={savedSources}
          onOpenSources={props.onOpenSources}
        />
      ) : null}
      {hasEnvironmentActions ? (
        <div className="mt-2 border-t border-zinc-800/80 pt-1">
          {onOpenChanges ? (
            <ChangesAction count={changedFileCount} onClick={onOpenChanges} />
          ) : null}
          <BranchAction
            repo={repo}
            branch={branch}
            onToggle={onOpenBranch}
            enabled={Boolean(props.onBranchChange)}
            triggerRef={props.branchTriggerRef}
          />
          <CommitAction
            visible={changedFileCount !== undefined && changedFileCount > 0 && Boolean(onOpenCommit)}
            onClick={onOpenCommit ?? (() => undefined)}
          />
        </div>
      ) : null}
      {!hasSummaryContent ? (
        <p role="status" className="px-2.5 py-2 text-xs text-zinc-400">
          No additional details for this chat.
        </p>
      ) : null}
    </>
  );
}

const EMPTY_SOURCES: SavedChatSourcesProjection = {
  images: [],
  status: "ready",
  error: null,
};

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-2.5 py-1.5 text-[11px] font-medium text-zinc-400">
      {children}
    </h3>
  );
}

function SourcesSummary({
  sources,
  onOpenSources,
}: {
  sources: SavedChatSourcesProjection;
  onOpenSources?: () => void;
}) {
  const sourceCount = sources.images.length;
  const statusMessage = sources.status === "loading"
    ? "Loading saved sources…"
    : sources.status === "partial"
      ? "Some saved sources could not be loaded."
      : sources.status === "failed"
        ? "Saved sources could not be loaded."
        : sources.status === "recovery-required"
          ? "Saved chat history needs recovery."
          : null;

  return (
    <section aria-label="Sources" className="border-b border-zinc-800/80 px-1 pb-2 pt-1">
      <div className="flex items-center justify-between">
        <SectionHeading>Sources</SectionHeading>
        {sourceCount > 0 ? (
          <span className="px-2.5 text-[11px] text-zinc-500">{sourceCount}</span>
        ) : null}
      </div>
      {sourceCount > 0 ? (
        <div className="space-y-1 px-2.5">
          {sources.images.slice(0, 3).map((image) => (
            <div
              key={image.id}
              className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1"
              title={image.name}
            >
              <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded border border-zinc-700 bg-zinc-900">
                {image.src ? (
                  <img
                    src={image.src}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <Image size={15} className="text-zinc-500" aria-hidden="true" />
                )}
              </div>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                {image.name}
              </span>
            </div>
          ))}
          {sourceCount > 3 ? (
            <p className="px-1 text-[11px] text-zinc-500">
              {sourceCount - 3} more saved {sourceCount - 3 === 1 ? "image" : "images"}
            </p>
          ) : null}
        </div>
      ) : null}
      {statusMessage ? (
        <p
          role={sources.status === "ready" ? undefined : "status"}
          className="px-2.5 py-1 text-xs text-zinc-500"
        >
          {statusMessage}
        </p>
      ) : null}
      {sources.error ? (
        <p className="px-2.5 pb-1 text-[11px] text-zinc-500">{sources.error}</p>
      ) : null}
      {onOpenSources ? (
        <button
          type="button"
          onClick={onOpenSources}
          className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        >
          View all
        </button>
      ) : null}
    </section>
  );
}

function ChangesAction({
  count,
  onClick,
}: {
  count?: number;
  onClick: () => void;
}) {
  if (count === undefined || count === 0) return null;
  return (
    <SummaryButton
      icon={<FileDiff size={15} />}
      label="Changes"
      detail={`${count}`}
      onClick={onClick}
    />
  );
}

function BranchAction({
  repo,
  branch,
  onToggle,
  enabled,
  triggerRef,
}: {
  repo: Repository | null;
  branch: string;
  onToggle: () => void;
  enabled: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  if (!repo || !enabled) return null;
  return (
    <>
      <SummaryButton
        buttonRef={triggerRef}
        icon={<GitBranch size={16} />}
        label={branch || repo.default_branch}
        chevron
        onClick={onToggle}
      />
    </>
  );
}

function CommitAction({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return visible ? (
    <SummaryButton
      icon={<GitCommitHorizontal size={16} />}
      label="Commit or push"
      onClick={onClick}
    />
  ) : null;
}

function PullRequestStatus({
  loading,
  result,
}: {
  loading: boolean;
  result?: HostedSessionPullRequestsResponse;
}) {
  if (loading)
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-zinc-500">
        <Loader2 size={15} className="animate-spin" />
        Checking pull request...
      </div>
    );
  if (!result || result.status === "unavailable") {
    return (
      <div role="status" className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-500">
        <GitPullRequest size={15} />
        Pull request status unavailable
      </div>
    );
  }
  if (result.pullRequests.length === 0) {
    return (
      <div className="px-2.5 py-1.5 text-xs text-zinc-500">
        No linked pull requests
      </div>
    );
  }
  return (
    <div className="mt-1.5 space-y-0.5 border-t border-zinc-700 pt-1">
      {result.pullRequests.map((pullRequest) => (
        <a
          key={pullRequest.url}
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-zinc-200 hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        >
          {pullRequest.state === "merged" ? (
            <GitMerge size={14} className="shrink-0 text-violet-400" aria-hidden="true" />
          ) : (
            <GitPullRequest size={14} className={`shrink-0 ${pullRequest.state === "open" ? "text-emerald-400" : "text-zinc-500"}`} aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
          <span className="shrink-0 text-zinc-500">#{pullRequest.number}</span>
          <span className={`shrink-0 ${pullRequest.state === "merged" ? "text-violet-400" : pullRequest.state === "open" ? "text-emerald-400" : "text-zinc-500"}`}>
            {pullRequest.state === "merged" ? "Merged" : pullRequest.state === "closed" ? "Closed" : pullRequest.draft ? "Draft" : "Open"}
          </span>
        </a>
      ))}
    </div>
  );
}

function SummaryButton({
  icon,
  label,
  detail,
  chevron,
  onClick,
  buttonRef,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  chevron?: boolean;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-100 transition-colors hover:bg-zinc-800"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="text-xs text-zinc-500">{detail}</span> : null}
      {chevron ? <ChevronDown size={15} className="text-zinc-500" /> : null}
    </button>
  );
}

function useViewportPopoverPosition(
  isOpen: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({
    position: "fixed",
    left: 0,
    top: 0,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!isOpen) return;
    const updatePosition = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) return;

      const left = Math.max(
        8,
        Math.min(trigger.right - panel.width, window.innerWidth - panel.width - 8),
      );
      const below = trigger.bottom + 8;
      const top =
        below + panel.height <= window.innerHeight - 8
          ? below
          : Math.max(8, trigger.top - panel.height - 8);
      setPosition({ position: "fixed", left, top, visibility: "visible" });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, panelRef, triggerRef]);

  return position;
}

function useBranches(repo: Repository | null): {
  branches: Branch[];
  loading: boolean;
} {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!repo) {
      // Clear data from the previously selected repository.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBranches([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listBranches(repo.owner.login, repo.name)
      .then((items) => {
        if (!cancelled) setBranches(items);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);
  return { branches, loading };
}
