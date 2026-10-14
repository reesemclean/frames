// One ticker for the whole page. Components subscribe to the minute (most)
// or the second (only what shows seconds), so a tick re-renders only them.
import { useSyncExternalStore } from 'react'
import * as time from './time'

type Fn = () => void
const minuteSubs = new Set<Fn>()
const secondSubs = new Set<Fn>()
let minute: time.Parts | null = null
let second = 0
let started = false

function tick() {
  second = Date.now()
  secondSubs.forEach((f) => f())
  const p = time.parts()
  if (!minute || p.mins !== minute.mins || p.key !== minute.key) {
    minute = p
    minuteSubs.forEach((f) => f())
  }
}

/** Start ticking, aligned to the second boundary. Called once by <Frame>. */
export function startClock(): void {
  if (started) return
  started = true
  tick()
  setTimeout(() => { tick(); setInterval(tick, 1000) }, 1000 - (Date.now() % 1000))
}

/** Re-evaluate now (after time.setOffset for ?at= previews). */
export function retick(): void { minute = null; tick() }

export function onMinute(fn: Fn): () => void { minuteSubs.add(fn); return () => { minuteSubs.delete(fn) } }
export function onSecond(fn: Fn): () => void { secondSubs.add(fn); return () => { secondSubs.delete(fn) } }

/** Zone-local parts, updated once a minute. */
// Snapshots must be stable between calls (React re-reads them during
// hydration). On the client the ticker owns `minute`; on the server nothing
// ticks, so the server snapshot is cached per wall minute instead (module
// state outlives a request there, so it must never freeze).
let serverMinute: time.Parts | null = null
function serverParts(): time.Parts {
  const p = time.parts()
  if (!serverMinute || serverMinute.key !== p.key || serverMinute.mins !== p.mins) serverMinute = p
  return serverMinute
}
function clientMinute(): time.Parts {
  if (!minute) {
    const p = time.parts(), h = hydrationMinute
    // Same minute as the server's: keep its object, so hydration's check
    // finds nothing changed and nothing re-renders on the slow boot.
    minute = h && h.key === p.key && h.mins === p.mins ? h : p
  }
  return minute
}

// Hydration must render the minute the server rendered, not the frame's own:
// the two can straddle a boundary (a boot at 11:59:59), and React keeps a
// mismatched text node as the server wrote it, so "AM" or yesterday's date
// would stay up until that value next changed. Every time-text consumer
// writes stampMinute(p) into a data-minute attribute; the client's server
// snapshot is read back from the first one. useSyncExternalStore then sees
// the live minute differ and re-renders, which patches the text.
export function stampMinute(p: time.Parts): string { return p.key + '|' + p.mins }
export function parseStamp(s: string | null | undefined): time.Parts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\|(\d{1,4})$/.exec(s || '')
  if (!m || +m[4] >= 1440) return null
  const key = m[1] + '-' + m[2] + '-' + m[3], mins = +m[4]
  return { y: +m[1], mo: +m[2], d: +m[3], h: Math.floor(mins / 60), mi: mins % 60, s: 0, dow: time.dowOf(key), key, mins }
}
let hydrationMinute: time.Parts | null | undefined
// Read once and cached: the snapshot must be the same object on every call.
function hydrationParts(): time.Parts {
  if (hydrationMinute === undefined) {
    hydrationMinute = parseStamp(document.querySelector('[data-minute]')?.getAttribute('data-minute'))
  }
  return hydrationMinute || clientMinute()
}

export function useMinute(): time.Parts {
  return useSyncExternalStore(onMinute, clientMinute, typeof window === 'undefined' ? serverParts : hydrationParts)
}

/** Epoch ms, updated every second. Use sparingly. */
export function useSecond(): number {
  const snap = () => second || (second = Date.now())
  return useSyncExternalStore(onSecond, snap, typeof window === 'undefined' ? () => Math.floor(Date.now() / 1000) * 1000 : snap)
}
