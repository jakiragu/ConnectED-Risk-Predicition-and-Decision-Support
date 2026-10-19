/**
 * A small line chart for trends across the school year's checkpoints. Points
 * with no value leave a gap rather than being drawn as zero. Values are on a
 * fixed 0-100 scale (percentages and marks), so charts side by side compare.
 *
 * @param {{labels:string[], series:{name:string, values:(number|null)[]}[], line?:{value:number, label:string},
 *          format?:(v:number)=>string, title:string}} props
 */
const W = 520;
const H = 200;
const PAD = { l: 34, r: 12, t: 12, b: 28 };
const COLORS = ['var(--accent)', '#0f6b5a', '#b3412e', '#7a5c9e', '#c28a12', '#3d6fb6', '#5f7d2b', '#a0466d', '#4f5b66', '#8c6a4f'];

export default function LineChart({ labels, series, line, format = (v) => `${Math.round(v)}`, title }) {
  const x = (i) => PAD.l + (labels.length < 2 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (labels.length - 1));
  const y = (v) => PAD.t + (1 - v / 100) * (H - PAD.t - PAD.b);
  const shown = series.filter((s) => s.values.some((v) => v != null));
  return (
    <figure className="linechart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 6} y={y(v) + 4} className="tick" textAnchor="end">{v}</text>
          </g>
        ))}
        {labels.map((l, i) => <text key={l} x={x(i)} y={H - 8} className="tick" textAnchor="middle">{l}</text>)}
        {line && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(line.value)} y2={y(line.value)} className="threshold" />
            <text x={W - PAD.r} y={y(line.value) - 4} className="tick" textAnchor="end">{line.label}</text>
          </g>
        )}
        {shown.map((s, k) => {
          const color = COLORS[k % COLORS.length];
          const segments = [];
          let current = [];
          s.values.forEach((v, i) => {
            if (v == null) { if (current.length) segments.push(current); current = []; } else current.push([x(i), y(v)]);
          });
          if (current.length) segments.push(current);
          return (
            <g key={s.name}>
              {segments.map((seg, j) => <polyline key={j} points={seg.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth="2" />)}
              {s.values.map((v, i) => v != null && (
                <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={color}><title>{`${s.name}, ${labels[i]}: ${format(v)}`}</title></circle>
              ))}
            </g>
          );
        })}
      </svg>
      {shown.length > 1 && (
        <figcaption className="legend">
          {shown.map((s, k) => <span key={s.name}><i style={{ background: COLORS[k % COLORS.length] }} />{s.name}</span>)}
        </figcaption>
      )}
    </figure>
  );
}
