import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  validateAssessment,
  weightRemaining,
  papersTaken,
  ASSESSMENT_TYPES,
  SUBJECTS,
  PAPERS,
} from '@gradebook/domain/assessment';
import { gql } from '../api/graphql.js';
import { GET_ASSESSMENT, UPDATE_ASSESSMENT } from '../api/operations.js';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { useTerms } from '../offline/useTerms.js';
import { ulid } from '@gradebook/domain/ids';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, Select } from '../components/Field.jsx';

const EMPTY = {
  title: '',
  subject: '',
  assessment_type: 'Opener',
  paper_no: '',
  weight: '',
  max_score: 100,
  due_date: '',
};

const suggestedTitle = (f) => (f.subject && f.paper_no ? `${f.subject} ${f.assessment_type} Paper ${f.paper_no}` : '');

export default function AssessmentForm() {
  const { actor } = useAuth();
  const navigate = useNavigate();
  const { assessmentId } = useParams();
  const [params] = useSearchParams();
  const isEdit = Boolean(assessmentId);
  const { terms, defaultTermId } = useTerms(actor.schoolId);

  const [classId, setClassId] = useState(params.get('class') || '');
  const [termId, setTermId] = useState(params.get('term') || '');
  const { online } = useSync();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const siblings = useLive(
    () => (classId && termId ? db().assessments.where('[class_id+term_id]').equals([classId, termId]).toArray() : []),
    [classId, termId],
    []
  );
  const [form, setForm] = useState(EMPTY);
  const [titleTouched, setTitleTouched] = useState(false);
  const [version, setVersion] = useState(null);
  const [scoreCount, setScoreCount] = useState(0);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!termId && defaultTermId && !isEdit) setTermId(defaultTermId);
  }, [termId, defaultTermId, isEdit]);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch((e) => setFailure(e.message));
  }, [actor.schoolId]);

  useEffect(() => {
    if (!classId || !termId) return;
    repository.loadAssessments(actor.schoolId, classId, termId).catch((e) => setFailure(e.message));
  }, [actor.schoolId, classId, termId]);

  useEffect(() => {
    if (!isEdit) return;
    gql(GET_ASSESSMENT, { school_id: actor.schoolId, assessment_id: assessmentId })
      .then((res) => {
        const a = res.getAssessment;
        if (!a) {
          setFailure('Assessment not found');
          return;
        }
        setClassId(a.class_id);
        setTermId(a.term_id);
        setVersion(a._version);
        setScoreCount(a.score_count || 0);
        setTitleTouched(true);
        setForm({
          title: a.title,
          subject: a.subject,
          assessment_type: a.assessment_type,
          paper_no: a.paper_no ?? '',
          weight: a.weight,
          max_score: a.max_score,
          due_date: a.due_date || '',
        });
      })
      .catch((e) => setFailure(e.message));
  }, [isEdit, assessmentId, actor.schoolId]);

  const remaining = useMemo(
    () => (form.subject ? weightRemaining(siblings, form.subject, form.assessment_type, assessmentId) : null),
    [siblings, form.subject, form.assessment_type, assessmentId]
  );
  const taken = useMemo(
    () => (form.subject ? papersTaken(siblings, form.subject, form.assessment_type, assessmentId) : []),
    [siblings, form.subject, form.assessment_type, assessmentId]
  );

  function set(key) {
    return (value) =>
      setForm((f) => {
        const next = { ...f, [key]: value };
        if (key === 'title') return next;
        return titleTouched ? next : { ...next, title: suggestedTitle(next) };
      });
  }

  async function submit(e) {
    e.preventDefault();
    setFailure(null);
    if (isEdit && !online) {
      setFailure('Editing an assessment needs a connection. New assessments can be added offline.');
      return;
    }
    const candidate = {
      ...form,
      assessment_id: assessmentId,
      class_id: classId,
      term_id: termId,
      paper_no: Number(form.paper_no),
      weight: Number(form.weight),
      max_score: Number(form.max_score),
      due_date: form.due_date || null,
    };

    const found = validateAssessment(candidate, { siblings });
    if (!termId) found.push({ field: 'term_id', message: 'Choose a term' });
    if (found.length) {
      setErrors(Object.fromEntries(found.map((f) => [f.field, f.message])));
      return;
    }
    setErrors({});
    setSaving(true);

    try {
      if (isEdit) {
        await gql(UPDATE_ASSESSMENT, {
          input: {
            assessment_id: assessmentId,
            school_id: actor.schoolId,
            title: candidate.title,
            assessment_type: candidate.assessment_type,
            paper_no: candidate.paper_no,
            weight: candidate.weight,
            max_score: candidate.max_score,
            due_date: candidate.due_date,
            _version: version,
          },
        });
      } else {
        await repository.createAssessment(
          {
            assessment_id: ulid(),
            school_id: actor.schoolId,
            class_id: classId,
            term_id: termId,
            subject: candidate.subject,
            title: candidate.title,
            assessment_type: candidate.assessment_type,
            paper_no: candidate.paper_no,
            weight: candidate.weight,
            max_score: candidate.max_score,
            due_date: candidate.due_date,
          },
          actor
        );
      }
      navigate(`/assessments?class=${classId}&term=${termId}`);
    } catch (err) {
      if (err.field) setErrors({ [err.field]: err.message });
      else setFailure(err.message);
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <button type="button" className="btn link" onClick={() => navigate(-1)}>Back</button>
      </div>

      <form className="card form-card" onSubmit={submit}>
        <div className="stack">
          <h2>{isEdit ? 'Edit this assessment.' : 'Fill out the following form to add an assessment.'}</h2>

          {failure && <div className="error">{failure}</div>}

          <Field label="Term" htmlFor="term" error={errors.term_id}>
            <Select
              id="term"
              value={termId}
              onChange={setTermId}
              options={terms.map((t) => ({ value: t.term_id, label: t.name }))}
              placeholder="Choose term"
              disabled={isEdit}
            />
          </Field>

          <Field label="Class" htmlFor="class">
            <Select
              id="class"
              value={classId}
              onChange={setClassId}
              options={classes.map((c) => ({ value: c.class_id, label: c.name }))}
              placeholder="Choose class"
              disabled={isEdit}
            />
          </Field>

          <Field label="Subject" htmlFor="subject" error={errors.subject}
            hint={isEdit ? 'Subject cannot be changed after creation' : undefined}>
            <Select
              id="subject"
              value={form.subject}
              onChange={set('subject')}
              options={isEdit && !SUBJECTS.includes(form.subject) ? [form.subject, ...SUBJECTS] : SUBJECTS}
              placeholder="Choose subject"
              disabled={isEdit}
            />
          </Field>

          <Field label="Checkpoint" htmlFor="type" error={errors.assessment_type}>
            <Select
              id="type"
              value={form.assessment_type}
              onChange={set('assessment_type')}
              options={ASSESSMENT_TYPES}
            />
          </Field>

          {form.subject && (
            <Field label="Paper" htmlFor="paper" error={errors.paper_no}
              hint={taken.length ? `Already added: paper ${taken.sort().join(', ')}` : undefined}>
              <Select
                id="paper"
                value={String(form.paper_no)}
                onChange={(v) => set('paper_no')(v ? Number(v) : '')}
                options={PAPERS.filter((p) => !taken.includes(p)).map((p) => ({ value: String(p), label: `Paper ${p}` }))}
                placeholder="Choose paper"
              />
            </Field>
          )}

          <Field label="Name" htmlFor="title" error={errors.title}>
            <input
              id="title"
              value={form.title}
              placeholder="English Opener Paper 1"
              onChange={(e) => {
                setTitleTouched(true);
                set('title')(e.target.value);
              }}
              aria-invalid={Boolean(errors.title)}
            />
          </Field>

          <Field
            label="Weight"
            htmlFor="weight"
            error={errors.weight}
            hint={
              remaining === null
                ? 'This paper\'s share of the subject\'s exam at this checkpoint'
                : `${remaining}% of the ${form.subject} ${form.assessment_type} exam is still unassigned. ` +
                  'Its papers must total 100%.'
            }
          >
            <input
              id="weight"
              type="number"
              min="1"
              max="100"
              value={form.weight}
              onChange={(e) => set('weight')(e.target.value)}
              aria-invalid={Boolean(errors.weight)}
            />
          </Field>

          <Field label="Marked out of" htmlFor="max" error={errors.max_score} hint={scoreCount > 0 ? 'Fixed once marks have been recorded' : undefined}>
            <input
              id="max"
              type="number"
              min="1"
              value={form.max_score}
              onChange={(e) => set('max_score')(e.target.value)}
              aria-invalid={Boolean(errors.max_score)}
              disabled={scoreCount > 0}
            />
          </Field>

          <Field label="Due date" htmlFor="due" error={errors.due_date}>
            <input
              id="due"
              type="date"
              value={form.due_date}
              onChange={(e) => set('due_date')(e.target.value)}
            />
          </Field>

          <button className="btn" type="submit" disabled={saving || !classId || !termId}>
            {saving ? 'Saving' : isEdit ? 'Save changes' : 'Add assessment'}
          </button>
        </div>
      </form>
    </>
  );
}