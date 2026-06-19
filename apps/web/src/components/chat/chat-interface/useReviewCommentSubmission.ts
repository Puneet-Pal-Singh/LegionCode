import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewCommentDraft } from "../../git/reviewComments";
import {
  buildReviewCommentPrompt,
  validateReviewPromptBudget,
} from "../../git/reviewComments";

interface ReviewCommentSubmissionInput {
  comments: ReviewCommentDraft[];
  input: string;
  isLoading: boolean;
  error?: string | null;
  append: (message: { role: "user"; content: string }) => Promise<void>;
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
  const [reviewCommentError, setReviewCommentError] = useState<string | null>(
    null,
  );
  const lastDispatchIdsRef = useRef<string[]>([]);
  const latestInputRef = useRef(input.input);
  useEffect(() => {
    latestInputRef.current = input.input;
  }, [input.input]);

  const changeInput = useCallback(
    (value: string) => {
      latestInputRef.current = value;
      if (reviewCommentError) setReviewCommentError(null);
      input.handleInputChange({
        target: { value },
      } as React.ChangeEvent<HTMLTextAreaElement>);
    },
    [input.handleInputChange, reviewCommentError],
  );

  const removeComment = useCallback(
    (commentId: string) => {
      input.toggleSelected(commentId, false);
      if (reviewCommentError) setReviewCommentError(null);
    },
    [input.toggleSelected, reviewCommentError],
  );

  const submitWithComments = useCallback(async (): Promise<boolean> => {
    const budget = validateReviewPromptBudget(input.comments, input.input);
    if (!budget.ok) {
      setReviewCommentError(budget.reason);
      return false;
    }
    const { prompt } = buildReviewCommentPrompt(input.comments, input.input);
    const ids = input.comments.map((comment) => comment.id);
    lastDispatchIdsRef.current = ids;
    setReviewCommentError(null);
    input.markDispatching(ids);
    const previousInput = input.input;
    changeInput("");
    try {
      await input.append({ role: "user", content: prompt });
      input.markDispatched(ids);
      return true;
    } catch (error) {
      input.markDispatchFailed(ids, { reselect: true });
      lastDispatchIdsRef.current = [];
      if (latestInputRef.current === "") changeInput(previousInput);
      setReviewCommentError(
        error instanceof Error
          ? error.message
          : "Failed to send review comments.",
      );
      return false;
    }
  }, [changeInput, input]);

  useEffect(() => {
    if (!input.error || lastDispatchIdsRef.current.length === 0) return;
    input.markDispatchFailed(lastDispatchIdsRef.current, { reselect: false });
    lastDispatchIdsRef.current = [];
  }, [input.error, input.markDispatchFailed]);
  useEffect(() => {
    if (!input.isLoading && !input.error) lastDispatchIdsRef.current = [];
  }, [input.error, input.isLoading]);

  return { reviewCommentError, changeInput, removeComment, submitWithComments };
}
