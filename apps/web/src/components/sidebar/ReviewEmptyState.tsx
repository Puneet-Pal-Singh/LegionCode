import { LoaderCircle } from "lucide-react";

export function ReviewLoadingState({
  className,
  isGitWorkspaceRecovering,
}: {
  className: string;
  isGitWorkspaceRecovering: boolean;
}) {
  return (
    <div
      className={`flex h-full items-center justify-center bg-transparent ${className}`}
    >
      {isGitWorkspaceRecovering ? (
        <div className="p-4 text-sm text-zinc-400">
          Recovering workspace after restart...
        </div>
      ) : (
        <LoaderCircle className="animate-spin text-zinc-400" size={24} />
      )}
    </div>
  );
}

export function ReviewErrorState({
  className,
  message,
}: {
  className: string;
  message: string;
}) {
  return (
    <div className={`bg-transparent p-4 text-sm text-red-400 ${className}`}>
      Error: {message}
    </div>
  );
}

export function GitUnavailableState({
  className,
  isGitWorkspaceRecovering,
}: {
  className: string;
  isGitWorkspaceRecovering: boolean;
}) {
  return (
    <div className={`bg-transparent p-4 text-sm text-zinc-400 ${className}`}>
      {isGitWorkspaceRecovering
        ? "Recovering workspace after restart..."
        : "Git is not available for this workspace yet. Connect or initialize a repository to use source control actions."}
    </div>
  );
}

export function ReviewDiffPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
      {message}
    </div>
  );
}
