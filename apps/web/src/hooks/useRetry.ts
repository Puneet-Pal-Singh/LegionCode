import { useCallback, useEffect, useRef, useState } from "react";

interface UseRetryOptions {
  delayMs: number;
  maxAttempts?: number;
  scopeKey: string;
}

interface UseRetryReturn {
  signal: number;
  schedule: () => boolean;
  reset: () => void;
}

export function useRetry({
  delayMs,
  maxAttempts = 3,
  scopeKey,
}: UseRetryOptions): UseRetryReturn {
  const [signal, setSignal] = useState(0);
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    attemptsRef.current += 1;
    if (attemptsRef.current >= maxAttempts) {
      return false;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setSignal((current) => current + 1);
    }, delayMs);
    return true;
  }, [delayMs, maxAttempts]);

  const reset = useCallback(() => {
    attemptsRef.current = 0;
    clearTimer();
  }, [clearTimer]);

  useEffect(() => {
    reset();
  }, [scopeKey, reset]);

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  return { signal, schedule, reset };
}
