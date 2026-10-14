// The frame's mode and idle time, readable from any component.
//   day       the dashboard
//   photos    full-screen slideshow (inside a photo window, after idle)
//   night     dim red clock (inside the night window, after idle)
//   nightdash the dashboard, dimmed, after a tap at night
import { useSyncExternalStore } from 'react'

export type Mode = 'day' | 'photos' | 'night' | 'nightdash'

let mode: Mode = 'day'
const subs = new Set<() => void>()
let lastTouch = Date.now()

export function getMode(): Mode { return mode }
export function setMode(m: Mode): void {
  if (m === mode) return
  mode = m
  subs.forEach((f) => f())
}
export function onMode(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } }
export function useMode(): Mode {
  return useSyncExternalStore(onMode, getMode, () => 'day' as Mode)
}

export function touched(): void { lastTouch = Date.now() }
/** Seconds since the last touch anywhere on the page. */
export function idleSec(): number { return (Date.now() - lastTouch) / 1000 }
/** Treat the page as idle since `sec` seconds ago (boot: no one is touching it). */
export function backdateTouch(sec: number): void { lastTouch = Date.now() - sec * 1000 }
