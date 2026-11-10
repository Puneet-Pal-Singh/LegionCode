import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Image,
  Loader2,
  GitMerge,
  GitPullRequest,
  SquareMenu,
} from "lucide-react";
import type {
  HostedSessionPullRequestsResponse,
  RepositoryReadRepository,
} from "@legioncode/sdk";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss.js";
import { useViewportPopoverPosition } from "../hooks/useViewportPopoverPosition.js";
import { cn } from "../classnames.js";
import { shouldIgnoreGlobalKeyDown } from "../hooks/global-keydown.js";
import { getVisibleFocusTargets } from "../hooks/modal-focus.js";
import { useWorkspaceSummaryLayout } from "./WorkspaceSummaryLayout.js";
import type { ChatImagePreview } from "../conversation/ChatImageGallery.js";

export interface EnvironmentSavedSources {
  images: ChatImagePreview[];
  status: "loading" | "ready" | "partial" | "failed" | "recovery-required";
  error: string | null;
}

export interface EnvironmentBranchPanelContext {
  panelRef: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
  onClose: () => void;
}

export interface EnvironmentSummaryMenuProps {
  repo: Pick<RepositoryReadRepository, "default_branch"> | null;
  branch: string;
  changedFileCount?: number;
  /** Show the supplied native branch without advertising an unavailable change command. */
  readOnlyBranch?: boolean;
  pullRequestResult?: HostedSessionPullRequestsResponse;
  savedSources?: EnvironmentSavedSources;
  onBranchChange?: (branch: string) => void;
  onOpenChanges?: () => void;
  onOpenCommit?: () => void;
  onOpenSources?: () => void;
  onOpen?: () => void;
  renderBranchPanel?: (context: EnvironmentBranchPanelContext) => ReactNode;
}

