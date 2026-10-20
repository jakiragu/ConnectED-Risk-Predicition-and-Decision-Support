import { useEffect, useRef, useState } from 'react';

/**
 * A line chart for values across the school year's checkpoints (percentages and
 * marks, so a fixed 0-100 scale lets charts side by side compare).
 *
 * It is drawn at the width of its container, measured, rather than stretched
 * from a fixed canvas: stretching scaled the text with the card, so labels were
 * huge in a wide card and unreadable in a narrow one. Each line is labelled at
 * its end instead of in a separate legend, the y-axis says what is measured,
 * and every point can be focused (or hovered) for its exact value.
 *
 * @param {{
 *   labels: string[],
 *   series: { name: string, values: (number|null)[], emphasis?: boolean, detail?: (string|null)[] }[],
 *   yLabel?: string, line?: { value: number, label: string }, format?: (v:number)=>string,
 *   title: string, height?: number, valueLabels?: boolean, yMax?: number,
 * }} props  valueLabels writes the value above each point of the emphasised series;
 *           yMax shortens the scale when values are small (school rates of a few percent)
 */
const COLORS = ['#0a4c55', '#14b4c8', '#7a5c9e', '#c28a12', '#3d6fb6', '#5f7d2b', '#a0466d', '#4f5b66'];
const PAD = { t: 16, b: 30, l: 44 };

export default function LineChart({ labels, series, yLabel, line, format = (v) => `${Math.round(v)}`, title, height = 240, valueLabels = false, yMax = 100 }) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState(null);

  useEffect(() => {
    if (!box.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const shown = series.filter((s) => s.values.some((v) => v != null));
  const longest = Math.max(0, ...shown.map((s) => s.name.length));
  const right = Math.min(160, 16 + longest * 7);        // room for the end labels
  const plotW = Math.max(width - PAD.l - right, 60);
  const plotH = height - PAD.t - PAD.b;
  const x = (i) => PAD.l + (labels.length < 2 ? plotW / 2 : (i * plotW) / (labels.length - 1));
  const y = (v) => PAD.t + (1 - Math.max(0, Math.min(yMax, v)) / yMax) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * yMax * 10) / 10);

  // End labels: at each line's last value, nudged apart so they never overlap.
  const ends = shown.map((s, k) => {
    const last = s.values.reduce((acc, v, i) => (v != null ? i : acc), -1);
    return { k, s, i: last, y: y(s.values[last]) };
  }).sort((a, b) => a.y - b.y);
  for (let j = 1; j < ends.length; j += 1) if (ends[j].y - ends[j - 1].y < 14) ends[j].y = ends[j - 1].y + 14;

  const color = (k, s) => (s.emphasis ? 'var(--ink-strong)' : COLORS[(k + 1) % COLORS.length]);

  return (
    <figure className="linechart" ref={box}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={title}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(v)} y2={y(v)} className="grid" />
              <text x={PAD.l - 8} y={y(v) + 4} className="tick" textAnchor="end">{v}</text>
            </g>
          ))}
          {yLabel && <text className="axis-label" transform={`translate(12 ${PAD.t + plotH / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>}
          {labels.map((l, i) => <text key={l} x={x(i)} y={height - 8} className="tick" textAnchor="middle">{l}</text>)}
          {line && (
            <g>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(line.value)} y2={y(line.value)} className="threshold" />
              <text x={PAD.l + 4} y={y(line.value) - 5} className="threshold-label">{line.label}</text>
            </g>
          )}
          {shown.map((s, k) => {
            const c = color(k, s);
            const segments = [];
            let run = [];
            s.values.forEach((v, i) => { if (v == null) { if (run.length) segments.push(run); run = []; } else run.push([x(i), y(v)]); });
            if (run.length) segments.push(run);
            return (
              <g key={s.name} className={s.emphasis ? 'emphasis' : 'muted'}>
                {segments.map((seg, j) => (
                  <polyline key={j} points={seg.map((p) => p.join(',')).join(' ')} fill="none" stroke={c} strokeWidth={s.emphasis ? 3 : 1.75} />
                ))}
                {s.values.map((v, i) => v != null && (
                  <g key={i}>
                    <circle cx={x(i)} cy={y(v)} r={s.emphasis ? 4.5 : 3.5} fill="var(--surface)" stroke={c} strokeWidth="2"
                      tabIndex={0} role="img" aria-label={`${s.name}, ${labels[i]}: ${format(v)}${s.detail?.[i] ? ` (${s.detail[i]})` : ''}`}
                      onMouseEnter={() => setFocus({ s, i, v })} onMouseLeave={() => setFocus(null)}
                      onFocus={() => setFocus({ s, i, v })} onBlur={() => setFocus(null)} />
                    {valueLabels && s.emphasis && <text x={x(i)} y={y(v) - 10} className="value-label" textAnchor="middle">{format(v)}</text>}
                  </g>
                ))}
              </g>
            );
          })}
          {ends.map((e) => (
            <text key={e.s.name} x={x(e.i) + 10} y={e.y + 4} className={`end-label${e.s.emphasis ? ' emphasis' : ''}`} fill={color(e.k, e.s)}>{e.s.name}</text>
          ))}
          {focus && (
            <g pointerEvents="none">
              <rect x={Math.min(x(focus.i) - 70, width - 150)} y={Math.max(y(focus.v) - 52, 0)} width="140" height="38" rx="6" className="tip" />
              <text x={Math.min(x(focus.i), width - 80)} y={Math.max(y(focus.v) - 36, 16)} textAnchor="middle" className="tip-text">
                {focus.s.name}, {labels[focus.i]}
              </text>
              <text x={Math.min(x(focus.i), width - 80)} y={Math.max(y(focus.v) - 20, 32)} textAnchor="middle" className="tip-text strong">
                {format(focus.v)}{focus.s.detail?.[focus.i] ? ` · ${focus.s.detail[focus.i]}` : ''}
              </text>
            </g>
          )}
        </svg>
      )}
    </figure>
  );
}
