/**
 * A tiny multi-series sparkline, hand-rolled in SVG.
 *
 * No charting library on purpose: this is four polylines in a 64×20 box, and a chart library
 * would be more bytes than the whole dashboard's CSS for something that renders once per table
 * row. If this ever needs axes, tooltips or zoom, that is the moment to reach for a library —
 * not now.
 *
 * Each series is normalised independently against its OWN maximum. Sharing one scale would make
 * memory (a few percent of 18GB) a flat line whenever CPU spikes, which is exactly the
 * comparison a sparkline is for.
 */
export interface Series {
  label: string;
  /** CSS colour. */
  color: string;
  values: number[];
  /** Fixed ceiling when the series has a meaningful one (percentages); otherwise the max. */
  max?: number;
}

export function Sparkline({ series, width = 64, height = 20 }: { series: Series[]; width?: number; height?: number }) {
  const points = series
    .map((s) => {
      if (s.values.length < 2) return null;
      // A flat series must not divide by zero, and a single sample cannot make a line.
      const ceiling = s.max ?? Math.max(...s.values, Number.EPSILON);
      const scale = ceiling > 0 ? ceiling : 1;
      const dx = width / (s.values.length - 1);
      const d = s.values
        .map((v, i) => {
          const y = height - Math.min(1, Math.max(0, v / scale)) * (height - 2) - 1;
          return `${i === 0 ? "M" : "L"}${(i * dx).toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
      return { d, color: s.color, label: s.label };
    })
    .filter((p): p is { d: string; color: string; label: string } => p !== null);

  if (points.length === 0) return <span className="text-muted-foreground">—</span>;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      // role=img with a label so this is not silent to a screen reader; the numeric detail lives
      // in the title attribute the caller sets on the cell.
      role="img"
      aria-label={points.map((p) => p.label).join(", ")}
      className="overflow-visible"
    >
      {points.map((p) => (
        <path key={p.label} d={p.d} fill="none" stroke={p.color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