export function EnvironmentSummaryMenu(props: EnvironmentSummaryMenuProps) {
  const layout = useWorkspaceSummaryLayout();
  const [localOpen, setLocalOpen] = useState(false);
  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const panelId = `environment-summary-${useId()}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchPanelRef = useRef<HTMLDivElement>(null);
  const inline = Boolean(layout?.inlineVisible && layout.inlineTarget);
  const isOpen = layout ? !layout.inlineEligible && layout.popupOpen : localOpen;
  const visible = inline || isOpen;
  const setHasSummary = layout?.setHasSummary;
  const registerTrigger = layout?.registerTrigger;
  const dismissPopup = layout?.dismissPopup;
  useLayoutEffect(() => {
    setHasSummary?.(true);
    return () => { setHasSummary?.(false); };
  }, [setHasSummary]);
  const bindTrigger = useCallback((element: HTMLButtonElement | null) => {
    triggerRef.current = element;
    registerTrigger?.(element);
  }, [registerTrigger]);
  const panelPosition = useViewportPopoverPosition(isOpen, triggerRef, panelRef);
  const branchPanelPosition = useViewportPopoverPosition(
    isBranchOpen && Boolean(props.repo), branchTriggerRef, branchPanelRef,
  );
  const close = useCallback(() => {
    setLocalOpen(false);
    dismissPopup?.();
    setIsBranchOpen(false);
  }, [dismissPopup]);
  const additionalRefs = useMemo(() => [panelRef, branchPanelRef], []);
  useOutsideDismiss(rootRef, isOpen || isBranchOpen, close, { additionalRefs });
  useEffect(() => { setIsBranchOpen(false); }, [layout?.inlineEligible]);
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) props.onOpen?.();
    wasVisible.current = visible;
  }, [visible, props.onOpen]);
  useLayoutEffect(() => {
    if (!isOpen || !panelRef.current) return;
    (getVisibleFocusTargets(panelRef.current)[0] ?? panelRef.current).focus();
  }, [isOpen, layout?.overlayTarget]);
  useEffect(() => {
    if (!isOpen && !isBranchOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalKeyDown(event) || event.key !== "Escape") return;
      event.preventDefault();
      if (isBranchOpen) {
        setIsBranchOpen(false);
        branchTriggerRef.current?.focus();
      } else {
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close, isBranchOpen, isOpen]);
  const panel = visible ? (
    <EnvironmentPanel
      {...props}
      inline={inline}
      panelId={panelId}
      onClose={close}
      panelRef={panelRef}
      panelPosition={inline ? undefined : panelPosition}
      branchTriggerRef={branchTriggerRef}
      onOpenBranch={() => setIsBranchOpen((current) => !current)}
    />
  ) : null;
  const branchPanel = isBranchOpen && props.repo
    ? props.renderBranchPanel?.({ panelRef: branchPanelRef, style: branchPanelPosition, onClose: () => setIsBranchOpen(false) })
    : null;
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={bindTrigger}
        type="button"
        onClick={() => {
          setIsBranchOpen(false);
          if (layout) layout.toggle();
          else setLocalOpen((open) => !open);
        }}
        aria-label="Toggle environment summary"
        aria-expanded={visible}
        aria-haspopup={layout?.inlineEligible ? undefined : "dialog"}
        aria-controls={panelId}
        title="Toggle summary"
        className={cn(
          "size-8 rounded-lg p-1.5 text-zinc-400 outline-none transition-colors hover:bg-zinc-800 hover:text-white focus-visible:ring-1 focus-visible:ring-zinc-500",
          visible && "bg-zinc-800 text-white",
        )}
      >
        <SquareMenu size={16} />
      </button>
      {inline && layout?.inlineTarget
        ? createPortal(panel, layout.inlineTarget)
        : layout?.overlayTarget ? createPortal(panel, layout.overlayTarget) : panel}
      {layout?.overlayTarget ? createPortal(branchPanel, layout.overlayTarget) : branchPanel}
    </div>
  );
}

function EnvironmentPanel(
  props: EnvironmentSummaryMenuProps & {
    onClose: () => void;
    onOpenBranch: () => void;
    panelRef: RefObject<HTMLDivElement | null>;
    panelPosition?: CSSProperties;
    inline?: boolean;
    panelId: string;
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
      inline={props.inline}
      panelId={props.panelId}
      panelRef={props.panelRef}
      panelPosition={props.panelPosition}
    />
  );
}

function EnvironmentPanelView({
  actions,
  panelRef,
  panelPosition,
  inline,
  panelId,
}: {
  actions: EnvironmentActionsProps;
  inline?: boolean;
  panelId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  panelPosition?: CSSProperties;
}) {
  return (
    <div
      ref={panelRef}
      id={panelId}
      role={inline ? "region" : "dialog"}
      tabIndex={inline ? undefined : -1}
      aria-label="Environment summary"
      className={inline
        ? "ui-surface-popover w-full min-w-0 overflow-y-auto p-2"
        : "ui-surface-popover fixed left-0 top-0 z-[120] w-[21.25rem] overflow-y-auto p-2"}
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
    onOpenChanges || (repo && (props.onBranchChange || props.readOnlyBranch)) ||
    (changedFileCount !== undefined &&
      changedFileCount > 0 &&
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
  const hasSummarySection = showPullRequests || showSources;
  return (
    <>
      {showPullRequests ? (
        <section aria-label="Pull requests" className="px-1 pb-2">
          <SectionHeading>Pull requests</SectionHeading>
          <PullRequestStatus
            loading={pullRequestLoading}
            result={props.pullRequestResult}
          />
        </section>
      ) : null}
      {showSources ? (
        <div
          className={cn(
            "px-1 pb-2 pt-1",
            showPullRequests && "border-t border-zinc-700/70",
          )}
        >
          <SourcesSummary
            sources={savedSources}
            onOpenSources={props.onOpenSources}
          />
        </div>
      ) : null}
      {hasEnvironmentActions ? (
        <div
          className={cn(
            "mt-2 pt-1",
            hasSummarySection && "border-t border-zinc-700/70",
          )}
        >
          {onOpenChanges ? (
            <ChangesAction count={changedFileCount} onClick={onOpenChanges} />
          ) : null}
          <BranchAction
            repo={repo}
            branch={branch}
            onToggle={onOpenBranch}
            enabled={Boolean(props.onBranchChange)}
            readOnly={props.readOnlyBranch}
            triggerRef={props.branchTriggerRef}
          />
          <CommitAction
            visible={
              changedFileCount !== undefined &&
              changedFileCount > 0 &&
              Boolean(onOpenCommit)
            }
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

const EMPTY_SOURCES: EnvironmentSavedSources = {
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
  sources: EnvironmentSavedSources;
  onOpenSources?: () => void;
}) {
  const sourceCount = sources.images.length;
  const statusMessage =
    sources.status === "loading"
      ? "Loading saved sources…"
      : sources.status === "partial"
        ? "Some saved sources could not be loaded."
        : sources.status === "failed"
          ? "Saved sources could not be loaded."
          : sources.status === "recovery-required"
            ? "Saved chat history needs recovery."
            : null;

  return (
    <section aria-label="Sources">
      <div className="flex items-center justify-between">
        <SectionHeading>Sources</SectionHeading>
        {sourceCount > 0 ? (
          <span className="px-2.5 text-[11px] text-zinc-500">
            {sourceCount}
          </span>
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
                  <Image
                    size={15}
                    className="text-zinc-500"
                    aria-hidden="true"
                  />
                )}
              </div>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                {image.name}
              </span>
            </div>
          ))}
          {sourceCount > 3 ? (
            <p className="px-1 text-[11px] text-zinc-500">
              {sourceCount - 3} more saved{" "}
              {sourceCount - 3 === 1 ? "image" : "images"}
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
  return (
    <SummaryButton
      icon={<FileDiff size={15} />}
      label="Changes"
      detail={count === undefined ? undefined : `${count}`}
      onClick={onClick}
    />
  );
}

function BranchAction({
  repo,
  branch,
  onToggle,
  enabled,
  readOnly,
  triggerRef,
}: {
  repo: Pick<RepositoryReadRepository, "default_branch"> | null;
  branch: string;
  onToggle: () => void;
  enabled: boolean;
  readOnly?: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  if (!repo || (!enabled && !readOnly)) return null;
  return (
    <>
      <SummaryButton
        buttonRef={triggerRef}
        icon={<GitBranch size={16} />}
        label={branch || repo.default_branch}
        disabled={!enabled}
        chevron={enabled}
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
      <div
        role="status"
        className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-500"
      >
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
    <div className="mt-1.5 space-y-0.5 pt-1">
      {result.pullRequests.map((pullRequest) => (
        <a
          key={pullRequest.url}
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-zinc-200 hover:bg-zinc-700/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        >
          {pullRequest.state === "merged" ? (
            <GitMerge
              size={14}
              className="shrink-0 text-violet-400"
              aria-hidden="true"
            />
          ) : (
            <GitPullRequest
              size={14}
              className={`shrink-0 ${pullRequest.state === "open" ? "text-emerald-400" : "text-zinc-500"}`}
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
          <span className="shrink-0 text-zinc-500">#{pullRequest.number}</span>
          <span
            className={`shrink-0 ${pullRequest.state === "merged" ? "text-violet-400" : pullRequest.state === "open" ? "text-emerald-400" : "text-zinc-500"}`}
          >
            {pullRequest.state === "merged"
              ? "Merged"
              : pullRequest.state === "closed"
                ? "Closed"
                : pullRequest.draft
                  ? "Draft"
                  : "Open"}
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
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  chevron?: boolean;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  disabled?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
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
