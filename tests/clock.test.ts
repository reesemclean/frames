// The minute stamp (lib/clock.ts) that hydration reads back: it must rebuild
// every field the clock text uses, so the frame's first render matches the
// server's HTML even when the frame's own clock has crossed a boundary.
import { afterEach, describe, expect, it } from 'vitest'
import * as time from '~/lib/time'
import { parseStamp, stampMinute } from '~/lib/clock'

afterEach(() => time.setZone('America/Phoenix'))

const text = (p: time.Parts) =>
  time.clock(p.mins) + ' ' + time.ampm(p.mins) + ' ' + time.names.day(p.dow) + ', ' + time.names.month(p.mo) + ' ' + p.d

describe('minute stamp', () => {
  it('round-trips the fields the clock renders, either side of noon and midnight', () => {
    time.setZone('America/Phoenix')
    for (const iso of ['2026-10-14T18:59:58Z', '2026-10-14T19:00:03Z', '2026-10-15T06:59:59Z', '2026-10-15T07:00:01Z']) {
      const p = time.parts(new Date(iso))
      const q = parseStamp(stampMinute(p))!
      expect(q).toMatchObject({ y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi, dow: p.dow, key: p.key, mins: p.mins })
      expect(text(q)).toBe(text(p))
    }
  })
  it('keeps the server side of a straddle: 11:59 AM stays AM, 11:59 PM keeps its date', () => {
    time.setZone('America/Phoenix')
    expect(text(parseStamp(stampMinute(time.parts(new Date('2026-10-14T18:59:58Z'))))!)).toBe('11:59 AM Wednesday, October 14')
    expect(text(parseStamp(stampMinute(time.parts(new Date('2026-10-15T06:59:59Z'))))!)).toBe('11:59 PM Wednesday, October 14')
  })
  it('rejects anything malformed (hydration then falls back to the live minute)', () => {
    expect(parseStamp(null)).toBe(null)
    expect(parseStamp('')).toBe(null)
    expect(parseStamp('2026-10-14|1440')).toBe(null)
    expect(parseStamp('2026-10-14')).toBe(null)
    expect(parseStamp('x|5')).toBe(null)
  })
})
