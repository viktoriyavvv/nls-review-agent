import { useEffect, useState, DependencyList } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Run an async function on mount / when deps change; track loading + error. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    fn()
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((e) => !cancelled && setState({ data: null, error: String(e?.message ?? e), loading: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
