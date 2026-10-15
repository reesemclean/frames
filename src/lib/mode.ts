// The frame's mode and idle time, readable from any component.
//   day       the dashboard (after a tap, and on a schedule)
//   photos    full-screen slideshow, the home screen outside night hours
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

// A widget asking for a mode (the photos widget's tap starts the slideshow).
// <Modes> owns the switch and registers itself here.
let requester: ((m: Mode) => void) | null = null
export function onRequestMode(fn: (m: Mode) => void): () => void {
  requester = fn
  return () => { if (requester === fn) requester = null }
}
export function requestMode(m: Mode): void { if (requester) requester(m) }

export function touched(): void { lastTouch = Date.now() }
/** Seconds since the last touch anywhere on the page. */
export function idleSec(): number { return (Date.now() - lastTouch) / 1000 }
/** Treat the page as idle since `sec` seconds ago (boot: no one is touching it). */
export function backdateTouch(sec: number): void { lastTouch = Date.now() - sec * 1000 }
