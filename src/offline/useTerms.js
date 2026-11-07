import { useEffect } from 'react';
import { currentTerm } from '@gradebook/domain/calendar';
import { db } from './db.js';
import { repository } from './repository.js';
import { useLive } from './useLive.js';

export function useTerms(schoolId) {
  const terms = useLive(() => db().terms.toArray(), [], []);

  useEffect(() => {
    repository.loadTerms(schoolId).catch(() => {});
  }, [schoolId]);

  const sorted = [...terms].sort(
    (a, b) => String(a.start_date).localeCompare(String(b.start_date))
  );

  const selectedTerm = currentTerm(sorted);

  return {
    terms: sorted,
    defaultTermId: selectedTerm?.term_id || '',
  };
}