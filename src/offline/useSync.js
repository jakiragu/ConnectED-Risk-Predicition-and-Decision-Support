import { useEffect, useState } from 'react';
import { getState, onSyncChange } from './syncEngine.js';

export function useSync() {
  const [state, setState] = useState({ online: true, pending: 0, failed: 0, held: 0 });
  useEffect(() => {
    getState().then(setState).catch(() => {});
    return onSyncChange(setState);
  }, []);
  return state;
}