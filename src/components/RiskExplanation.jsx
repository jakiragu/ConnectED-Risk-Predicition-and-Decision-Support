import { useState } from 'react';
import { sentence } from '@gradebook/domain/explanations';
import { targetText } from '@gradebook/domain/targets';
import '../styles/explain.css';

const pct = (p) => `${(p * 100).toFixed(1)}%`;

/** One factor's push, drawn either side of a centre line: right raises the estimated risk, left lowers it. */
function Bar({ effect, max, missing }) {
  const width = max > 0 ? Math.min(Math.abs(effect) / max, 1) * 50 : 0;
  const side = effect >= 0 ? 'raises' : 'lowers';
  return (
    <div className="factor-bar" aria-hidden="true">
      <span className="axis" />
      <span className={`fill ${side}${missing ? ' missing' : ''}`} style={{ width: `${width}%` }} />
    </div>
  );
}

const SOURCE = { data: 'from training data', static: 'static limit', ceiling: 'attendance ceiling' };

/** What the targets are judged against, in words. */
function judgedBy(t) {
  return t.evaluation_kind === 'pass_mark_rule'
    ? `a projected ${t.target_label} average of at least ${t.pass_mark}% (missing subjects: ${t.missing_score_policy === 'ZERO' ? 'counted as 0' : 'left out'})`
    : `the ${t.target_label} model's threshold of ${pct(t.threshold)}`;
}

const projection = (t, o) => (t.evaluation_kind === 'pass_mark_rule'
  ? `projected ${t.target_label} average ${o.score == null ? '—' : `${o.score.toFixed(1)}%`}`
  : `the ${t.target_label} model's estimate would be ${pct(o.score)}`);

/**
 * Counterfactual targets for the next checkpoint: the student's current results
 * carried forward, and how much higher they would need to be there. DiCE
 * targets clear the next checkpoint's model (or, at T3M, the pass mark);
 * peer-progression targets are a fallback and may not.
 */
function Targets({ targets: t }) {
  if (t.status === 'ERROR') return <div className="notice">Targets could not be worked out for this prediction. {t.reason}</div>;
  if (t.status === 'NONE') return <div className="notice">No target. {t.reason}</div>;
  const baseline = t.evaluation_kind === 'pass_mark_rule'
    ? `a projected average of ${t.baseline_score == null ? '—' : `${t.baseline_score.toFixed(1)}%`}`
    : `an estimate of ${pct(t.baseline_score)}`;
  if (t.status === 'MAINTAIN') {
    return (
      <div className="notice">
        If this student keeps their current results and attendance, the {t.target_label} would give {baseline}, which clears
        {' '}{judgedBy(t)}. No raised target is needed; keeping up the current level is the target.
      </div>
    );
  }
  return (
    <div className="stack">
      <div>
        Targets for the <b>{t.target_label}</b>. Carrying this student's current results forward gives {baseline}; the targets
        are judged against {judgedBy(t)}. Results only go up, within the permitted changes below; subjects without results
        get no target.
      </div>
      {t.status === 'FALLBACK' && (
        <div className="notice">
          DiCE found no change within the permitted limits that clears it ({t.dice_reason}). These targets come from how
          comparable students progressed at this point instead, and may not be enough on their own.
        </div>
      )}
      <ol className="target-options">
        {t.options.map((o, i) => (
          <li key={i}>
            <span className="target-changes">
              {o.changes.map((c) => (
                <span key={c.column} className="chip target"
                  title={c.basis === 'peer' ? `Peers within ±${c.peer_window} marks (${c.peer_count} students) improved by ${c.peer_change?.toFixed(1)}`
                    : c.basis === 'cap' ? 'Peers did not improve here (or too few peers): the permitted maximum' : ''}>
                  {targetText(c)}
                </span>
              ))}
            </span>
            <span className="hint"> → {projection(t, o)}{o.at_risk ? ' (still at risk)' : ''}</span>
          </li>
        ))}
      </ol>
      <details>
        <summary>Permitted changes</summary>
        <ul>
          {t.caps.map((c) => (
            <li key={c.column} className="hint">{c.label}: up to +{c.max_increase.toFixed(1)} (at most {c.max_value.toFixed(1)}), {SOURCE[c.source] ?? c.source}</li>
          ))}
        </ul>
        {!t.stats_available && <div className="hint">This model package has no training statistics, so the static limits apply.</div>}
      </details>
      <div className="hint">
        The baseline is a hypothetical, not a prediction of the student's next results, and a target is what the model or the
        pass-mark rule would need to see, not a guaranteed outcome. Which intervention to use is the teacher's decision.
      </div>
    </div>
  );
}

