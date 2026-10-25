export function relTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 45000) return diff >= 0 ? 'just now' : 'in a moment';
  if (mins < 60) return `${mins}m ${suffix}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ${suffix}`;
  return d.toLocaleDateString();
}

export function fmtDur(ms: number | null | undefined): string {
  if (!ms || ms < 0 || Number.isNaN(ms)) return '–:––';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function dayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Points of an SVG polyline for a sparkline of values. */
export function sparklinePath(values: number[], width = 120, height = 34): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / span) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Color for heatmap intensity 0..1 (dark ember → blood red). */
export function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped === 0) return 'rgba(255,255,255,0.03)';
  // deep oxblood → bright arterial red
  const r = Math.round(70 + (255 - 70) * clamped);
  const g = Math.round(8 + (30 - 8) * clamped);
  const b = Math.round(14 + (45 - 14) * clamped);
  return `rgba(${r},${g},${b},${0.16 + clamped * 0.78})`;
}
