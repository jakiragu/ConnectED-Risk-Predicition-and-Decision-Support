import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CHECKPOINTS, CHECKPOINT_LABEL } from '@gradebook/domain/results';
import { gql } from '../api/graphql.js';
import { LIST_REPORT_CARDS, LIST_RESULT_SETS, REQUEST_REPORT_CARD_DOWNLOAD } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { useTerms } from '../offline/useTerms.js';

/** Starts a browser download from a short-lived link; the server sets the file name. */
function save(url, fileName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export default function ReportCards() {
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const [params, setParams] = useSearchParams();
  const { terms, defaultTermId } = useTerms(actor.schoolId);
  const classes = useLive(() => db().classes.toArray(), [], []);

  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher).sort((a, b) => a.name.localeCompare(b.name)),
    [classes, isAdmin]
  );
  const termId = params.get('term') || defaultTermId;
  const checkpoint = CHECKPOINTS.includes(params.get('cp')) ? params.get('cp') : 'ENDTERM';
  const classId = params.get('class') || mine[0]?.class_id || '';
  const go = (next) => setParams(Object.fromEntries(Object.entries({ term: termId, cp: checkpoint, class: classId, ...next }).filter(([, v]) => v)));

  const [cards, setCards] = useState([]);
  const [set, setSet] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch(() => {});
  }, [actor.schoolId]);

  const load = useCallback(async () => {
    if (!classId || !termId) return;
    const scope = { school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint };
    const [{ listReportCards }, { listResultSets }] = await Promise.all([
      gql(LIST_REPORT_CARDS, scope),
      gql(LIST_RESULT_SETS, { school_id: actor.schoolId, class_id: classId, term_id: termId }),
    ]);
    setCards(listReportCards);
    setSet(listResultSets.find((s) => s.checkpoint === checkpoint) || null);
  }, [actor.schoolId, classId, termId, checkpoint]);

  useEffect(() => {
    setError(null);
    setCards([]);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  async function download(card) {
    const { requestReportCardDownload: link } = await gql(REQUEST_REPORT_CARD_DOWNLOAD, {
      input: { school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint, student_id: card.student_id },
    });
    save(link.url, link.file_name);
  }

  async function one(card) {
    setBusy(card.student_id);
    setError(null);
    try {
      await download(card);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function all() {
    const ready = cards.filter((c) => c.available);
    if (!window.confirm(`Download ${ready.length} report cards? Your browser may ask to allow several downloads.`)) return;
    setBusy('all');
    setError(null);
    try {
      for (const c of ready) {
        await download(c);
        await pause(400); // browsers drop downloads started too close together
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!online) return <div className="notice">Downloading report cards needs a connection.</div>;
  if (!isAdmin && mine.length === 0) {
    return <div className="notice">Report cards are available to administrators and class teachers.</div>;
  }

  const ready = cards.filter((c) => c.available).length;
  const className = mine.find((c) => c.class_id === classId)?.name || '';

  return (
    <>
      <div className="page-head">
        <h1>Report cards</h1>
        <Select aria-label="Term" value={termId} onChange={(v) => go({ term: v })}
          options={terms.map((t) => ({ value: t.term_id, label: t.name }))} placeholder="Choose a term" style={{ width: 170 }} />
        <Select aria-label="Checkpoint" value={checkpoint} onChange={(v) => go({ cp: v })}
          options={CHECKPOINTS.map((c) => ({ value: c, label: CHECKPOINT_LABEL[c] }))} style={{ width: 160 }} />
        <Select aria-label="Class" value={classId} onChange={(v) => go({ class: v })}
          options={mine.map((c) => ({ value: c.class_id, label: c.name }))} style={{ width: 190 }} disabled={!isAdmin && mine.length === 1} />
      </div>

      {error && <div className="card error-card">{error}</div>}

      <div className="budget-row">
        {set && <StatusPill status={set.status} />}
        {set?.status === 'PUBLISHED'
          ? <span>{ready} of {cards.length} report cards ready{checkpoint === 'ENDTERM' ? ' (official)' : ' (provisional)'}</span>
          : <span>{CHECKPOINT_LABEL[checkpoint]} results for {className} are not published, so there are no report cards yet.</span>}
        {ready > 0 && (
          <button type="button" className="btn" disabled={busy !== null} onClick={all}>
            {busy === 'all' ? 'Downloading' : `Download all (${ready})`}
          </button>
        )}
      </div>

      {cards.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Adm no</th><th>Student</th><th>Card</th><th>Action</th></tr></thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.student_id}>
                  <td>{c.admission_no}</td>
                  <td>{c.first_name} {c.last_name}{c.student_status !== 'ACTIVE' && <span className="hint"> (deactivated)</span>}</td>
                  <td>{c.available ? (c.kind === 'OFFICIAL' ? 'Official' : 'Provisional') : <span className="hint">Being produced</span>}</td>
                  <td className="actions">
                    <button type="button" className="btn link" disabled={!c.available || busy !== null} onClick={() => one(c)}>
                      {busy === c.student_id ? 'Preparing' : 'Download'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}