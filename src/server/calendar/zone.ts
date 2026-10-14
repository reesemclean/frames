// Instants <-> wall-clock time in a named IANA zone, with Intl only. The
// server's own process TZ is never consulted: the household zone comes from
// settings, and must be right across DST changes (Phoenix has none, most
// zones do).

export interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

const valid = new Map<string, boolean>()
/** Is this a time zone name Intl knows (an IANA id like 'America/New_York')? */
export function isZone(tz: string | null | undefined): tz is string {
  if (!tz) return false
  let ok = valid.get(tz)
  if (ok === undefined) {
    try { formatter(tz); ok = true } catch { ok = false }
    valid.set(tz, ok)
  }
  return ok
}

/** The wall clock in `tz` at epoch-ms `t`. */
export function wallAt(t: number, tz: string): Wall {
  const out: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(new Date(t))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second }
}

function asUTC(w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
}

/** Offset of `tz` from UTC at epoch-ms `t`, in ms (Phoenix: -7 h). */
function offsetAt(t: number, tz: string): number {
  return asUTC(wallAt(t, tz)) - Math.floor(t / 1000) * 1000
}

/**
 * The instant a wall-clock time in `tz` names. The offsets a day either side
 * bracket any one DST change: an ambiguous time (the repeated hour in the
 * autumn) takes the earlier instant, a skipped one (the lost spring hour) is
 * read with the offset from before the change, so 2:30 becomes 3:30. That
 * matches Python's zoneinfo with fold=0, which the earlier implementation used.
 */
export function wallToInstant(w: Wall, tz: string): number {
  const guess = asUTC(w)
  const before = guess - offsetAt(guess - 864e5, tz)
  const after = guess - offsetAt(guess + 864e5, tz)
  const fits = (t: number) => asUTC(wallAt(t, tz)) === guess
  const a = fits(before), b = fits(after)
  if (a && b) return Math.min(before, after)
  if (a) return before
  if (b) return after
  return before
}

const pad = (n: number) => (n < 10 ? '0' : '') + n

export function keyOf(w: { y: number; mo: number; d: number }): string {
  return w.y + '-' + pad(w.mo) + '-' + pad(w.d)
}

/** Local midnight starting the day `key` ('YYYY-MM-DD') in `tz`, as epoch ms. */
export function dayStart(key: string, tz: string): number {
  const [y, mo, d] = key.split('-').map(Number)
  return wallToInstant({ y, mo, d, h: 0, mi: 0, s: 0 }, tz)
}

/** Zone-local day key and minutes since local midnight at epoch-ms `t`. */
export function localOf(t: number, tz: string): { key: string; mins: number } {
  const w = wallAt(t, tz)
  return { key: keyOf(w), mins: w.h * 60 + w.mi }
}

/** Today's key in `tz`. */
export function todayKey(tz: string, now: number = Date.now()): string {
  return keyOf(wallAt(now, tz))
}
