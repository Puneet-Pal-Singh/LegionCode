import { Children } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TOOL_ACTIVITY_FAMILIES } from "@repo/shared-types";
import { cn } from "../../../lib/utils.js";
import type { ActivityFeedRowViewModel } from "../../../services/activity/ActivityFeedViewModel.js";
import { toCompactExplorationTitle } from "../workflow/explorationCopy.js";

interface ActivityRowProps {
  row: ActivityFeedRowViewModel;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  onUsePlanInBuild?: () => void;
  displayMode?: "card" | "transcript";
  collapsible?: boolean;
}

export function ActivityRow({
  row,
  expanded,
  onToggle,
  onUsePlanInBuild,
  displayMode = "card",
  collapsible = true,
}: ActivityRowProps) {
  switch (row.kind) {
    case "text":
      return isRecoveryTextRow(row) ? (
        <RecoveryTextRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      ) : (
        <TextRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      );
    case "commentary":
      return isRecoveryCommentaryRow(row) ? (
        <RecoveryCommentaryRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      ) : (
        <CommentaryRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      );
    case "reasoning":
      return (
        <ReasoningRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      );
    case "approval":
      return (
        <ApprovalRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      );
    case "handoff":
      return (
        <HandoffRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          onUsePlanInBuild={onUsePlanInBuild}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      );
    case "group":
      return (
        <GroupRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          onUsePlanInBuild={onUsePlanInBuild}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      );
    case "tool":
      return (
        <ToolRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          displayMode={displayMode}
          collapsible={collapsible}
        />
      );
  }
}

function isRecoveryCommentaryRow(
  row: Extract<ActivityFeedRowViewModel, { kind: "commentary" }>,
): boolean {
  return hasRecoveryMetadata(row.metadata);
}

function hasRecoveryMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (metadata?.recovery === true) {
    return true;
  }

  const code = typeof metadata?.code === "string" ? metadata.code : undefined;
  return (
    code === "TOOL_EXECUTION_FAILED" ||
    code === "TASK_EXECUTION_TIMEOUT" ||
    code === "TASK_MODEL_NO_ACTION"
  );
}

