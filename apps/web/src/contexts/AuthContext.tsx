/**
 * GitHub Authentication Context
 *
 * Manages authentication state and provides GitHub session information
 * throughout the React application.
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import * as GitHubService from "../services/GitHubService";
import type { GitCommitIdentityState } from "@repo/shared-types";

interface GitHubUser {
  id: string;
  login: string;
  avatar: string;
  email: string | null;
  name: string | null;
  commitIdentity?: GitCommitIdentityState;
}

interface AuthContextType {
  isAuthenticated: boolean;
  user: GitHubUser | null;
  isLoading: boolean;
  login: () => void;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const checkSessionInFlightRef = useRef(false);

  const checkSession = useCallback(async () => {
    if (checkSessionInFlightRef.current) {
      return;
    }
    checkSessionInFlightRef.current = true;
    try {
      setIsLoading(true);
      const session = await GitHubService.getSession();

      setIsAuthenticated(session.authenticated);
      setUser(session.user || null);
    } catch (error) {
      console.error("Session check failed:", error);
      setIsAuthenticated(false);
      setUser(null);
    } finally {
      checkSessionInFlightRef.current = false;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const result = GitHubService.handleOAuthCallback();
    if (result.success && import.meta.env.MODE === "development") {
      console.log("[auth] OAuth callback handled successfully");
    }

    void checkSession();
  }, [checkSession]);

  const login = useCallback(() => {
    GitHubService.initiateGitHubLogin();
  }, []);

  const logout = useCallback(async () => {
    try {
      await GitHubService.logout();
      setIsAuthenticated(false);
      setUser(null);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  }, []);

  const refreshSession = useCallback(async () => {
    await checkSession();
  }, [checkSession]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        user,
        isLoading,
        login,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
