import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

export type ApiState<T> =
  | { status: "loading"; data: undefined; error: undefined; reload: () => void }
  | { status: "error"; data: undefined; error: unknown; reload: () => void }
  | { status: "ready"; data: T; error: undefined; reload: () => void };

export function useApi<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: DependencyList): ApiState<T> {
  const generation = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [result, setResult] = useState<Omit<ApiState<T>, "reload">>({ status: "loading", data: undefined, error: undefined });
  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    queueMicrotask(() => {
      if (generation.current === currentGeneration && !controller.signal.aborted) setResult({ status: "loading", data: undefined, error: undefined });
    });
    void fetcher(controller.signal).then(
      (data) => { if (generation.current === currentGeneration) setResult({ status: "ready", data, error: undefined }); },
      (error: unknown) => {
        if (generation.current === currentGeneration && !controller.signal.aborted) setResult({ status: "error", data: undefined, error });
      },
    );
    return () => { controller.abort(); };
    // The caller explicitly controls fetch invalidation with deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadToken]);

  return { ...result, reload } as ApiState<T>;
}
