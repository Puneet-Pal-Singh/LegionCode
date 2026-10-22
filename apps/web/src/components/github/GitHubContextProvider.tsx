/**
 * GitHub Context Provider
 *
 * Provides GitHub repository context to the entire application using React Context.
 * Wraps the useGitHubContext hook to provide state via Context API.
 * Follows SOLID: Dependency Inversion, Single Responsibility.
 *
 * @module components/github/GitHubContextProvider
 */

import { createContext, useContext, ReactNode } from "react";
import { useGitHubContext } from "../../hooks/useGitHubContext";
import type { Repository } from "../../services/GitHubService";

/**
 * Context value type
 */
interface GitHubContextValue {
  /** Current repository data */
  repo: Repository | null;
  /** Current branch name */
  branch: string;
  /** Repository owner login */
  owner: string;
  /** Whether in-memory context setup has completed */
  isLoaded: boolean;
  /** Set the full context (repo + branch) */
  setContext: (repo: Repository, branch: string) => void;
  /** Switch to a different branch */
  switchBranch: (branch: string) => void;
  /** Clear the context */
  clearContext: () => void;
}

/**
 * Context with default undefined value
 */
const GitHubContext = createContext<GitHubContextValue | undefined>(undefined);

/**
 * Props for the provider component
 */
interface GitHubContextProviderProps {
  children: ReactNode;
}

/**
 * GitHub Context Provider Component
 *
 * Wraps children with GitHub context, making repository and branch
 * data available throughout the component tree.
 *
 * @example
 * ```tsx
 * <GitHubContextProvider>
 *   <App />
 * </GitHubContextProvider>
 * ```
 */
export function GitHubContextProvider({
  children,
}: GitHubContextProviderProps) {
  const context = useGitHubContext();

  return (
    <GitHubContext.Provider value={context}>{children}</GitHubContext.Provider>
  );
}

/**
 * Hook to consume GitHub context
 *
 * Must be used within a GitHubContextProvider.
 *
 * @example
 * ```tsx
 * const { repo, branch, switchBranch } = useGitHub();
 * ```
 * @throws Error if used outside of GitHubContextProvider
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useGitHub(): GitHubContextValue {
  const context = useContext(GitHubContext);

  if (context === undefined) {
    throw new Error("useGitHub must be used within a GitHubContextProvider");
  }

  return context;
}

export type { GitHubContextValue, GitHubContextProviderProps };
