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
import type { GitHubUser } from "../services/GitHubService";

interface AuthContextType {
  isAuthenticated: boolean;
  user: GitHubUser | null;
  isLoading: boolean;
  hasVerifiedSession: boolean;
  sessionCheckError: string | null;
  login: (reauthorize?: boolean) => void;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasVerifiedSession, setHasVerifiedSession] = useState(false);
  const [sessionCheckError, setSessionCheckError] = useState<string | null>(null);
  const checkSessionInFlightRef = useRef<{
    token: symbol;
    promise: Promise<void>;
  } | null>(null);
  const authGenerationRef = useRef(0);

  const checkSession = useCallback(async () => {
    if (checkSessionInFlightRef.current) {
      return checkSessionInFlightRef.current.promise;
    }
    const generation = authGenerationRef.current;
    const token = Symbol();
    const request = (async () => {
      try {
        const session = await GitHubService.getSession();
        if (generation !== authGenerationRef.current) return;
        setIsAuthenticated(session.authenticated);
        setUser(session.authenticated ? session.user : null);
        setSessionCheckError(null);
        setHasVerifiedSession(true);
      } catch (error) {
        if (generation !== authGenerationRef.current) return;
        console.error("Session check failed:", error);
        setSessionCheckError(
          error instanceof Error ? error.message : "Session check unavailable",
        );
      } finally {
        if (checkSessionInFlightRef.current?.token === token) {
          checkSessionInFlightRef.current = null;
          setIsLoading(false);
        }
      }
    })();
    checkSessionInFlightRef.current = { token, promise: request };
    return request;
  }, []);

  useEffect(() => {
    const result = GitHubService.handleOAuthCallback();
    if (result.success && import.meta.env.MODE === "development") {
      console.log("[auth] OAuth callback handled successfully");
    }

    void checkSession();
  }, [checkSession]);

  const login = useCallback((reauthorize = false) => {
    if (reauthorize) {
      GitHubService.initiateGitHubReauthorization();
      return;
    }
    GitHubService.initiateGitHubLogin();
  }, []);

  const logout = useCallback(async () => {
    try {
      await GitHubService.logout();
      authGenerationRef.current += 1;
      checkSessionInFlightRef.current = null;
      setIsAuthenticated(false);
      setUser(null);
      setHasVerifiedSession(true);
      setSessionCheckError(null);
      setIsLoading(false);
    } catch (error) {
      console.error("Logout failed:", error);
      throw error;
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
        hasVerifiedSession,
        sessionCheckError,
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
