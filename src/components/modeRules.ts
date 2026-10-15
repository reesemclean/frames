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

/** Where the screen goes when nobody's looking: night, else the slideshow
 * (or the dashboard while there are no photos to show). */
function rest(o: Opts, p: When, hasPhotos: boolean): Mode {
  return isNight(o, p) ? 'night' : hasPhotos ? 'photos' : 'day'
}

/**
 * What the screen should be doing right now, from `mode`, after `idle`
 * seconds untouched and `inMode` seconds in this mode. The slideshow is home;
 * every dashboardEverySec it stops on the dashboard for dashboardForSec. A
 * tap brings the dashboard up until idleSec without one.
 */
export function nextMode(mode: Mode, o: Opts, p: When, idle: number, inMode: number, hasPhotos = true): Mode {
  const n = isNight(o, p)
  switch (mode) {
    case 'day':
      // A tap holds the dashboard for idleSec. A scheduled visit has no
      // recent touch, so it ends after dashboardForSec.
      if (idle < o.photos.idleSec) return 'day'
      if (inMode < o.photos.dashboardForSec && !n) return 'day'
      return rest(o, p, hasPhotos)
    case 'photos':
      if (n) return 'night'
      if (!hasPhotos || inMode >= o.photos.dashboardEverySec) return 'day'
      return 'photos'
    case 'night':
      return n ? 'night' : rest(o, p, hasPhotos)
    case 'nightdash':
      return !n ? 'day' : idle >= NIGHTDASH_IDLE_SEC ? 'night' : 'nightdash'
  }
}

/**
 * The mode to boot into. Boot counts as idle: after the nightly reload (or any
 * night boot) the screen goes straight to what the rules want, with no bright
 * idleSec of dashboard first.
 */
export function bootMode(o: Opts, p: When, hasPhotos = true): Mode {
  return rest(o, p, hasPhotos)
}

/** ?mode=photos|night|nightdash|day (debug previews). */
export function forcedMode(search: string): Mode | null {
  const q = /[?&]mode=(photos|night|nightdash|day)\b/.exec(search)
  return q ? (q[1] as Mode) : null
}
