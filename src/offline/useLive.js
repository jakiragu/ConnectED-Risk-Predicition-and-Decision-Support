import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';

/** Re-renders whenever the IndexedDB rows the query reads change. */
export function useLive(query, deps, initial) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (e) => console.warn('local query failed', e),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}