// When was a photo taken, from its EXIF. sharp hands back the raw EXIF block
// (metadata().exif) but doesn't parse it, and three tags don't justify a
// dependency, so this walks the TIFF structure itself.
//
// DateTimeOriginal carries no zone. It's read in the household's zone unless
// the camera also wrote OffsetTimeOriginal. Never the process's own zone.

const ASCII = 2

/** Epoch ms of a wall-clock time in `tz` (DST-correct). */
export function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  // How far `tz` is ahead of UTC at instant `ms`.
  const offset = (ms: number) => {
    const p: Record<string, number> = {}
    for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = +part.value
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi, s)
  const first = offset(wall)
  let t = wall - first
  // Re-check once: the guess may sit on the other side of a DST change.
  const second = offset(t)
  if (second !== first) t = wall - second
  return t
}

interface Tiff { buf: Buffer; base: number; le: boolean }

function u16(t: Tiff, at: number) { return t.le ? t.buf.readUInt16LE(t.base + at) : t.buf.readUInt16BE(t.base + at) }
function u32(t: Tiff, at: number) { return t.le ? t.buf.readUInt32LE(t.base + at) : t.buf.readUInt32BE(t.base + at) }

/** The tags of one IFD as {tag: string | number}; only ASCII and LONG/SHORT values. */
function readIfd(t: Tiff, at: number): Map<number, string | number> {
  const out = new Map<number, string | number>()
  const n = u16(t, at)
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12
    const tag = u16(t, e), type = u16(t, e + 2), count = u32(t, e + 4)
    if (type === ASCII) {
      const off = count <= 4 ? e + 8 : u32(t, e + 8)
      const start = t.base + off
      if (start + count > t.buf.length) continue
      out.set(tag, t.buf.toString('latin1', start, start + count).replace(/[\0\s]+$/, ''))
    } else if (type === 4) out.set(tag, u32(t, e + 8)) // LONG
    else if (type === 3) out.set(tag, u16(t, e + 8)) // SHORT
  }
  return out
}

function parseTiff(exif: Buffer): { ifd0: Map<number, string | number>; sub: Map<number, string | number> } {
  // sharp's block starts with the APP1 "Exif\0\0" identifier.
  const base = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0
  const order = exif.toString('latin1', base, base + 2)
  if (order !== 'II' && order !== 'MM') throw new Error('not TIFF')
  const t: Tiff = { buf: exif, base, le: order === 'II' }
  if (u16(t, 2) !== 42) throw new Error('not TIFF')
  const ifd0 = readIfd(t, u32(t, 4))
  const ptr = ifd0.get(0x8769)
  const sub = typeof ptr === 'number' ? readIfd(t, ptr) : new Map<number, string | number>()
  return { ifd0, sub }
}

/** DateTimeOriginal (or DateTime) as epoch ms; null when absent or unreadable. */
export function exifTaken(exif: Buffer | undefined | null, tz: string): number | null {
  if (!exif) return null
  try {
    const { ifd0, sub } = parseTiff(exif)
    const raw = sub.get(0x9003) ?? ifd0.get(0x0132)
    if (typeof raw !== 'string') return null
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw)
    if (!m) return null
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
    if (!y || !mo || !d) return null // "0000:00:00 00:00:00" means unknown
    const off = sub.get(0x9011)
    const om = typeof off === 'string' ? /^([+-])(\d{2}):(\d{2})$/.exec(off) : null
    if (om) {
      const mins = (om[1] === '-' ? -1 : 1) * (+om[2] * 60 + +om[3])
      return Date.UTC(y, mo - 1, d, h, mi, s) - mins * 60_000
    }
    return zonedEpoch(y, mo, d, h, mi, s, tz)
  } catch {
    // A bad EXIF date just means "unknown".
    return null
  }
}