/**
 * Why the model gave this student this probability: each subject's and
 * attendance's push (SHAP), largest first, with the individual inputs under
 * each; and, when the model flags the student, counterfactual targets for the
 * next checkpoint. The pushes explain the model's output; they are not causes,
 * and they do not say what will happen if something changes.
 *
 * @param {{explanation: object, name: string}} props   explanation from getRiskExplanation
 */
export default function RiskExplanation({ explanation, name }) {
  const [open, setOpen] = useState(null);
  const { prediction: p, factors } = explanation;
  if (!explanation.explained) {
    return (
      <div className="card stack">
        <h2>Why {name}: {p.prediction_point}</h2>
        <div className="notice">This prediction was made before explanations were added. Run the class's predictions again to explain it.</div>
      </div>
    );
  }
  const max = Math.max(...factors.map((f) => Math.abs(f.effect)), 0);
  const missingPush = factors.filter((f) => f.missing_columns > 0 && f.direction === 'LOWERS');

  return (
    <div className="card stack">
      <h2>Why {name}: {p.prediction_point}</h2>
      <div>
        The model starts from <b>{pct(explanation.base_probability)}</b> (its average) and, after this student's inputs,
        gives <b>{pct(p.probability)}</b>{p.at_risk ? `, at or above its threshold of ${pct(p.threshold)}` : `, below its threshold of ${pct(p.threshold)}`}.
        Bars to the right raised the estimate; bars to the left lowered it.
      </div>
      {missingPush.length > 0 && (
        <div className="notice">
          Missing results lowered this estimate ({missingPush.map((f) => f.group).join(', ')}). The model was trained without missing
          results, so a missing subject reads to it as a sign of lower risk. Treat this estimate with extra caution.
        </div>
      )}

      <div className="factor-list">
        {factors.map((f) => (
          <div key={f.group}>
            <div className="factor">
              <button type="button" className="btn link factor-name" onClick={() => setOpen(open === f.group ? null : f.group)}
                aria-expanded={open === f.group}>
                {f.label}{f.all_missing ? ' (missing)' : f.missing_columns ? ` (${f.missing_columns} missing)` : ''}
              </button>
              <Bar effect={f.effect} max={max} missing={f.all_missing} />
              <div className="factor-sentence">{sentence(f)}</div>
            </div>
            {open === f.group && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Input</th><th>Value</th><th>Push</th></tr></thead>
                  <tbody>
                    {f.columns.map((c) => (
                      <tr key={c.name}>
                        <td>{c.label}</td>
                        <td>{c.missing ? <span className="hint">missing</span> : c.value.toFixed(1)}</td>
                        <td>{c.effect > 0 ? 'raised' : c.effect < 0 ? 'lowered' : 'none'} ({c.effect.toFixed(3)})</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="hint">
        Explanations are SHAP values ({explanation.explainer}). They describe what moved this model's estimate for this student;
        they are not causes, and they do not predict the effect of an intervention.
      </div>

      {explanation.targets && (
        <>
          <h3>Targets</h3>
          <Targets targets={explanation.targets} />
        </>
      )}
    </div>
  );
}
