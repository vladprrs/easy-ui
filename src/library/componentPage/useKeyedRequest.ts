import { useCallback, useEffect, useRef, useState } from "react";

export type KeyedRequestState<T> =
  | { status: "idle"; key: null; reload: () => void }
  | { status: "loading"; key: string; reload: () => void }
  | { status: "error"; key: string; error: unknown; reload: () => void }
  | { status: "ready"; key: string; data: T; reload: () => void };

type StoredState<T> =
  | { status: "loading"; key: string }
  | { status: "error"; key: string; error: unknown }
  | { status: "ready"; key: string; data: T };

export function useKeyedRequest<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>): KeyedRequestState<T> {
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);
  const generation = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [stored, setStored] = useState<StoredState<T> | null>(null);
  const reload = useCallback(() => {
    if (key !== null) setStored({ status: "loading", key });
    setReloadToken((value) => value + 1);
  }, [key]);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    const current = ++generation.current;
    void fetcherRef.current(controller.signal).then(
      (data) => { if (!controller.signal.aborted && generation.current === current) setStored({ status: "ready", key, data }); },
      (error: unknown) => { if (!controller.signal.aborted && generation.current === current) setStored({ status: "error", key, error }); },
    );
    return () => controller.abort();
  }, [key, reloadToken]);

  if (key === null) return { status: "idle", key: null, reload };
  // This render-time key guard is intentional: effects have not run on the first
  // render after navigation, so data for the previous version must be masked now.
  if (stored === null || stored.key !== key) return { status: "loading", key, reload };
  return { ...stored, reload } as KeyedRequestState<T>;
}
