import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewCommentDraft } from "@legioncode/client-ui";
import type { SubmissionOutcome } from "../../../hooks/chat/submissionAttemptRegistry";
import {
  buildReviewCommentPrompt,
  validateReviewPromptBudget,
} from "@legioncode/client-ui";

interface ReviewCommentSubmissionInput {
  comments: ReviewCommentDraft[];
  input: string;
  isLoading: boolean;
  error?: string | null;
  append: (message: { role: "user"; content: string }) => Promise<SubmissionOutcome>;
  handleInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  toggleSelected: (commentId: string, selected: boolean) => void;
  markDispatching: (commentIds: string[]) => void;
  markDispatched: (commentIds: string[]) => void;
  markDispatchFailed: (
    commentIds: string[],
    options: { reselect: boolean },
  ) => void;
}

export function useReviewCommentSubmission(
  input: ReviewCommentSubmissionInput,
) {
  const {
    comments,
    input: textInput,
    isLoading,
    error,
    append,
    handleInputChange,
    toggleSelected,
    markDispatching,
    markDispatched,
    markDispatchFailed,
  } = input;
  const [reviewCommentError, setReviewCommentError] = useState<string | null>(
    null,
  );
  const lastDispatchIdsRef = useRef<string[]>([]);
  const latestInputRef = useRef(textInput);
  useEffect(() => {
    latestInputRef.current = textInput;
  }, [textInput]);

  const changeInput = useCallback(
    (value: string) => {
      latestInputRef.current = value;
      if (reviewCommentError) setReviewCommentError(null);
      handleInputChange({
        target: { value },
      } as React.ChangeEvent<HTMLTextAreaElement>);
    },
    [handleInputChange, reviewCommentError],
  );

  const removeComment = useCallback(
    (commentId: string) => {
      toggleSelected(commentId, false);
      if (reviewCommentError) setReviewCommentError(null);
    },
    [reviewCommentError, toggleSelected],
  );

  const submitWithComments = useCallback(async (): Promise<boolean> => {
    const budget = validateReviewPromptBudget(comments, textInput);
    if (!budget.ok) {
      setReviewCommentError(budget.reason);
      return false;
    }
    const { prompt } = buildReviewCommentPrompt(comments, textInput);
    const ids = comments.map((comment) => comment.id);
    lastDispatchIdsRef.current = ids;
    setReviewCommentError(null);
    markDispatching(ids);
    const previousInput = textInput;
    changeInput("");
    try {
      const outcome = await append({ role: "user", content: prompt });
      if (
        outcome.status === "accepted" ||
        (outcome.status === "cancelled" && outcome.admission === "accepted")
      ) {
        markDispatched(ids);
        return true;
      }
      throw new Error(outcome.status === "unconfirmed"
        ? outcome.message
        : outcome.status === "cancelled"
          ? "The request may have been admitted. Check the saved conversation before retrying."
          : "The chat request belongs to a conversation that is no longer active.");
    } catch (error) {
      markDispatchFailed(ids, { reselect: true });
      lastDispatchIdsRef.current = [];
      if (latestInputRef.current === "") changeInput(previousInput);
      setReviewCommentError(
        error instanceof Error
          ? error.message
          : "Failed to send review comments.",
      );
      return false;
    }
  }, [
    append,
    changeInput,
    comments,
    markDispatchFailed,
    markDispatched,
    markDispatching,
    textInput,
  ]);

  useEffect(() => {
    if (!error || lastDispatchIdsRef.current.length === 0) return;
    markDispatchFailed(lastDispatchIdsRef.current, { reselect: false });
    lastDispatchIdsRef.current = [];
  }, [error, markDispatchFailed]);
  useEffect(() => {
    if (!isLoading && !error) lastDispatchIdsRef.current = [];
  }, [error, isLoading]);

  return { reviewCommentError, changeInput, removeComment, submitWithComments };
}
