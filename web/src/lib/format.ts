const DAY = 86400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Chat-list style: time today, "Yesterday", weekday this week, else date. */
export function formatListTime(ts: number | null, now = Date.now()): string {
  if (!ts) return '';
  const today = startOfDay(now);
  if (ts >= today) return formatTime(ts);
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 6 * DAY) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(ts).toLocaleDateString();
}

/** Date separator label inside a chat. */
export function formatDayLabel(ts: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (ts >= today) return 'Today';
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 6 * DAY) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return '';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function initials(name: string): string {
  const clean = name.replace(/^[~+]/, '').trim();
  if (!clean) return '?';
  if (/^\+?\d/.test(clean)) return '#';
  const parts = clean.split(/\s+/).filter(Boolean);
  const first = [...(parts[0] ?? '')][0] ?? '';
  const second = parts.length > 1 ? ([...(parts[parts.length - 1] ?? '')][0] ?? '') : '';
  return (first + second).toUpperCase();
}

const SENDER_COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#53bdeb', '#ffb74d', '#4db6ac', '#ba68c8', '#f06292'];

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(h) % SENDER_COLORS.length]!;
}
