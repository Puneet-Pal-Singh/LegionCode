/**
 * GitHub Context Hook
 *
 * Manages GitHub repository and branch context throughout the application.
 * For session-scoped context, use SessionStateService directly.
 *
 * NOTE: This hook maintains global context for backward compatibility.
 * Session-scoped context is now stored separately via SessionStateService.
 * See App.tsx for per-session GitHub context management.
 *
 * Follows SOLID principles: Single Responsibility, Dependency Inversion.
 * Business logic extracted from components.
 *
 * @module hooks/useGitHubContext
 */

import { useState, useCallback } from "react";
import type { Repository } from "../services/GitHubService";

/**
 * GitHub context data structure
 */
export interface GitHubContextData {
  repo: Repository | null;
  branch: string;
  owner: string;
}

/**
 * Hook return type
 */
interface UseGitHubContextReturn {
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
 * Hook for managing GitHub repository context
 *
 * @example
 * ```tsx
 * const { repo, branch, switchBranch } = useGitHubContext();
 * ```
 */
export function useGitHubContext(): UseGitHubContextReturn {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [branch, setBranch] = useState<string>("");

  /**
   * Set full context (repo + branch)
   */
  const setContext = useCallback((newRepo: Repository, newBranch: string) => {
    setRepo(newRepo);
    setBranch(newBranch);
  }, []);

  /**
   * Switch to a different branch
   */
  const switchBranch = useCallback((newBranch: string) => {
    setBranch(newBranch);
  }, []);

  /**
   * Clear the context
   */
  const clearContext = useCallback(() => {
    setRepo(null);
    setBranch("");
  }, []);

  return {
    repo,
    branch,
    owner: repo?.owner.login || "",
    isLoaded: true,
    setContext,
    switchBranch,
    clearContext,
  };
}
