// The daily page reload that clears slow leaks. It runs on its own module
// timer, not in a component effect, so it survives a React tree that has
// crashed or unmounted: a broken frame still gets its fresh start at 03:00.
import * as time from './time'
import { idleSec } from './mode'

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

// The version check: every few minutes the frame asks the server for its
// dashboard's version, and reloads when it differs from the one in its page
// (a deploy, or an edited dashboard file). Only on a good answer: a failed
// fetch or a 502 mid-restart just waits for the next check. Only when nobody
// has touched the screen for a minute, so it never reloads under a finger.
const VERSION_EVERY_MS = 5 * 60_000
const VERSION_IDLE_SEC = 60
let versionTimer: ReturnType<typeof setInterval> | null = null

export function watchVersion(slug: string, version: string): void {
  if (versionTimer || !version || /[?&]at=/.test(location.search)) return
  let changed = false
  let lastCheck = Date.now()
  versionTimer = setInterval(() => {
    if (changed) {
      if (idleSec() >= VERSION_IDLE_SEC) location.reload()
      return
    }
    if (Date.now() - lastCheck < VERSION_EVERY_MS) return
    lastCheck = Date.now()
    fetch('/api/version/' + encodeURIComponent(slug), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { version?: unknown } | null) => {
        if (j && typeof j.version === 'string' && j.version !== version) changed = true
      })
      .catch(() => {})
  }, CHECK_MS)
}
