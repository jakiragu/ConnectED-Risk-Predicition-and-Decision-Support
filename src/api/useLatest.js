import { useRef } from 'react';

/**
 * Numbers the requests a page starts so only the newest may update it. When the
 * class, term or checkpoint changes (or React mounts the page twice in
 * development) an earlier request can finish last; without this its data, or
 * its error, would overwrite the answer the page is now showing.
 */
export function useLatest() {
  const seq = useRef(0);
  const api = useRef(null);
  api.current ??= {
    start: () => ++seq.current,
    isLatest: (n) => n === seq.current,
  };
  return api.current;
}
