
import { useEffect, useMemo, useRef, useState } from 'react';

const TERMS = [
  { value: 1, label: 'Term 1', mid: 'T1M', end: 'T1F' },
  { value: 2, label: 'Term 2', mid: 'T2M', end: 'T2F' },
  { value: 3, label: 'Term 3', mid: 'T3M', end: 'T3F' },
];

const COLORS = {
  mid: '#075566',
  end: '#08adbd',
  target: '#111111',
};

const normalise = (value) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const clamp = (value) => Math.max(0, Math.min(100, value));

function getSubjectTargets(option, subjects) {
  const targets = new Map();

  for (const change of option?.changes ?? []) {
    if (change.kind === 'attendance' || change.to == null) continue;

    const text = [
      change.column,
      change.label,
      change.group,
    ].filter(Boolean).join(' ');

    const checkpoint = text.match(/T[1-3][MF]/i)?.[0]?.toUpperCase();
    if (!checkpoint) continue;

    const subject = subjects.find((name) => {
      const candidate = normalise(name);
      return candidate && normalise(text).includes(candidate);
    });

    if (!subject) continue;

    targets.set(`${checkpoint}:${subject}`, Number(change.to));
  }

  return targets;
}

export default function SubjectPerformanceChart({
  performanceTrend,
  subjects,
  targetOption,
}) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [term, setTerm] = useState(3);

  const availableTerms = useMemo(
    () =>
      TERMS.filter(({ mid, end }) =>
        performanceTrend.some(
          (result) => result.point === mid || result.point === end
        )
      ),
    [performanceTrend]
  );

  useEffect(() => {
    if (!availableTerms.length) return;

    setTerm(availableTerms[availableTerms.length - 1].value);
  }, [availableTerms.map((item) => item.value).join(',')]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selectedTerm =
    TERMS.find((item) => item.value === term) ?? TERMS[0];

  const resultsByPoint = useMemo(
    () => new Map(performanceTrend.map((result) => [result.point, result])),
    [performanceTrend]
  );

  const targets = useMemo(
    () => getSubjectTargets(targetOption, subjects),
    [targetOption, subjects]
  );

  console.log(
    'TARGET CHANGE DETAILS:',
    JSON.stringify(targetOption?.changes, null, 2)
  );

  console.log(
    'TARGET OPTION:',
    JSON.stringify(targetOption, null, 2)
  );

  if (!availableTerms.length) {
    return <div className="hint">No published subject results yet.</div>;
  }

  const midResults = resultsByPoint.get(selectedTerm.mid);
  const endResults = resultsByPoint.get(selectedTerm.end);

  // Keep enough room for nine subject groups and their labels.
  const chartWidth = Math.max(width, subjects.length * 78, 720);
  const height = 300;

  const padding = {
    top: 22,
    right: 18,
    bottom: 125,
    left: 48,
  };

  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const groupWidth = plotWidth / Math.max(subjects.length, 1);
  const barWidth = Math.min(22, groupWidth * 0.27);
  const barGap = Math.min(5, groupWidth * 0.06);

  const y = (value) =>
    padding.top + plotHeight * (1 - clamp(value) / 100);

  const barHeight = (value) =>
    padding.top + plotHeight - y(value);

  const ticks = [0, 20, 40, 60, 80, 100];

  return (
    <div className="subject-performance-chart stack">
      <div className="row subject-chart-toolbar">
        <label htmlFor="subject-chart-term">Term</label>
        <select
          id="subject-chart-term"
          value={term}
          onChange={(event) => setTerm(Number(event.target.value))}
        >
          {availableTerms.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <div className="subject-chart-scroll" ref={containerRef}>
        {width > 0 && (
          <svg
            width={chartWidth}
            height={height}
            viewBox={`0 0 ${chartWidth} ${height}`}
            role="img"
            aria-label={`${selectedTerm.label} subject marks and model-generated targets`}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={padding.left}
                  x2={chartWidth - padding.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="currentColor"
                  opacity="0.16"
                />
                <text
                  x={padding.left - 9}
                  y={y(tick) + 4}
                  textAnchor="end"
                  fontSize="11"
                  fill="currentColor"
                >
                  {tick}
                </text>
              </g>
            ))}

            <line
              x1={padding.left}
              x2={padding.left}
              y1={padding.top}
              y2={padding.top + plotHeight}
              stroke="currentColor"
            />
            <line
              x1={padding.left}
              x2={chartWidth - padding.right}
              y1={padding.top + plotHeight}
              y2={padding.top + plotHeight}
              stroke="currentColor"
            />

            <text
              x="13"
              y={padding.top + plotHeight / 2}
              transform={`rotate(-90 13 ${padding.top + plotHeight / 2})`}
              textAnchor="middle"
              fontSize="11"
              fill="currentColor"
            >
              Marks
            </text>

            {subjects.map((subject, index) => {
              const center =
                padding.left + groupWidth * (index + 0.5);

              const midX = center - barWidth - barGap / 2;
              const endX = center + barGap / 2;

              const midScore =
                midResults?.subjects.find(
                  (item) => item.subject === subject
                )?.score ?? null;

              const endScore =
                endResults?.subjects.find(
                  (item) => item.subject === subject
                )?.score ?? null;

              const midTarget = targets.get(
                `${selectedTerm.mid}:${subject}`
              );

              const endTarget = targets.get(
                `${selectedTerm.end}:${subject}`
              );

              return (
                <g key={subject}>
                  {midScore != null && (
                    <rect
                      x={midX}
                      y={y(midScore)}
                      width={barWidth}
                      height={barHeight(midScore)}
                      fill={COLORS.mid}
                    >
                      <title>{subject} Mid-term: {midScore}</title>
                    </rect>
                  )}

                  {midTarget != null && (
                    <rect
                      x={midX}
                      y={y(midTarget)}
                      width={barWidth}
                      height={barHeight(midTarget)}
                      fill="none"
                      stroke={COLORS.target}
                      strokeWidth="2"
                    >
                      <title>{subject} Mid-term target: {midTarget}</title>
                    </rect>
                  )}

                  {endScore != null && (
                    <rect
                      x={endX}
                      y={y(endScore)}
                      width={barWidth}
                      height={barHeight(endScore)}
                      fill={COLORS.end}
                    >
                      <title>{subject} End-term: {endScore}</title>
                    </rect>
                  )}

                  {endTarget != null && (
                    <rect
                      x={endX}
                      y={y(endTarget)}
                      width={barWidth}
                      height={barHeight(endTarget)}
                      fill="none"
                      stroke={COLORS.target}
                      strokeWidth="2"
                    >
                      <title>{subject} End-term target: {endTarget}</title>
                    </rect>
                  )}

                  {/* Rotated labels give long subject names more room. */}
                  <text
                    transform={`translate(${center + 4},${padding.top + plotHeight + 13}) rotate(45)`}
                    textAnchor="start"
                    fontSize="11"
                    fill="currentColor"
                  >
                    {subject}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className="subject-chart-legend">
        <span><i className="legend-swatch mid" />Mid-term</span>
        <span><i className="legend-swatch end" />End-term</span>
        <span><i className="legend-swatch target" />Intervention target</span>
      </div>

      <div className="hint">
        Outlined bars represent model-generated targets. They are not
        actual marks.
      </div>
    </div>
  );
}
