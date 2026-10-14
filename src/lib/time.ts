// Every time decision goes through here. The frame's own zone is
// America/New_York (it can't be changed without touching the frame), so
// Date#getHours() is wrong for us: parts() reads the wall clock in the zone
// the server configures (setZone(), from the dashboard loader). The instant itself still comes
// from the frame's clock (Date.now()).

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let tz = 'America/Phoenix';
let fmt: Intl.DateTimeFormat | null = null;
function formatter() {
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  return fmt;
}

export function setZone(zone: string) { tz = zone; fmt = null; }
export function zone() { return tz; }

// Demo/testing offset (ms), set by ?at=HH:MM. Never set on a real frame.
let offset = 0;
export function setOffset(ms: number) { offset = ms; }
export function now() { return new Date(Date.now() + offset); }

export interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number; dow: number; key: string; mins: number }

/**
 * Wall-clock parts in the configured zone.
 * @returns {{y:number, mo:number, d:number, h:number, mi:number, s:number,
 *   dow:number, key:string, mins:number}}  mo is 1-12; key is 'YYYY-MM-DD';
 *   mins is minutes since local midnight.
 */
export function parts(date?: Date): Parts {
  const out: Record<string, string> = {};
  for (const p of formatter().formatToParts(date || now())) out[p.type] = p.value;
  const y = +out.year, mo = +out.month, d = +out.day, h = +out.hour % 24, mi = +out.minute;
  return {
    y, mo, d, h, mi, s: +out.second, dow: DOW[out.weekday],
    key: out.year + '-' + out.month + '-' + out.day,
    mins: h * 60 + mi,
  };
}

// Date-key arithmetic, independent of any zone ('2026-10-13' + 1 → '2026-10-14').
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
export function dowOf(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function diffDays(a: string, b: string): number {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 864e5);
}

// 'HH:MM' → minutes since midnight
export function hm(s: string): number { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); }

// Is `mins` inside [from, to)? Windows may wrap midnight ('21:30'–'06:00').
export function inWindow(mins: number, from: string, to: string): boolean {
  const a = hm(from), b = hm(to);
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

export const names = {
  day: (dow: number) => DAYS[dow],
  dayShort: (dow: number) => DAYS[dow].slice(0, 3),
  month: (mo: number) => MONTHS[mo - 1],
  monthShort: (mo: number) => MONTHS[mo - 1].slice(0, 3),
};

// 12-hour formatting from minutes since midnight.
export function clock(mins: number): string {
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m;
}
export function ampm(mins: number): string { return Math.floor(mins / 60) % 24 >= 12 ? 'PM' : 'AM'; }
// "4 PM", "3:45 PM"
export function hourLabel(mins: number): string {
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  return (h % 12 || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
// "Today" / "Tomorrow" / weekday name, relative to today's key.
export function relDay(key: string): string {
  const diff = diffDays(parts().key, key);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return DAYS[dowOf(key)];
}
// "updated 12 min ago" from an epoch-ms timestamp
export function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  return h < 24 ? h + ' hr ago' : Math.floor(h / 24) + ' days ago';
}
