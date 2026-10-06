import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  validateAssessment,
  weightRemaining,
  ASSESSMENT_TYPES,
} from '@gradebook/domain/assessment';
import { gql } from '../api/graphql.js';
import { GET_ASSESSMENT, UPDATE_ASSESSMENT } from '../api/operations.js';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { ulid } from '@gradebook/domain/ids';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, Select } from '../components/Field.jsx';

const TERM_ID = import.meta.env.VITE_TERM_ID || 'term_2026_2';
const SUBJECTS = ['Kiswahili', 'CRE', 'Mathematics', 'English', 'Biology'];

const EMPTY = {
  title: '',
  subject: '',
  assessment_type: 'Mid-term',
  weight: '',
  max_score: 100,
  due_date: '',
};

export default function AssessmentForm() {
  const { actor } = useAuth();
  const navigate = useNavigate();
  const { assessmentId } = useParams();
  const [params] = useSearchParams();
  const isEdit = Boolean(assessmentId);

  const [classId, setClassId] = useState(params.get('class') || '');
  const { online } = useSync();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const siblings = useLive(
    () => (classId ? db().assessments.where('[class_id+term_id]').equals([classId, TERM_ID]).toArray() : []),
    [classId],
    []
  );
  const [form, setForm] = useState(EMPTY);
  const [version, setVersion] = useState(null);
  const [scoreCount, setScoreCount] = useState(0);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch((e) => setFailure(e.message));
  }, [actor.schoolId]);

  useEffect(() => {
    if (!classId) return;
    repository.loadAssessments(actor.schoolId, classId, TERM_ID).catch((e) => setFailure(e.message));
  }, [actor.schoolId, classId]);

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
        setVersion(a._version);
        setScoreCount(a.score_count || 0);
        setForm({
          title: a.title,
          subject: a.subject,
          assessment_type: a.assessment_type,
          weight: a.weight,
          max_score: a.max_score,
          due_date: a.due_date || '',
        });
      })
      .catch((e) => setFailure(e.message));
  }, [isEdit, assessmentId, actor.schoolId]);

  const remaining = useMemo(
    () => (form.subject ? weightRemaining(siblings, form.subject, assessmentId) : null),
    [siblings, form.subject, assessmentId]
  );

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

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
      term_id: TERM_ID,
      weight: Number(form.weight),
      max_score: Number(form.max_score),
      due_date: form.due_date || null,
    };

    const found = validateAssessment(candidate, {
      siblings: siblings.filter((s) => s.subject === candidate.subject),
    });
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
            term_id: TERM_ID,
            subject: candidate.subject,
            title: candidate.title,
            assessment_type: candidate.assessment_type,
            weight: candidate.weight,
            max_score: candidate.max_score,
            due_date: candidate.due_date,
          },
          actor);
      }
      navigate(`/assessments?class=${classId}`);
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
              options={SUBJECTS}
              placeholder="Choose subject"
              disabled={isEdit}
            />
          </Field>

          <Field label="Type" htmlFor="type" error={errors.assessment_type}>
            <Select
              id="type"
              value={form.assessment_type}
              onChange={set('assessment_type')}
              options={ASSESSMENT_TYPES}
            />
          </Field>

          <Field label="Name" htmlFor="title" error={errors.title}>
            <input
              id="title"
              value={form.title}
              placeholder="Term 2 Mid-term"
              onChange={(e) => set('title')(e.target.value)}
              aria-invalid={Boolean(errors.title)}
            />
          </Field>

          <Field
            label="Weight"
            htmlFor="weight"
            error={errors.weight}
            hint={
              remaining === null
                ? 'How much this assessment counts towards the term result'
                : `${remaining}% of the term weighting is still unassigned for ${form.subject}`
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

          <button className="btn" type="submit" disabled={saving || !classId}>
            {saving ? 'Saving' : isEdit ? 'Save changes' : 'Add assessment'}
          </button>
        </div>
      </form>
    </>
  );
}