// The mode rules (components/modeRules.ts): windows that wrap midnight, the
// photo windows' days filter, idle thresholds, and zone-local decisions in a
// zone with DST even though the frame's own zone differs.
import { afterEach, describe, expect, it } from 'vitest'
import * as time from '~/lib/time'
import { NIGHTDASH_IDLE_SEC, bootMode, forcedMode, inPhotoWindow, isNight, nextMode } from '~/components/modeRules'

const O = {
  night: { from: '21:30', to: '06:00' },
  photos: {
    windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '16:00' }],
    idleSec: 120,
    layout: 'auto' as const,
    intervalSec: 15,
  },
}
const at = (hhmm: string, dow = 2) => ({ mins: time.hm(hhmm), dow })

afterEach(() => time.setZone('America/Phoenix'))

describe('windows', () => {
  it('night wraps midnight', () => {
    expect(isNight(O, at('21:29'))).toBe(false)
    expect(isNight(O, at('21:30'))).toBe(true)
    expect(isNight(O, at('00:00'))).toBe(true)
    expect(isNight(O, at('03:00'))).toBe(true)
    expect(isNight(O, at('05:59'))).toBe(true)
    expect(isNight(O, at('06:00'))).toBe(false)
  })
  it('photo windows honour days, and a window without days is every day', () => {
    expect(inPhotoWindow(O, at('10:00', 2))).toBe(true)
    expect(inPhotoWindow(O, at('10:00', 0))).toBe(false)
    expect(inPhotoWindow(O, at('16:00', 2))).toBe(false)
    const any = { ...O, photos: { ...O.photos, windows: [{ from: '09:00', to: '16:00' } as never] } }
    expect(inPhotoWindow(any, at('10:00', 0))).toBe(true)
    const none = { ...O, photos: { ...O.photos, windows: [] } }
    expect(inPhotoWindow(none, at('10:00'))).toBe(false)
  })
})

describe('nextMode', () => {
  it('day waits for idleSec, then goes to night or photos', () => {
    expect(nextMode('day', O, at('10:00'), 119)).toBe('day')
    expect(nextMode('day', O, at('10:00'), 120)).toBe('photos')
    expect(nextMode('day', O, at('22:00'), 120)).toBe('night')
    expect(nextMode('day', O, at('17:00'), 9999)).toBe('day')
  })
  it('photos ends at the window edge or at night, whatever the idle', () => {
    expect(nextMode('photos', O, at('15:59'), 0)).toBe('photos')
    expect(nextMode('photos', O, at('16:00'), 9999)).toBe('day')
    const late = { ...O, photos: { ...O.photos, windows: [{ days: [2], from: '18:00', to: '23:00' }] } }
    expect(nextMode('photos', late, at('21:30'), 0)).toBe('night')
  })
  it('night lasts until morning; a tap at night dims, then returns after 20 s', () => {
    expect(nextMode('night', O, at('05:59'), 9999)).toBe('night')
    expect(nextMode('night', O, at('06:00'), 9999)).toBe('day')
    expect(nextMode('nightdash', O, at('23:00'), NIGHTDASH_IDLE_SEC - 1)).toBe('nightdash')
    expect(nextMode('nightdash', O, at('23:00'), NIGHTDASH_IDLE_SEC)).toBe('night')
    expect(nextMode('nightdash', O, at('06:00'), 0)).toBe('day')
  })
})

describe('boot', () => {
  it('boots straight into what the rules want (no bright idleSec first)', () => {
    expect(bootMode(O, at('03:00'))).toBe('night')
    expect(bootMode(O, at('10:00'))).toBe('photos')
    expect(bootMode(O, at('17:00'))).toBe('day')
  })
  it('reads ?mode=', () => {
    expect(forcedMode('?mode=photos')).toBe('photos')
    expect(forcedMode('?at=22:00&mode=nightdash')).toBe('nightdash')
    expect(forcedMode('?mode=bogus')).toBe(null)
    expect(forcedMode('')).toBe(null)
  })
})

describe('zone-local decisions', () => {
  // 03:00:30 in Phoenix is 06:00:30 on the frame's own New York clock: a
  // frame-zone reading would call it morning.
  it('the nightly reload in Phoenix boots to night', () => {
    time.setZone('America/Phoenix')
    expect(bootMode(O, time.parts(new Date('2026-10-14T10:00:30Z')))).toBe('night')
  })
  it('follows DST in a zone that has it', () => {
    time.setZone('America/New_York')
    // 05:30 local on both sides of the spring-forward change (EST, then EDT).
    expect(bootMode(O, time.parts(new Date('2026-03-07T10:30:00Z')))).toBe('night') // Sat 05:30 EST
    expect(bootMode(O, time.parts(new Date('2026-03-09T09:30:00Z')))).toBe('night') // Mon 05:30 EDT
    // 06:30 EDT the day after: the same UTC instant as 05:30 EST was.
    expect(bootMode(O, time.parts(new Date('2026-03-09T10:30:00Z')))).toBe('day')
    // Monday 10:00 EDT is a photo window.
    expect(bootMode(O, time.parts(new Date('2026-03-09T14:00:00Z')))).toBe('photos')
  })
})
