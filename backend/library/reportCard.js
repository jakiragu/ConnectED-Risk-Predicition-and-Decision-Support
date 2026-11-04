import { CHECKPOINT_LABEL, CHECKPOINTS, RESULT_KIND } from './results.js';
import { componentLabel } from './assessment.js';

export const REPORT_KIND = { OFFICIAL: 'OFFICIAL', PROVISIONAL: 'PROVISIONAL' };
export const reportKindOf = (resultKind) =>
  resultKind === RESULT_KIND.FINAL ? REPORT_KIND.OFFICIAL : REPORT_KIND.PROVISIONAL;

const fmt = (n) => (n === null || n === undefined ? '-' : n.toFixed(2));
const col = (s, w) => String(s ?? '').slice(0, w).padEnd(w);
const num = (s, w) => String(s ?? '').padStart(w);

const MARK_TEXT = { ABSENT: 'ABS', NOT_ASSESSED: 'N/A', MISSING: '-' };
const markText = (p) => (p.mark_status === 'SCORED' ? `${p.raw_score}/${p.max_score}` : MARK_TEXT[p.mark_status] || '-');

/** "Paper 1", "CAT 2"; older rows without a kind are papers. */
const componentName = (p) => `${componentLabel(p)} ${p.paper_no ?? '-'}`;

export function reportCardLines(model) {
  const official = model.kind === RESULT_KIND.FINAL;
  const labels = model.labels || CHECKPOINT_LABEL;
  const held = model.held || CHECKPOINTS;
  const label = model.label || labels[model.checkpoint] || CHECKPOINT_LABEL[model.checkpoint];
  const lines = [
    { text: model.school_name, bold: true },
    { text: official ? 'END OF TERM REPORT CARD' : `PROVISIONAL ${label.toUpperCase()} REPORT`, bold: true },
    `${model.term_name}  |  ${model.class_name}`,
    `Student: ${model.student_name}   Adm. no: ${model.admission_no ?? '-'}`,
    `Published: ${model.published_at ? model.published_at.slice(0, 10) : '-'}   Result ref: ${model.calculation_id}`,
    '',
  ];
  if (!official) {
    lines.push(
      { text: 'PROVISIONAL: CHECKPOINT EXAM RESULTS. NOT THE TERM RESULT. NO GRADE IS AWARDED.', bold: true },
      'Each checkpoint is its own exam: a subject\'s papers and other components in that checkpoint make up 100%.',
      ''
    );
  } else {
    const w = model.checkpoint_weights || {};
    lines.push(
      `Term result = ${held.map((c) => `${labels[c]} ${w[c] ?? '-'}%`).join(' + ')}`,
      ''
    );
  }

  for (const s of model.subjects) {
    lines.push({ text: s.subject.toUpperCase(), bold: true });
    lines.push(`  ${col('Component', 30)}${num('Mark', 10)}${num('Weight', 8)}${num('Contrib.', 10)}`);
    for (const c of s.checkpoints) {
      for (const p of c.papers) {
        lines.push(
          `  ${col(`${c.label} ${componentName(p)}`, 30)}${num(markText(p), 10)}` +
            `${num(`${p.weight}%`, 8)}${num(fmt(p.contribution), 10)}`
        );
      }
      lines.push(`  ${col(`${c.label} total`, 30)}${num(`${fmt(c.score)}%`, 28)}`);
    }
    if (official) {
      lines.push({ text: `  ${col('Term score', 30)}${num(fmt(s.term_score), 28)}   Grade: ${s.grade ?? '-'}`, bold: true });
    }
    lines.push('');
  }

  if (official) {
    lines.push({ text: `Term average: ${fmt(model.term_average)}   Overall grade: ${model.term_grade ?? '-'}`, bold: true });
  } else {
    lines.push({ text: `${label} average: ${fmt(model.checkpoint_average)}%`, bold: true });
  }
  lines.push('', 'ABS = absent (scores 0)   N/A = not assessed (left out)   - = no mark recorded');
  return lines;
}
