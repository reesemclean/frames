// The rules behind <Modes>, kept pure so they can be tested without a page.
// Every decision reads zone-local parts (time.parts()), the household's
// zone, never the frame's own.
import type { DashboardOptions } from '~/lib/types'
import type { Mode } from '~/lib/mode'
import * as time from '~/lib/time'

/** After a tap at night, how long the dimmed dashboard stays up. */
export const NIGHTDASH_IDLE_SEC = 20

type Opts = Pick<DashboardOptions, 'night' | 'photos'>
type When = Pick<time.Parts, 'mins' | 'dow'>

export function isNight(o: Opts, p: When): boolean {
  return time.inWindow(p.mins, o.night.from, o.night.to)
}

export function inPhotoWindow(o: Opts, p: When): boolean {
  return (o.photos.windows || []).some((w) =>
    (!w.days || w.days.indexOf(p.dow) > -1) && time.inWindow(p.mins, w.from, w.to))
}

/** What the screen should be doing right now, from `mode`, after `idle` seconds untouched. */
export function nextMode(mode: Mode, o: Opts, p: When, idle: number): Mode {
  const n = isNight(o, p)
  switch (mode) {
    case 'day':
      if (idle < o.photos.idleSec) return 'day'
      return n ? 'night' : inPhotoWindow(o, p) ? 'photos' : 'day'
    case 'photos':
      return n ? 'night' : inPhotoWindow(o, p) ? 'photos' : 'day'
    case 'night':
      return n ? 'night' : 'day'
    case 'nightdash':
      return !n ? 'day' : idle >= NIGHTDASH_IDLE_SEC ? 'night' : 'nightdash'
  }
}

/**
 * The mode to boot into. Boot counts as idle: after the nightly reload (or any
 * night boot) the screen goes straight to what the rules want, with no bright
 * idleSec of dashboard first.
 */
export function bootMode(o: Opts, p: When): Mode {
  return isNight(o, p) ? 'night' : inPhotoWindow(o, p) ? 'photos' : 'day'
}

/** ?mode=photos|night|nightdash|day (debug previews). */
export function forcedMode(search: string): Mode | null {
  const q = /[?&]mode=(photos|night|nightdash|day)\b/.exec(search)
  return q ? (q[1] as Mode) : null
}
