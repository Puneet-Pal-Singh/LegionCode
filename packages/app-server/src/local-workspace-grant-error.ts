import { LocalPersistenceError } from "@repo/event-store/errors";
import { GitServiceError, type GitServiceErrorCode } from "@repo/git-service/errors";
import { NativeFilesystemError } from "@legioncode/execution-engine/runtime/desktop/NativeFilesystemBridge";
import {
  SingleProcessMacCapabilityError,
  SingleProcessMacLifetimeUncertainError,
} from "@legioncode/execution-engine/runtime/desktop/SingleExecutableProcess";
import { AppServerOperationError } from "./server.js";

const STAGES = {
  validation: "The selected workspace folder could not be validated.",
  protected_roots: "The selected workspace could not pass protected host scope validation.",
  root_pin: "The selected workspace directory authority could not be established.",
  metadata: "Workspace Git metadata inspection could not be completed safely.",
  git_probe: "The selected folder could not be verified as a Git repository root.",
  identity: "The workspace Git metadata association could not be confirmed.",
  persistence: "The workspace grant could not be persisted safely.",
  final_validation: "The workspace grant could not pass final authority validation.",
  cleanup: "Workspace grant resource cleanup could not be confirmed.",
} as const;
export type LocalWorkspaceGrantStage = keyof typeof STAGES;

// Exact known source strings select finite labels. Never return the source text.
const REASONS = new Map<string, string>([
  ["Git metadata layout is unavailable or unsupported", "metadata_layout_unsupported"],
  ["Git metadata paths require native Darwin directory inspection", "native_directory_inspection_unavailable"],
  ["Invalid native Git metadata identity", "invalid_metadata_receipt"],
  ["Invalid Git metadata layout kind", "invalid_metadata_receipt"],
  ["Invalid Git metadata layout path", "invalid_metadata_receipt"],
  ["Inconsistent Git metadata layout receipt", "invalid_metadata_receipt"],
  ["Native filesystem helper must be a protected regular executable", "native_helper_unavailable"],
  ["Native filesystem operation did not exit cleanly; mutation capture must settle actual state", "native_exit_unclean"],
  ["Native filesystem transport or authorization failed; mutation capture must settle actual state", "native_protocol_or_authorization_failed"],
  ["Native filesystem cleanup failed; workspace capture is required", "native_cleanup_uncertain"],
  ["Git and its guardian require trusted canonical paths", "git_executables_untrusted"],
  ["Canonical Mac Git readiness was not proved", "git_readiness_unproved"],
  ["Canonical Mac Git readiness timed out", "git_readiness_timed_out"],
  ["Canonical Mac Git readiness returned a nonzero exit status", "git_readiness_exit_nonzero"],
  ["Canonical Mac Git readiness output was truncated", "git_readiness_output_truncated"],
  ["Canonical Mac Git readiness version format was invalid", "git_readiness_version_format"],
  ["Canonical Mac Git execution did not prove process closure", "git_lifetime_uncertain"],
  ["Mac Git process closure was not proved", "git_lifetime_uncertain"],
  ["Trusted private Git configuration context is unavailable", "git_configuration_unavailable"],
  ["Trusted Git context requires an absolute directory", "git_configuration_unavailable"],
  ["Trusted Git context directory is unavailable", "git_configuration_unavailable"],
  ["Workspace overlaps protected host storage or application files", "protected_scope_overlap"],
  ["Workspace or Git metadata identity changed", "metadata_identity_changed"],
  ["Workspace selection must be the repository root", "repository_root_mismatch"],
  ["Repository probing is quarantined until host restart", "resource_lifetime_quarantined"],
]);
const GIT_CODES = new Set<GitServiceErrorCode>([
  "git_process_containment_unavailable", "git_commit_indeterminate", "git_command_failed",
  "invalid_branch_ref", "invalid_git_input", "malformed_status_output", "unsupported_status_record",
]);
const NODE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"]);
const STDERR_MESSAGES = new Map([
  ["developer_tool_error", "Developer tool lookup reported an error."],
  ["sandbox_launcher_error", "The process sandbox launcher reported an error."],
  ["operation_denied", "The Git readiness operation was denied."],
]);

function safeCategory(error: unknown): Record<string, string | number | boolean> {
  try {
    const reason = error instanceof Error ? REASONS.get(error.message) ?? "unknown" : "unknown";
    if (error instanceof NativeFilesystemError) return {
      failureCategory: "native_filesystem", reason,
      ...(Number.isInteger(error.code) && error.code >= 1 && error.code <= 5 ? { nativeCode: error.code } : {}),
    };
    if (error instanceof GitServiceError) {
      const readiness = error.code === "git_process_containment_unavailable" && reason.startsWith("git_readiness_");
      const metadata: Record<string, string | number | boolean> = {
        failureCategory: "git_service", reason,
        ...(GIT_CODES.has(error.code) ? { gitCode: error.code } : {}),
        ...(typeof error.context.exitCode === "number" && Number.isSafeInteger(error.context.exitCode)
          && (!readiness || (error.context.exitCode >= 0 && error.context.exitCode <= 255))
          ? { exitCode: error.context.exitCode } : {}),
      };
      if (readiness) {
        for (const key of ["readinessTimedOut", "readinessTruncated", "readinessOutputClosed", "readinessQuiescent", "readinessVersionPrefix"]) {
          const value = error.context[key];
          if (typeof value === "boolean") metadata[key] = value;
        }
        const category = error.context.readinessStderrCategory;
        if (typeof category === "string" && (STDERR_MESSAGES.has(category) || category === "other"))
          metadata.readinessStderrCategory = category;
      }
      return metadata;
    }
    if (error instanceof SingleProcessMacLifetimeUncertainError)
      return { failureCategory: "git_lifetime_uncertain", reason: "git_lifetime_uncertain" };
    if (error instanceof SingleProcessMacCapabilityError)
      return { failureCategory: "git_capability_unavailable", reason };
    if (error instanceof Error && "code" in error && typeof error.code === "string" && NODE_CODES.has(error.code))
      return { failureCategory: "filesystem", nodeCode: error.code, reason };
    return { failureCategory: "unknown", reason };
  } catch {
    return { failureCategory: "unknown", reason: "unknown" };
  }
}

/** Public failure classification only; never changes authority or resource state. */
export function workspaceGrantFailure(error: unknown, stage: LocalWorkspaceGrantStage): Error {
  // Keep the canonical storage 503 and existing explicit domain response intact.
  if (error instanceof LocalPersistenceError || error instanceof AppServerOperationError) return error;
  const metadata = safeCategory(error);
  const reason = typeof metadata.reason === "string" ? metadata.reason : "unknown";
  const detail = reason === "unknown" ? "" : ` ${reason.replaceAll("_", " ")}.`;
  const exitDetail = reason.startsWith("git_readiness_") && typeof metadata.exitCode === "number"
    ? ` Exit status ${metadata.exitCode}.` : "";
  const stderrDetail = typeof metadata.readinessStderrCategory === "string"
    ? STDERR_MESSAGES.get(metadata.readinessStderrCategory) : undefined;
  return new AppServerOperationError(
    400, "invalid_request", `${STAGES[stage]}${detail}${exitDetail}${stderrDetail ? ` ${stderrDetail}` : ""}`,
    `workspace_grant_${stage}`, false, undefined, metadata,
  );
}
