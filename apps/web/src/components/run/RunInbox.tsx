/**
 * RunInbox Component
 * Displays a filterable list of runs with status indicators.
 * Supports run selection, filtering, and empty/loading/error states.
 */

import { useState, useMemo } from "react";
import { ChevronDown, Zap, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { formatTimeAgo } from "../../lib/timeFormat";

export type RunStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "failed"
  | "complete";

export interface RunInboxItem {
  runId: string;
  sessionId: string;
  title: string;
  status: RunStatus;
  updatedAt: string;
  repository: string;
}

interface RunInboxProps {
  runs: RunInboxItem[];
  activeRunId: string | null;
  onSelectRun: (runId: string, sessionId: string) => void;
  isLoading?: boolean;
  error?: string | null;
}

function getStatusIcon(status: RunStatus) {
  switch (status) {
    case "complete":
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    case "running":
      return <Zap className="w-4 h-4 text-blue-500 animate-pulse" />;
    case "failed":
      return <AlertCircle className="w-4 h-4 text-red-500" />;
    case "waiting":
    case "paused":
      return <Clock className="w-4 h-4 text-yellow-500" />;
    case "queued":
      return <Clock className="w-4 h-4 text-zinc-400" />;
    case "idle":
    default:
      return <Clock className="w-4 h-4 text-zinc-600" />;
  }
}

function getStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    idle: "Idle",
    queued: "Queued",
    running: "Running",
    waiting: "Waiting",
    paused: "Paused",
    failed: "Failed",
    complete: "Complete",
  };
  return labels[status];
}

function getStatusColor(status: RunStatus): string {
  const colors: Record<RunStatus, string> = {
    idle: "bg-zinc-900 text-zinc-400",
    queued: "bg-zinc-800 text-zinc-300",
    running: "bg-blue-900 text-blue-200",
    waiting: "bg-yellow-900 text-yellow-200",
    paused: "bg-yellow-900 text-yellow-200",
    failed: "bg-red-900 text-red-200",
    complete: "bg-green-900 text-green-200",
  };
  return colors[status];
}

export function RunInbox({
  runs,
  activeRunId,
  onSelectRun,
  isLoading,
  error,
}: RunInboxProps) {
  const [filter, setFilter] = useState<RunStatus | "all">("all");

  const filteredRuns = useMemo(() => {
    if (filter === "all") return runs;
    return runs.filter((run) => run.status === filter);
  }, [runs, filter]);

  const sortedRuns = useMemo(() => {
    return [...filteredRuns].sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [filteredRuns]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center p-4 text-center">
        <AlertCircle className="w-8 h-8 text-red-500 mb-2" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-4">
        <div className="animate-spin w-6 h-6 border-2 border-zinc-600 border-t-white rounded-full" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-6 text-center">
        <p className="text-sm text-zinc-500">No runs yet</p>
        <p className="text-xs text-zinc-600 mt-1">Create a new task to get started</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter Bar */}
      <div className="border-b border-zinc-800 p-3">
        <div className="relative">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as RunStatus | "all")}
            className="w-full bg-zinc-900 text-zinc-200 text-sm rounded px-2 py-1.5 appearance-none cursor-pointer border border-zinc-700 hover:border-zinc-600 focus:outline-none focus:border-zinc-500"
          >
            <option value="all">All Runs</option>
            <option value="idle">Idle</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="waiting">Waiting</option>
            <option value="failed">Failed</option>
            <option value="complete">Complete</option>
          </select>
          <ChevronDown className="w-4 h-4 text-zinc-500 absolute right-2 top-2 pointer-events-none" />
        </div>
      </div>

      {/* Run List */}
      <div className="flex-1 overflow-y-auto">
        {sortedRuns.length === 0 ? (
          <div className="flex items-center justify-center p-4 text-center h-20">
            <p className="text-xs text-zinc-600">
              {filter === "all"
                ? "No runs yet"
                : `No runs with status "${getStatusLabel(filter)}"`}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {sortedRuns.map((run) => (
              <button
                key={run.runId}
                onClick={() => onSelectRun(run.runId, run.sessionId)}
                className={`w-full px-3 py-3 text-left transition-colors ${
                  activeRunId === run.runId
                    ? "bg-zinc-800 border-l-2 border-blue-500"
                    : "hover:bg-zinc-900 border-l-2 border-transparent"
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="mt-1">{getStatusIcon(run.status)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-medium text-zinc-200 truncate">
                        {run.title}
                      </p>
                      <span
                        className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${getStatusColor(
                          run.status,
                        )}`}
                      >
                        {getStatusLabel(run.status)}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500 truncate">
                      {run.repository}
                    </p>
                    <p className="text-xs text-zinc-600 mt-1">
                      {formatTimeAgo(new Date(run.updatedAt))}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
