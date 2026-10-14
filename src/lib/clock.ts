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
export function useMinute(): time.Parts {
  return useSyncExternalStore(onMinute, () => minute || (minute = time.parts()), () => minute || time.parts())
}

/** Epoch ms, updated every second. Use sparingly. */
export function useSecond(): number {
  return useSyncExternalStore(onSecond, () => second || Date.now(), () => second || Date.now())
}
