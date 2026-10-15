import { useState } from 'react';
import { sentence } from '@gradebook/domain/explanations';
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

/**
 * Why the model gave this student this probability: each subject's and
 * attendance's push (SHAP), largest first, with the individual inputs under
 * each. The pushes explain the model's output; they are not causes, and they
 * do not say what will happen if something changes.
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
    </div>
  );
}