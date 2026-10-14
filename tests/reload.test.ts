// The daily reload decision (lib/reload.ts): zone-local, guarded against a
// boot-time loop, and tolerant of a malformed option.
import { afterEach, describe, expect, it } from 'vitest'
import * as time from '~/lib/time'
import { reloadMinute, shouldReload } from '~/lib/reload'

afterEach(() => time.setZone('America/Phoenix'))
const UP = 3_600_000

describe('shouldReload', () => {
  it('fires in the reloadAt minute only, after 10 minutes up', () => {
    expect(shouldReload(180, '03:00', UP)).toBe(true)
    expect(shouldReload(181, '03:00', UP)).toBe(false)
    expect(shouldReload(180, '03:00', 300_000)).toBe(false)
  })
  it('uses the household zone, not the frame clock zone', () => {
    // 2026-07-01 10:00Z is 03:00 in Phoenix and 06:00 in New York (the frames' own zone).
    time.setZone('America/Phoenix')
    expect(shouldReload(time.parts(new Date('2026-07-01T10:00:00Z')).mins, '03:00', UP)).toBe(true)
    time.setZone('America/New_York')
    expect(shouldReload(time.parts(new Date('2026-07-01T10:00:00Z')).mins, '03:00', UP)).toBe(false)
    // Across DST in a zone that has it: 03:00 EST in January is 08:00Z.
    expect(shouldReload(time.parts(new Date('2026-01-15T08:00:00Z')).mins, '03:00', UP)).toBe(true)
  })
  it('falls back to 03:00 for a malformed option instead of throwing', () => {
    expect(reloadMinute(2130)).toBe(180)
    expect(reloadMinute('nope')).toBe(180)
    expect(reloadMinute('25:00')).toBe(180)
    expect(reloadMinute('04:30')).toBe(270)
  })
})
