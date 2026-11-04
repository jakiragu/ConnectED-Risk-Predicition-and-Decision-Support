import { useCallback, useEffect, useState } from 'react';
import { checkpointsFor, labelOf } from '@gradebook/domain/results';
import { effectiveScheme, labelsOf, openerDefault } from '@gradebook/domain/assessmentConfig';
import { repository } from './repository.js';

/**
 * How checkpoints look for one term: the school's names for them, and whether
 * the term holds an Opener. Works offline from the copies kept last time.
 *
 *   checkpoints  the checkpoints held this term, in order (['MIDTERM', 'ENDTERM'] without an Opener)
 *   label(c)     the school's name for a checkpoint
 *   scheme       the school's three checkpoints with names (for pickers)
 *   rule         the term's grading rule, or null
 *   ready        both have loaded (or failed)
 */
export function useCheckpointSetup(schoolId, termId) {
  const [config, setConfig] = useState(null);
  const [rule, setRule] = useState(null);
  const [loaded, setLoaded] = useState({ config: false, rule: false });
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    repository.loadAssessmentConfig(schoolId)
      .then((res) => active && setConfig(res?.data ?? null))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoaded((l) => ({ ...l, config: true })));
    return () => { active = false; };
  }, [schoolId]);

  const loadRule = useCallback(async () => {
    if (!termId) {
      setRule(null);
      setLoaded((l) => ({ ...l, rule: true }));
      return;
    }
    try {
      const res = await repository.loadGradeRule(schoolId, termId);
      setRule(res?.data ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoaded((l) => ({ ...l, rule: true }));
    }
  }, [schoolId, termId]);

  useEffect(() => {
    setLoaded((l) => ({ ...l, rule: false }));
    loadRule();
  }, [loadRule]);

  const labels = labelsOf(config);
  const openerEnabled = typeof rule?.opener_enabled === 'boolean' ? rule.opener_enabled : openerDefault(config);
  return {
    checkpoints: checkpointsFor(openerEnabled),
    openerEnabled,
    label: (c) => labelOf(c, labels),
    labels,
    scheme: effectiveScheme(config),
    rule,
    ready: loaded.config && loaded.rule,
    error,
    reload: loadRule,
  };
}
