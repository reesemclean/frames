// The mode rules (components/modeRules.ts): night hours that wrap midnight,
// the slideshow as home with scheduled dashboard visits, idle thresholds, and
// zone-local decisions in a zone with DST even though the frame's own zone
// differs.
import { afterEach, describe, expect, it } from 'vitest'
import * as time from '~/lib/time'
import { NIGHTDASH_IDLE_SEC, bootMode, forcedMode, isNight, nextMode } from '~/components/modeRules'

const O = {
  night: { from: '21:30', to: '06:00' },
  photos: {
    idleSec: 120,
    dashboardEverySec: 600,
    dashboardForSec: 60,
    layout: 'auto' as const,
    intervalSec: 15,
  },
}
const at = (hhmm: string, dow = 2) => ({ mins: time.hm(hhmm), dow })

afterEach(() => time.setZone('America/Phoenix'))

describe('night', () => {
  it('wraps midnight', () => {
    expect(isNight(O, at('21:29'))).toBe(false)
    expect(isNight(O, at('21:30'))).toBe(true)
    expect(isNight(O, at('00:00'))).toBe(true)
    expect(isNight(O, at('03:00'))).toBe(true)
    expect(isNight(O, at('05:59'))).toBe(true)
    expect(isNight(O, at('06:00'))).toBe(false)
  })
})

describe('nextMode', () => {
  it('the slideshow stops on the dashboard every dashboardEverySec', () => {
    expect(nextMode('photos', O, at('10:00'), 9999, 599)).toBe('photos')
    expect(nextMode('photos', O, at('10:00'), 9999, 600)).toBe('day')
  })
  it('a scheduled visit lasts dashboardForSec', () => {
    expect(nextMode('day', O, at('10:00'), 9999, 59)).toBe('day')
    expect(nextMode('day', O, at('10:00'), 9999, 60)).toBe('photos')
  })
  it('a tap holds the dashboard for idleSec', () => {
    expect(nextMode('day', O, at('10:00'), 119, 9999)).toBe('day')
    expect(nextMode('day', O, at('10:00'), 120, 9999)).toBe('photos')
    // A tap during a scheduled visit extends it.
    expect(nextMode('day', O, at('10:00'), 30, 90)).toBe('day')
  })
  it('night takes over from the slideshow at once, from the dashboard once idle', () => {
    expect(nextMode('photos', O, at('21:30'), 0, 0)).toBe('night')
    expect(nextMode('day', O, at('22:00'), 119, 9999)).toBe('day')
    expect(nextMode('day', O, at('22:00'), 120, 9999)).toBe('night')
    // A scheduled visit that runs into night hours doesn't wait it out.
    expect(nextMode('day', O, at('22:00'), 9999, 10)).toBe('night')
  })
  it('without photos the dashboard stays up', () => {
    expect(nextMode('photos', O, at('10:00'), 9999, 0, false)).toBe('day')
    expect(nextMode('day', O, at('10:00'), 9999, 9999, false)).toBe('day')
    expect(nextMode('night', O, at('06:00'), 9999, 9999, false)).toBe('day')
  })
  it('night lasts until morning, then the slideshow; a tap at night dims, then returns after 20 s', () => {
    expect(nextMode('night', O, at('05:59'), 9999, 9999)).toBe('night')
    expect(nextMode('night', O, at('06:00'), 9999, 9999)).toBe('photos')
    expect(nextMode('nightdash', O, at('23:00'), NIGHTDASH_IDLE_SEC - 1, 0)).toBe('nightdash')
    expect(nextMode('nightdash', O, at('23:00'), NIGHTDASH_IDLE_SEC, 0)).toBe('night')
    expect(nextMode('nightdash', O, at('06:00'), 0, 0)).toBe('day')
  })
})

describe('boot', () => {
  it('boots straight into what the rules want (no bright idleSec first)', () => {
    expect(bootMode(O, at('03:00'))).toBe('night')
    expect(bootMode(O, at('10:00'))).toBe('photos')
    expect(bootMode(O, at('17:00'))).toBe('photos')
    expect(bootMode(O, at('17:00'), false)).toBe('day')
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
    expect(bootMode(O, time.parts(new Date('2026-03-09T10:30:00Z')))).toBe('photos')
  })
})
