// The daily page reload that clears slow leaks. It runs on its own module
// timer, not in a component effect, so it survives a React tree that has
// crashed or unmounted: a broken frame still gets its fresh start at 03:00.
import * as time from './time'

// Never in the first 10 minutes, so a frame booting at 03:00 can't loop.
const MIN_UPTIME_MS = 600_000
const CHECK_MS = 30_000
const loadedAt = Date.now()

/** Minutes since midnight for `reloadAt`; the default when the option is malformed. */
export function reloadMinute(reloadAt: unknown): number {
  try {
    const m = time.hm(reloadAt as string)
    if (Number.isFinite(m) && m >= 0 && m < 1440) return m
  } catch { /* not a string: fall through */ }
  return time.hm('03:00')
}

/** Is it time to reload? `nowMins` is zone-local (time.parts().mins). */
export function shouldReload(nowMins: number, reloadAt: unknown, uptimeMs: number): boolean {
  return uptimeMs > MIN_UPTIME_MS && nowMins === reloadMinute(reloadAt)
}

let reloadAt: unknown = '03:00'
let timer: ReturnType<typeof setInterval> | null = null

/** Start (once) or retarget the daily reload. Never in a ?at= preview. */
export function scheduleDailyReload(at: unknown): void {
  reloadAt = at
  if (timer || /[?&]at=/.test(location.search)) return
  // Checked twice a minute so the 03:00 minute is never skipped. time.parts()
  // is the real clock here (no ?at= offset), in the household zone.
  timer = setInterval(() => {
    if (shouldReload(time.parts().mins, reloadAt, Date.now() - loadedAt)) location.reload()
  }, CHECK_MS)
}
