import { Info, InfluenceChart, Notice, RiskBar } from './ui.jsx';

/**
 * One student's estimate, explained for a teacher:
 *   how risky        the estimate against the model's threshold
 *   what moved it    each subject's and attendance's share of the SHAP explanation
 *   what would help  the smallest changes at the next checkpoint that would stop
 *                    the flag (DiCE), or comparable students' progress when no
 *                    such change exists within realistic limits
 * Model details (version, threshold, method, limits) are kept but folded away
 * under "About this estimate". Everything here describes the model's estimate;
 * none of it is a cause, and choosing an intervention is the teacher's decision.
 */

const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const value = (c, v) => (c.kind === 'attendance' ? `${v.toFixed(1)}%` : `${Math.round(v)}`);
const gain = (c) => (c.kind === 'attendance' ? `+${c.gain.toFixed(1)} points` : `+${Math.round(c.gain)}`);
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const METHOD = { 'dice-random': 'smallest changes that clear the next checkpoint (DiCE)', 'peer-progression': 'how comparable students progressed' };
const SOURCE = { data: 'from past students’ progress', static: 'standard limit', ceiling: 'attending every remaining school day' };

/** One sentence: which factors raised the estimate most, and which lowered it. */
export function summarise(factors) {
  const up = factors.filter((f) => f.direction === 'RAISES').slice(0, 2).map((f) => f.label);
  const down = factors.filter((f) => f.direction === 'LOWERS').slice(0, 1).map((f) => f.label);
  if (!up.length && !down.length) return null;
  return [up.length && `Mostly raised by ${and(up)}`, down.length && `${down[0]} lowered it`].filter(Boolean).join('; ') + '.';
}

/** Factors for the influence chart. */
export const influenceItems = (factors) => factors.map((f) => ({
  key: f.group,
  label: f.label,
  share: f.share,
  direction: f.direction,
  missing: f.all_missing,
  note: f.all_missing ? 'no results' : f.missing_columns ? `${f.missing_columns} missing` : null,
}));

/** The targets for the next checkpoint, as a short table. */
export function Targets({ targets: t }) {
  if (!t) return null;
  if (t.status === 'MAINTAIN') return <Notice tone="success">Keeping the current results and attendance should be enough for the {t.target_label}.</Notice>;
  if (t.status === 'NONE') return <div className="hint">No target: {t.reason}</div>;
  if (t.status === 'ERROR') return <div className="hint">Targets could not be worked out for this estimate.</div>;
  const [first, ...others] = t.options;
  if (!first) return <div className="hint">No target for these subjects.</div>;
  return (
    <div className="stack">
      <div className="row">
        <span>To stop being flagged at the <b>{t.target_label}</b>:</span>
        {t.status === 'FALLBACK' && (
          <span className="row">
            <span className="chip muted">From comparable students</span>
            <Info label="Why these targets">
              No change within realistic limits would clear the next checkpoint, so these follow how students with similar
              results improved. They may not be enough on their own.
            </Info>
          </span>
        )}
      </div>
      <div className="table-wrap">
        <table className="targets">
          <thead><tr><th>Result</th><th className="num">Now</th><th className="num">Target</th><th className="num">Change</th></tr></thead>
          <tbody>
            {first.changes.map((c) => (
              <tr key={c.column}>
                <td>{c.kind === 'attendance' ? 'Attendance' : c.group}</td>
                <td className="num">{value(c, c.from)}</td>
                <td className="num"><b>{value(c, c.to)}</b></td>
                <td className="num gain">{gain(c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {others.length > 0 && (
        <details className="more">
          <summary>{others.length} other way{others.length === 1 ? '' : 's'} to reach it</summary>
          <ul className="plain">
            {others.map((o, i) => (
              <li key={i} className="chips">
                {o.changes.map((c) => <span key={c.column} className="chip target">{c.kind === 'attendance' ? 'Attendance' : c.group} {gain(c)}</span>)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="hint">A target is what the model would need to see, not a guaranteed outcome. Which support to give is your decision.</div>
    </div>
  );
}

/** Model details, kept for anyone who wants them. */
function About({ explanation: e, targets: t }) {
  const p = e.prediction;
  return (
    <details className="more">
      <summary>About this estimate</summary>
      <ul className="plain hint">
        <li>Model {p.model_version} at {p.prediction_point}. Students are flagged at {pct(p.threshold)} or more; the average student starts at {pct(e.base_probability)}.</li>
        <li>The influences are SHAP values: each factor&apos;s share of the difference between this student and the average student.</li>
        {t && t.status !== 'ERROR' && (
          <>
            <li>
              Targets carry the current results forward to the {t.target_label} and look for the {METHOD[t.method] ?? 'smallest changes'},
              judged by {t.evaluation_kind === 'pass_mark_rule' ? `the ${t.pass_mark}% pass mark on the projected average` : `the ${t.target_label} model`}.
            </li>
            {t.caps.length > 0 && <li>Largest change allowed: {t.caps.map((c) => `${c.label.split(',')[0]} +${c.max_increase.toFixed(0)} (${SOURCE[c.source] ?? c.source})`).join('; ')}.</li>}
          </>
        )}
      </ul>
    </details>
  );
}

export default function RiskExplanation({ explanation: e, name, onClose }) {
  const p = e.prediction;
  const factors = e.factors || [];
  const missingLowered = factors.some((f) => f.missing_columns > 0 && f.direction === 'LOWERS');
  const summary = summarise(factors);

  return (
    <section className="card panel" aria-label={`Risk estimate for ${name}`}>
      <div className="panel-head">
        <h2>{name}</h2>
        <RiskBar probability={p.probability} threshold={p.threshold} atRisk={p.at_risk} />
        <span className={`pill ${p.at_risk ? 'risk' : 'good'}`}>{p.at_risk ? 'At risk' : 'Not flagged'}</span>
        {onClose && <button type="button" className="btn link" onClick={onClose}>Close</button>}
      </div>

      {missingLowered && (
        <Notice tone="warn">Some results are missing. The model reads a missing result as lower risk, so this estimate may be too low.</Notice>
      )}

      {e.explained ? (
        <div className="stack">
          <h3>What moved the estimate</h3>
          {summary && <div>{summary}</div>}
          <InfluenceChart items={influenceItems(factors)} />
          <details className="more">
            <summary>Results behind each factor</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Factor</th><th>Result</th><th className="num">Value</th><th>Effect</th></tr></thead>
                <tbody>
                  {factors.flatMap((f) => f.columns.map((c) => (
                    <tr key={c.name}>
                      <td>{f.label}</td>
                      <td>{c.label}</td>
                      <td className="num">{c.missing ? <span className="hint">missing</span> : c.value.toFixed(1)}</td>
                      <td>{c.effect > 0 ? <span className="risk">raised</span> : c.effect < 0 ? <span className="good">lowered</span> : <span className="hint">none</span>}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : (
        <div className="hint">This estimate was made before explanations were added. Run the predictions again to explain it.</div>
      )}

      {e.targets && (
        <div className="stack">
          <h3>Targets</h3>
          <Targets targets={e.targets} />
        </div>
      )}

      <About explanation={e} targets={e.targets} />
    </section>
  );
}
