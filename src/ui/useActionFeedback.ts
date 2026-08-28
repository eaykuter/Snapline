import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export type ActionFeedbackStatus = "idle" | "pending" | "success" | "error";

interface UseActionFeedbackOptions {
  resetAfter?: number;
  onError?: (error: unknown) => void;
}

interface UseActionFeedbackResult {
  status: ActionFeedbackStatus;
  pending: boolean;
  run: (action: () => unknown) => Promise<boolean>;
  reset: () => void;
}

export function useActionFeedback({
  resetAfter = 1800,
  onError
}: UseActionFeedbackOptions = {}): UseActionFeedbackResult {
  const [status, setStatus] = useState<ActionFeedbackStatus>("idle");
  const statusRef = useRef<ActionFeedbackStatus>("idle");
  const runId = useRef(0);
  const timer = useRef<number>();
  const alive = useRef(true);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;

  const clearTimer = useCallback((): void => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const scheduleReset = useCallback(
    (id: number): void => {
      clearTimer();
      timer.current = window.setTimeout(() => {
        if (!alive.current || id !== runId.current) {
          return;
        }
        statusRef.current = "idle";
        setStatus("idle");
      }, resetAfter);
    },
    [clearTimer, resetAfter]
  );

  const reset = useCallback((): void => {
    runId.current += 1;
    clearTimer();
    statusRef.current = "idle";
    if (alive.current) {
      setStatus("idle");
    }
  }, [clearTimer]);

  const run = useCallback(
    async (action: () => unknown): Promise<boolean> => {
      if (statusRef.current === "pending") {
        return false;
      }

      clearTimer();
      const id = ++runId.current;
      statusRef.current = "pending";
      if (alive.current) {
        setStatus("pending");
      }

      try {
        await action();
        if (!alive.current || id !== runId.current) {
          return false;
        }
        statusRef.current = "success";
        setStatus("success");
        scheduleReset(id);
        return true;
      } catch (error: unknown) {
        if (!alive.current || id !== runId.current) {
          return false;
        }
        errorHandler.current?.(error);
        statusRef.current = "error";
        setStatus("error");
        scheduleReset(id);
        return false;
      }
    },
    [clearTimer, scheduleReset]
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      runId.current += 1;
      clearTimer();
    };
  }, [clearTimer]);

  return {
    status,
    pending: status === "pending",
    run,
    reset
  };
}
