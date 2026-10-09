/**
 * Small, dependency-free charts for the admin console.
 *
 * Colors are two validated slots (scripts in the dataviz guidance: CVD and
 * contrast checked in light and dark): --viz-1 blue for the main series,
 * --viz-2 orange for its counterpart (closed jobs, rule-engine parses). Text
 * never wears a series color; values and labels use the gray text tokens.
 * Every chart has a table view, so no value is reachable only by hover.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Put this on a tab's root: it defines the chart color tokens for light and dark. */
export const VIZ_TOKENS =
  '[--viz-1:#2a78d6] [--viz-2:#eb6834] [--viz-grid:#e5e7eb] [--viz-axis:#d1d5db] ' +
  'dark:[--viz-1:#3987e5] dark:[--viz-2:#d95926] dark:[--viz-grid:#1f2937] dark:[--viz-axis:#374151]';

export interface DayPoint { date: string; value: number }

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'));
const compact = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K` : v.toLocaleString('en-US'));
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function niceMax(v: number): number {
  if (v <= 4) {return Math.max(1, Math.ceil(v));}
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v) ?? v;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) {return;}
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── Sparkline ────────────────────────────────────────────────────────────────

export function Sparkline({ values, width = 112, height = 32 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) {return null;}
  const max = Math.max(1, ...values);
  const pad = 4;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <path d={`${line} L${x(last)},${height - pad} L${x(0)},${height - pad} Z`} fill="var(--viz-1)" opacity={0.1} />
      <path d={line} fill="none" stroke="var(--viz-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last])} r={4} fill="var(--viz-1)" stroke="hsl(var(--card))" strokeWidth={2} />
    </svg>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────────────

export function StatTile({ label, value, sub, thisWeek, priorWeek, upIsGood = true, trend }: {
  label: string; value: number | null; sub?: ReactNode;
  thisWeek?: number; priorWeek?: number; upIsGood?: boolean; trend?: number[];
}) {
  let delta: ReactNode = null;
  if (thisWeek !== undefined && priorWeek !== undefined) {
    const d = thisWeek - priorWeek;
    const good = d === 0 ? null : (d > 0) === upIsGood;
    const tone = good === null ? 'text-gray-500' : good ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400';
    const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '';
    delta = <span className={tone}>{arrow && <span aria-hidden>{arrow} </span>}{d === 0 ? 'same as' : `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} vs`} the week before</span>;
  }
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-card p-4 flex flex-col gap-2 min-w-0">
      <p className="text-xs text-gray-500">{label}</p>
      <div className="flex items-end justify-between gap-3">
        <p className="text-2xl font-semibold text-gray-900 dark:text-white leading-none">{fmt(value)}</p>
        {trend && trend.some(v => v > 0) && <Sparkline values={trend} />}
      </div>
      {(delta || sub) && <p className="text-xs text-gray-500 leading-snug">{delta}{delta && sub ? ' · ' : ''}{sub}</p>}
    </div>
  );
}

// ── Table view (every chart has one) ─────────────────────────────────────────

export function TableView({ head, rows }: { head: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 w-fit">Show as table</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded border border-gray-200 dark:border-gray-800">
        <table className="w-full tabular-nums">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900">
            <tr>{head.map((h, i) => <th key={h} className={`px-2 py-1.5 font-medium text-gray-600 dark:text-gray-300 ${i ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                {r.map((c, j) => <td key={j} className={`px-2 py-1 text-gray-700 dark:text-gray-300 ${j ? 'text-right' : ''}`}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── Daily columns (one series, or two diverging around a baseline) ──────────

export interface ColumnSeries { label: string; color: 'var(--viz-1)' | 'var(--viz-2)'; points: DayPoint[] }

/** Rounded data-end, square at the baseline. `down` draws below the baseline. */
function columnPath(x: number, w: number, base: number, h: number, down = false): string {
  if (h <= 0) {return '';}
  const r = Math.min(4, w / 2, h);
  if (!down) {
    const top = base - h;
    return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
  }
  const bot = base + h;
  return `M${x},${base} V${bot - r} Q${x},${bot} ${x + r},${bot} H${x + w - r} Q${x + w},${bot} ${x + w},${bot - r} V${base} Z`;
}

export function DailyColumns({ series, height = 180, labelOf = day, period = 'last 28 days', firstColumn = 'Day' }: {
  series: ColumnSeries[]; height?: number;
  /** Axis/tooltip label for a point's date (hourly charts pass their own). */
  labelOf?: (date: string) => string; period?: string; firstColumn?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const diverging = series.length === 2;
  const days = series[0]?.points ?? [];
  const n = days.length;
  const left = 36; const right = 8; const top = 10; const bottomAxis = 22;
  const plotW = Math.max(0, width - left - right);
  const plotH = height - top - bottomAxis;
  const maxUp = niceMax(Math.max(0, ...series[0].points.map(p => p.value)));
  const maxDown = diverging ? niceMax(Math.max(0, ...series[1].points.map(p => p.value))) : 0;
  const span = maxUp + maxDown;
  const base = top + (span ? (maxUp / span) * plotH : plotH);
  const scale = span ? plotH / span : 0;
  const band = n ? plotW / n : 0;
  const barW = Math.max(2, Math.min(24, band - 2));
  // A middle tick only when it's a whole number: a "2" drawn at 1.5 misstates the scale.
  const ticks = diverging ? [maxUp, 0, maxDown] : Number.isInteger(maxUp / 2) ? [maxUp, maxUp / 2, 0] : [maxUp, 0];
  const tickY = (t: number, i: number) => (diverging ? (i === 0 ? base - maxUp * scale : i === 1 ? base : base + maxDown * scale) : base - t * scale);
  const labelIdx = n ? [0, Math.floor((n - 1) / 2), n - 1] : [];

  return (
    <div>
      {series.length > 1 && (
        <div className="flex flex-wrap gap-4 mb-2 text-xs text-gray-600 dark:text-gray-300">
          {series.map((s, i) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label}{diverging ? (i === 0 ? ' (above the line)' : ' (below)') : ''}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${series.map(s => s.label).join(' and ')}, ${period}`}>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={left} x2={width - right} y1={tickY(t, i)} y2={tickY(t, i)} stroke={(diverging ? i === 1 : t === 0) ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
                <text x={left - 6} y={tickY(t, i)} dy="0.32em" textAnchor="end" className="fill-gray-500 text-[10px] tabular-nums">{compact(Math.round(t))}</text>
              </g>
            ))}
            {days.map((d, i) => {
              const x = left + i * band + (band - barW) / 2;
              const up = series[0].points[i].value * scale;
              const down = diverging ? series[1].points[i].value * scale : 0;
              const dim = hover !== null && hover !== i;
              return (
                <g key={d.date} opacity={dim ? 0.45 : 1}>
                  <path d={columnPath(x, barW, base - (diverging && up ? 1 : 0), up)} fill={series[0].color} />
                  {diverging && <path d={columnPath(x, barW, base + (down ? 1 : 0), down, true)} fill={series[1].color} />}
                  <rect x={left + i * band} y={top} width={band} height={plotH} fill="transparent"
                    onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
                </g>
              );
            })}
            {labelIdx.map((i, k) => (
              <text key={i} x={left + i * band + band / 2} y={height - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
                className="fill-gray-500 text-[10px]">{labelOf(days[i].date)}</text>
            ))}
          </svg>
        )}
        {hover !== null && days[hover] && (
          <div className="pointer-events-none absolute z-10 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-xs shadow-sm"
            style={{ left: Math.min(Math.max(0, left + hover * band + band / 2 - 70), Math.max(0, width - 150)), top: 0 }}>
            <p className="font-medium text-gray-900 dark:text-white">{labelOf(days[hover].date)}</p>
            {series.map(s => (
              <p key={s.label} className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
                <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />
                {s.label}: <span className="tabular-nums text-gray-900 dark:text-white">{fmt(s.points[hover].value)}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <TableView head={[firstColumn, ...series.map(s => s.label)]} rows={[...days].reverse().map((d, k) => {
        const i = n - 1 - k;
        return [labelOf(d.date), ...series.map(s => fmt(s.points[i].value))];
      })} />
    </div>
  );
}

// ── Horizontal bars (ranked list; optional budget marker) ────────────────────

export function HBars({ rows, format = fmt, budget, budgetLabel }: {
  rows: Array<{ label: string; value: number; note?: string; color?: string }>;
  format?: (v: number) => string; budget?: number; budgetLabel?: string;
}) {
  const max = Math.max(1, budget ?? 0, ...rows.map(r => r.value));
  return (
    <div>
      <div className="space-y-2.5">
        {rows.map(r => (
          <div key={r.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] items-center gap-3">
            <span className="text-sm text-gray-700 dark:text-gray-300 truncate" title={r.label}>{r.label}</span>
            <div className="relative h-3">
              <div className="absolute inset-y-0 left-0 rounded-r" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 2 : 0, background: r.color ?? 'var(--viz-1)' }} />
              {budget !== undefined && <div className="absolute -inset-y-1 w-px bg-gray-400 dark:bg-gray-500" style={{ left: `${(budget / max) * 100}%` }} aria-hidden />}
            </div>
            <span className="text-sm tabular-nums text-gray-900 dark:text-white text-right">
              {format(r.value)}{r.note && <span className="ml-1.5 text-xs text-gray-500">{r.note}</span>}
            </span>
          </div>
        ))}
      </div>
      {budget !== undefined && budgetLabel && <p className="mt-2 text-xs text-gray-500">The thin vertical line marks {budgetLabel}.</p>}
    </div>
  );
}

// ── Funnel ───────────────────────────────────────────────────────────────────

export function Funnel({ steps, pendingSource }: {
  steps: Array<{ label: string; value: number | null; source: string }>;
  /** Steps from this source are still loading: show "loading", not "not available". */
  pendingSource?: string;
}) {
  const max = Math.max(1, ...steps.map(s => s.value ?? 0));
  return (
    <div className="space-y-3">
      {steps.map((s, i) => {
        // Compare only with the previous step from the SAME source: database and
        // site-analytics counts measure different things and don't divide.
        const prevStep = steps.slice(0, i).reverse().find(p => p.value !== null && p.source === s.source);
        const conv = s.value !== null && prevStep?.value ? Math.round((s.value / prevStep.value) * 100) : null;
        return (
          <div key={s.label} className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-center gap-3">
            <div className="min-w-0">
              <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{s.label}</p>
              <p className="text-[11px] text-gray-500">{s.source}</p>
            </div>
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-5 rounded-r" style={{ width: `${s.value ? Math.max(1, (s.value / max) * 100) : 0}%`, background: 'var(--viz-1)', opacity: s.source === 'database' ? 1 : 0.55 }} />
              <span className="text-sm tabular-nums text-gray-900 dark:text-white shrink-0">{s.value === null ? (s.source === pendingSource ? 'loading…' : 'not available') : fmt(s.value)}</span>
              {conv !== null && prevStep && <span className="text-xs text-gray-500 min-w-0 truncate">{conv}% of "{prevStep.label.toLowerCase()}"</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
