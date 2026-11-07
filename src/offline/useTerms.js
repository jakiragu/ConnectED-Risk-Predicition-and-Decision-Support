import { useEffect } from 'react';
import { db } from './db.js';
import { repository } from './repository.js';
import { useLive } from './useLive.js';

export function useTerms(schoolId) {
  const terms = useLive(() => db().terms.toArray(), [], []);
  useEffect(() => {
    repository.loadTerms(schoolId).catch(() => {});
  }, [schoolId]);
  const sorted = [...terms].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  const current = sorted.find((t) => t.status === 'CURRENT') || sorted[sorted.length - 1] || null;
  return { terms: sorted, defaultTermId: current?.term_id || '' };
}