function TextRow({
  row,
  expanded,
  onToggle,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "text" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  return (
    <ExpandableRow
      label={deriveTextLabel(row.role)}
      summary={deriveTextSummary(row.content)}
      expanded={expanded}
      onToggle={onToggle}
      tone="completed"
      displayMode={displayMode}
      collapsible={collapsible}
    >
      <pre className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-black/40 px-3 py-2 text-xs text-zinc-200">
        {row.content}
      </pre>
    </ExpandableRow>
  );
}

function CommentaryRow({
  row,
  expanded,
  onToggle,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "commentary" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  if (displayMode === "transcript") {
    return (
      <TranscriptCommentaryRow
        text={row.text}
        active={row.status === "active"}
      />
    );
  }

  return (
    <ExpandableRow
      label={deriveCommentaryLabel(row.phase)}
      summary={deriveTextSummary(row.text)}
      expanded={expanded}
      onToggle={onToggle}
      tone={row.status === "active" ? "running" : "completed"}
      displayMode={displayMode}
      collapsible={collapsible}
    >
      <pre className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-black/40 px-3 py-2 text-xs text-zinc-200">
        {row.text}
      </pre>
    </ExpandableRow>
  );
}

function TranscriptCommentaryRow({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  return (
    <div className={cn("py-1", active ? "" : "opacity-95")}>
      <MessageMarkdownContent content={text} />
    </div>
  );
}

function RecoveryCommentaryRow({
  row,
  expanded,
  onToggle,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "commentary" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  const { code, resumeHint, resumeActions } = parseRecoveryMetadata(
    row.metadata,
  );
  const label = deriveRecoveryLabel(code);
  const summary = deriveRecoverySummary(row.text, resumeHint);

  return (
    <ExpandableRow
      label={label}
      summary={summary}
      expanded={expanded}
      onToggle={onToggle}
      tone="failed"
      displayMode={displayMode}
      collapsible={collapsible}
    >
      <div className="space-y-2 text-xs text-zinc-200">
        <pre className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-black/40 px-3 py-2 text-xs text-zinc-200">
          {row.text}
        </pre>
        {resumeActions ? (
          <div className="text-zinc-400">Resume options: {resumeActions}</div>
        ) : null}
      </div>
    </ExpandableRow>
  );
}

function isRecoveryTextRow(
  row: Extract<ActivityFeedRowViewModel, { kind: "text" }>,
): boolean {
  const typedRow = row as unknown as {
    recovery?: boolean;
    isRecovery?: boolean;
    subtype?: string;
  };
  if (typedRow.recovery === true || typedRow.isRecovery === true) {
    return true;
  }
  if (typedRow.subtype === "recovery") {
    return true;
  }

  if (row.metadata?.recovery === true) {
    return true;
  }

  return hasRecoveryMetadata(row.metadata);
}

function RecoveryTextRow({
  row,
  expanded,
  onToggle,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "text" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  const { code, resumeHint, resumeActions } = parseRecoveryMetadata(
    row.metadata,
  );
  const label = deriveRecoveryLabel(code);
  const summary = deriveRecoverySummary(row.content, resumeHint);

  return (
    <ExpandableRow
      label={label}
      summary={summary}
      expanded={expanded}
      onToggle={onToggle}
      tone="failed"
      displayMode={displayMode}
      collapsible={collapsible}
    >
      <div className="space-y-2 text-xs text-zinc-200">
        <pre className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-black/40 px-3 py-2 text-xs text-zinc-200">
          {row.content}
        </pre>
        {resumeActions ? (
          <div className="text-zinc-400">Resume options: {resumeActions}</div>
        ) : null}
      </div>
    </ExpandableRow>
  );
}

function parseRecoveryMetadata(metadata: Record<string, unknown> | undefined): {
  code?: string;
  resumeHint: string;
  resumeActions: string;
} {
  return {
    code: typeof metadata?.code === "string" ? metadata.code : undefined,
    resumeHint:
      typeof metadata?.resumeHint === "string" ? metadata.resumeHint : "",
    resumeActions: Array.isArray(metadata?.resumeActions)
      ? metadata.resumeActions
          .filter((action): action is string => typeof action === "string")
          .join(" · ")
      : "",
  };
}

function deriveRecoveryLabel(code: string | undefined): string {
  if (code === "TASK_EXECUTION_TIMEOUT") {
    return "Recoverable timeout";
  }

  if (code === "TASK_MODEL_NO_ACTION") {
    return "Model stalled";
  }

  if (code === "TOOL_EXECUTION_FAILED") {
    return "Step failed";
  }

  return "Run update";
}

function deriveRecoverySummary(rowContent: string, resumeHint: string): string {
  return resumeHint || rowContent.split("\n")[0] || "";
}

function deriveTextLabel(role: "user" | "assistant" | "system"): string {
  switch (role) {
    case "assistant":
      return "Assistant update";
    case "system":
      return "System message";
    default:
      return "Message";
  }
}

function deriveCommentaryLabel(phase: "commentary" | "final_answer"): string {
  return phase === "final_answer" ? "Final answer" : "Commentary";
}

function deriveTextSummary(content: string): string {
  return content.split("\n")[0] || "";
}

function ReasoningRow({
  row,
  expanded,
  onToggle,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "reasoning" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  const isThinkingRow = row.label === "Thinking";

  if (displayMode === "transcript") {
    return (
      <CompactTranscriptRow
        label={row.label}
        detail={row.summary}
        subtle={isThinkingRow}
        emphasizeThinking={isThinkingRow && row.status === "active"}
      />
    );
  }

  return (
    <ExpandableRow
      label={row.label}
      summary={row.summary}
      expanded={expanded}
      onToggle={onToggle}
      tone={row.status === "active" ? "running" : "completed"}
      displayMode={displayMode}
      collapsible={collapsible}
      emphasizeThinking={isThinkingRow && row.status === "active"}
    >
      <div className="text-xs text-cyan-100/80">{row.summary}</div>
    </ExpandableRow>
  );
}

function ApprovalRow({
  row,
  expanded,
  onToggle,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "approval" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  const tone =
    row.status === "granted"
      ? "completed"
      : row.status === "requested"
        ? "requested"
        : "failed";
  return (
    <ExpandableRow
      label={getApprovalRowLabel(row.status)}
      summary={row.summary}
      expanded={expanded}
      onToggle={onToggle}
      tone={tone}
      displayMode={displayMode}
      collapsible={collapsible}
    >
      <div className="text-xs text-orange-100/70">
        {row.details || "No extra details."}
      </div>
    </ExpandableRow>
  );
}

function getApprovalRowLabel(
  status: Extract<ActivityFeedRowViewModel, { kind: "approval" }>["status"],
): string {
  if (status === "granted") {
    return "Approval Resolved";
  }
  if (status === "denied") {
    return "Approval Denied";
  }
  if (status === "expired") {
    return "Approval Expired";
  }
  return "Approval Required";
}

function HandoffRow({
  row,
  expanded,
  onToggle,
  onUsePlanInBuild,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "handoff" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  onUsePlanInBuild?: () => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  return (
    <ExpandableRow
      label="Build Handoff"
      summary={row.summary}
      expanded={expanded}
      onToggle={onToggle}
      tone="completed"
      displayMode={displayMode}
      collapsible={collapsible}
    >
      <div className="space-y-3">
        <pre className="overflow-x-auto rounded-xl border border-emerald-900/60 bg-black/40 px-3 py-2 text-xs text-emerald-100/80">
          {row.prompt}
        </pre>
        {onUsePlanInBuild ? (
          <button
            type="button"
            onClick={onUsePlanInBuild}
            className="rounded-full border border-emerald-700/70 bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-100 transition hover:border-emerald-500 hover:bg-emerald-900/40"
          >
            Execute Plan in Build
          </button>
        ) : null}
      </div>
    </ExpandableRow>
  );
}

function GroupRow({
  row,
  expanded,
  onToggle,
  onUsePlanInBuild,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "group" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  onUsePlanInBuild?: () => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  if (isExplorationGroup(row)) {
    return (
      <ExpandableRow
        label={combineCompactLabel(row.title, row.summary)}
        summary=""
        expanded={expanded}
        onToggle={onToggle}
        tone={row.status}
        displayMode={displayMode}
        collapsible={collapsible}
      >
        <div className="space-y-1 pl-4">
          {row.rows.map((groupRow) => (
            <div
              key={groupRow.key}
              className="text-sm font-medium text-zinc-500"
            >
              {getCompactExplorationTitle(groupRow)}
            </div>
          ))}
        </div>
      </ExpandableRow>
    );
  }

  return (
    <ExpandableRow
      label={row.title}
      summary={row.summary}
      expanded={expanded}
      onToggle={onToggle}
      tone={row.status}
      displayMode={displayMode}
      collapsible={collapsible}
    >
      <div className="space-y-2">
        {row.rows.map((groupRow) => (
          <ActivityRow
            key={groupRow.key}
            row={groupRow}
            expanded={true}
            onToggle={() => undefined}
            onUsePlanInBuild={onUsePlanInBuild}
            displayMode="transcript"
            collapsible={false}
          />
        ))}
      </div>
    </ExpandableRow>
  );
}

function ToolRow({
  row,
  expanded,
  onToggle,
  displayMode,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "tool" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  displayMode: "card" | "transcript";
  collapsible: boolean;
}) {
  if (displayMode === "transcript" && isShellStyledTool(row)) {
    return (
      <ShellTranscriptRow
        row={row}
        expanded={expanded}
        onToggle={onToggle}
        collapsible={collapsible}
      />
    );
  }

  if (displayMode === "transcript") {
    return (
      <CompactTranscriptRow
        label={row.title}
        badge={row.pluginLabel}
        detail={getCompactToolDetail(row)}
        subtle
      />
    );
  }

  const details =
    row.details.length > 0 ? (
      <div className="space-y-2">
        {row.details.map((detail, index) => (
          <pre
            key={`${row.key}-detail-${index}`}
            className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-black/40 px-3 py-2 text-xs text-zinc-200"
          >
            {detail}
          </pre>
        ))}
      </div>
    ) : null;

  return (
    <ExpandableRow
      label={row.title}
      badge={row.pluginLabel}
      summary={row.summary}
      expanded={expanded}
      onToggle={onToggle}
      tone={row.status}
      displayMode={displayMode}
      collapsible={collapsible}
    >
      {details}
    </ExpandableRow>
  );
}

function ShellTranscriptRow({
  row,
  expanded,
  onToggle,
  collapsible,
}: {
  row: Extract<ActivityFeedRowViewModel, { kind: "tool" }>;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  collapsible: boolean;
}) {
  const details = row.details.filter(Boolean);
  const isExpandable = collapsible && details.length > 0;

  if (!isExpandable) {
    return (
      <CompactTranscriptRow
        label={getShellTranscriptLabel(row)}
        badge={row.pluginLabel}
        detail={row.status === "failed" ? row.summary : undefined}
        subtle
      />
    );
  }

  return (
    <div className="space-y-2 py-1">
      <button
        type="button"
        onClick={() => onToggle(expanded)}
        className="flex w-full items-start gap-2 text-left"
      >
        <span className="mt-0.5">
          <ChevronIcon expanded={expanded} muted />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-400">
            <LabelWithBadge
              label={getShellTranscriptLabel(row)}
              badge={row.pluginLabel}
            />
          </div>
        </div>
      </button>
      {expanded ? (
        <div className="ml-5 rounded-2xl border border-zinc-700/60 bg-zinc-800/55 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm font-medium text-zinc-100">Shell</div>
            <div className={getShellStatusClassName(row.status)}>
              {getShellStatusLabel(row.status)}
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {details.map((detail, index) => (
              <pre
                key={`${row.key}-detail-${index}`}
                className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-transparent text-xs leading-6 text-zinc-100"
              >
                {detail}
              </pre>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ExpandableRow({
  label,
  badge,
  summary,
  expanded,
  onToggle,
  children,
  tone = "completed",
  displayMode = "card",
  collapsible = true,
  emphasizeThinking = false,
}: {
  label: React.ReactNode;
  badge?: string;
  summary: string;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  children: React.ReactNode;
  tone?: "requested" | "running" | "completed" | "failed";
  displayMode?: "card" | "transcript";
  collapsible?: boolean;
  emphasizeThinking?: boolean;
}) {
  const hasChildren = Children.count(children) > 0;

  if (!collapsible) {
    return (
      <div className="space-y-1 py-1">
        <div className="flex min-w-0 items-start gap-2 text-sm text-zinc-300">
          <span className="mt-[7px] h-1.5 w-1.5 rounded-full bg-zinc-600" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium text-zinc-200">
                <LabelWithBadge label={label} badge={badge} />
              </span>
              {summary ? (
                <span className={`text-xs ${toneClassName(tone)}`}>
                  {summary}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {hasChildren ? <div className="ml-5 mt-2">{children}</div> : null}
      </div>
    );
  }

  if (displayMode === "transcript") {
    return (
      <div className="space-y-1 py-1">
        <button
          type="button"
          onClick={() => onToggle(expanded)}
          className="flex w-full items-start gap-2 text-left"
        >
          {hasChildren ? (
            <span className="mt-0.5">
              <ChevronIcon expanded={expanded} muted />
            </span>
          ) : !emphasizeThinking ? (
            <span className={"mt-[7px] h-1.5 w-1.5 rounded-full bg-zinc-600"} />
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`truncate text-sm font-medium ${getTranscriptLabelClass(
                  emphasizeThinking,
                )}`}
              >
                <LabelWithBadge label={label} badge={badge} />
              </span>
              {summary ? (
                <span className={`text-xs ${toneClassName(tone)}`}>
                  {summary}
                </span>
              ) : null}
            </div>
          </div>
        </button>
        {hasChildren && expanded ? (
          <div className="ml-5 mt-2">{children}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-black/30 px-4 py-3">
      <button
        type="button"
        onClick={() => onToggle(expanded)}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <div>
          <div className="text-sm font-medium text-zinc-100">
            <LabelWithBadge label={label} badge={badge} />
          </div>
          <div className={`mt-1 text-xs ${toneClassName(tone)}`}>{summary}</div>
        </div>
        <div className="text-xs text-zinc-500">
          {expanded ? "Hide" : "Show"}
        </div>
      </button>
      {expanded ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

function CompactTranscriptRow({
  label,
  badge,
  detail,
  subtle = false,
  emphasizeThinking = false,
}: {
  label: React.ReactNode;
  badge?: string;
  detail?: string;
  subtle?: boolean;
  emphasizeThinking?: boolean;
}) {
  return (
    <div className="space-y-1 py-1">
      <div
        className={`flex items-center gap-2 text-sm font-medium ${
          subtle ? "text-zinc-500" : "text-zinc-200"
        }`}
      >
        <span className={getTranscriptLabelClass(emphasizeThinking)}>
          <LabelWithBadge label={label} badge={badge} />
        </span>
      </div>
      {detail ? (
        <div className="pl-4 text-sm text-zinc-500">{detail}</div>
      ) : null}
    </div>
  );
}

function LabelWithBadge({
  label,
  badge,
}: {
  label: React.ReactNode;
  badge?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{label}</span>
      {badge ? <PluginBadge label={badge} /> : null}
    </span>
  );
}

function PluginBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-700/60 bg-emerald-950/50 px-2 py-0.5 text-[11px] font-medium tracking-wide text-emerald-200">
      {label}
    </span>
  );
}

function MessageMarkdownContent({ content }: { content: string }) {
  return (
    <div
      className={cn(
        "break-words text-sm leading-relaxed text-zinc-100",
        "[&_p]:m-0 [&_p+*]:mt-3",
        "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        "[&_hr]:my-4 [&_hr]:border-zinc-700/60",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600/80 [&_blockquote]:pl-3 [&_blockquote]:italic",
        "[&_code]:rounded [&_code]:border [&_code]:border-zinc-700/90 [&_code]:bg-zinc-900/88 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-zinc-950/80 [&_pre]:p-3",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left",
        "[&_th]:border [&_th]:border-zinc-700/80 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold",
        "[&_td]:border [&_td]:border-zinc-800/80 [&_td]:px-2 [&_td]:py-1",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        components={{
          a: ({ className, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                "text-emerald-300 underline decoration-dotted underline-offset-2 transition-colors hover:text-emerald-200",
                className,
              )}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function toneClassName(tone: string): string {
  switch (tone) {
    case "running":
      return "text-zinc-500";
    case "failed":
      return "text-red-300";
    case "requested":
      return "text-amber-300";
    default:
      return "text-zinc-400";
  }
}

function ChevronIcon({
  expanded,
  muted = false,
}: {
  expanded: boolean;
  muted?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${muted ? "text-zinc-500" : ""} ${
        expanded ? "rotate-90 transition-transform" : "transition-transform"
      }`}
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function isExplorationGroup(
  row: Extract<ActivityFeedRowViewModel, { kind: "group" }>,
): boolean {
  return row.rows.every(
    (groupRow) =>
      groupRow.family === TOOL_ACTIVITY_FAMILIES.READ ||
      groupRow.family === TOOL_ACTIVITY_FAMILIES.SEARCH,
  );
}

function combineCompactLabel(label: string, summary: string): string {
  return summary ? `${label} ${summary}` : label;
}

function isShellStyledTool(
  row: Extract<ActivityFeedRowViewModel, { kind: "tool" }>,
): boolean {
  return row.family === TOOL_ACTIVITY_FAMILIES.SHELL;
}

function getCompactToolDetail(
  row: Extract<ActivityFeedRowViewModel, { kind: "tool" }>,
): string | undefined {
  if (row.status === "failed") {
    return row.summary;
  }

  return undefined;
}

function getCompactExplorationTitle(
  row: Extract<ActivityFeedRowViewModel, { kind: "tool" }>,
): string {
  return toCompactExplorationTitle(row.toolName, row.title);
}

function getShellTranscriptLabel(
  row: Extract<ActivityFeedRowViewModel, { kind: "tool" }>,
): string {
  const command = extractCommandLabel(row.details[0] ?? "");
  const prefix =
    row.status === "requested" || row.status === "running" ? "Running" : "Ran";

  return command ? `${prefix} ${command}` : `${prefix} command`;
}

function extractCommandLabel(detail: string): string {
  const firstLine = detail.split("\n")[0]?.trim() ?? "";
  if (!firstLine.startsWith("$ ")) {
    return "";
  }

  return truncateTranscriptCommandLabel(firstLine.slice(2).trim());
}

const COMMAND_LABEL_MAX_LENGTH = 160;

function truncateTranscriptCommandLabel(command: string): string {
  if (command.length <= COMMAND_LABEL_MAX_LENGTH) {
    return command;
  }

  return `${command.slice(0, COMMAND_LABEL_MAX_LENGTH - 1)}…`;
}

function getShellStatusLabel(
  status: Extract<ActivityFeedRowViewModel, { kind: "tool" }>["status"],
): string {
  switch (status) {
    case "failed":
      return "Failed";
    case "requested":
    case "running":
      return "Running";
    default:
      return "Success";
  }
}

function getShellStatusClassName(
  status: Extract<ActivityFeedRowViewModel, { kind: "tool" }>["status"],
): string {
  switch (status) {
    case "failed":
      return "text-xs font-medium text-red-200";
    case "requested":
    case "running":
      return "text-xs font-medium text-amber-200";
    default:
      return "text-xs font-medium text-zinc-200";
  }
}

function getTranscriptLabelClass(emphasizeThinking: boolean): string {
  if (!emphasizeThinking) {
    return "text-zinc-500";
  }

  return "bg-[linear-gradient(90deg,rgba(113,113,122,0.9)_0%,rgba(228,228,231,0.95)_45%,rgba(113,113,122,0.9)_100%)] bg-[length:220%_100%] bg-clip-text text-transparent animate-shimmer";
}
