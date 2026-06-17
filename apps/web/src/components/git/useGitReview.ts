import { useContext } from "react";
import {
  GitReviewContext,
  type GitReviewContextValue,
} from "./GitReviewContextValue";

export function useGitReview(): GitReviewContextValue {
  const context = useContext(GitReviewContext);

  if (!context) {
    throw new Error("useGitReview must be used within a GitReviewProvider");
  }

  return context;
}
