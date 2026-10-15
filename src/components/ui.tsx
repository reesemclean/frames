// Shared UI: toasts (with undo), modal sheets, press-and-hold.
// No alert()/confirm(): the kiosk has no handler for them.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

// ------------------------------------------------------------------ toasts
interface ToastOpts { ms?: number; undo?: () => void; tone?: 'ok' | 'warn' }
interface ToastItem extends ToastOpts { id: number; html: ReactNode }
interface SheetItem { node: ReactNode; onClose?: () => void; full?: boolean }

interface UI {
  /** One toast at a time; the undo button runs `undo` once. */
  toast: (content: ReactNode, opts?: ToastOpts) => void
  /** A modal card, or with `full` the whole stage (a widget's detail view,
   * closed by a tap anywhere). Returns close(). The photos and night modes
   * close it. */
  sheet: (node: ReactNode, opts?: { onClose?: () => void; full?: boolean }) => () => void
  closeSheet: () => void
}

const Ctx = createContext<UI | null>(null)
export function useUI(): UI {
  const ui = useContext(Ctx)
  if (!ui) throw new Error('useUI outside <UIProvider>')
  return ui
}

let nextId = 1

export function UIProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null)
  const [sheet, setSheet] = useState<SheetItem | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sheetRef = useRef<SheetItem | null>(null)
  sheetRef.current = sheet

  const showToast = useCallback((html: ReactNode, opts: ToastOpts = {}) => {
    if (timer.current) clearTimeout(timer.current)
    const id = nextId++
    setToast({ id, html, ...opts })
    timer.current = setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), opts.ms || 5000)
  }, [])

  const closeSheet = useCallback(() => {
    const s = sheetRef.current
    if (!s) return
    setSheet(null)
    s.onClose?.()
  }, [])

  const showSheet = useCallback((node: ReactNode, opts: { onClose?: () => void; full?: boolean } = {}) => {
    setSheet({ node, onClose: opts.onClose, full: opts.full })
    return closeSheet
  }, [closeSheet])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const ui: UI = { toast: showToast, sheet: showSheet, closeSheet }
  return (
    <Ctx.Provider value={ui}>
      {children}
      <div className="toasts" aria-live="polite">
        {toast && (
          <div key={toast.id} className={'toast' + (toast.tone ? ' toast--' + toast.tone : '')}>
            <span className="toast-msg">{toast.html}</span>
            {toast.undo && (
              <button
                className="toast-undo"
                type="button"
                onClick={() => {
                  const undo = toast.undo
                  setToast(null)
                  undo?.()
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
      <div className={'sheet-layer' + (sheet ? ' is-open' : '')}>
        {sheet && (
          <>
            <div className="sheet-scrim" onClick={closeSheet} />
            {/* Full: no ×, a tap anywhere closes it. */}
            <div className={'sheet' + (sheet.full ? ' is-full' : '')} onClick={sheet.full ? closeSheet : undefined}>
              {!sheet.full && <button className="sheet-x" type="button" aria-label="Close" onClick={closeSheet}>×</button>}
              {sheet.node}
            </div>
          </>
        )}
      </div>
    </Ctx.Provider>
  )
}

// ------------------------------------------------------------------ hold
// Which pointers are down anywhere on the page, shared by every useHold: one
// hand on each kid's panel must not be two holds. On window, capture phase,
// so it sees every contact before React does, including the ones Modes
// swallows (it stops propagation there, which leaves other window listeners
// running).
const pointersDown = new Set<number>()
const activeHolds = new Set<() => void>()

/** A pointer went down; false when another is already down (cancels every active hold). */
export function pointerDown(id: number, isPrimary: boolean): boolean {
  // A primary touch means no other touch is down, so this also drops any id
  // whose pointerup never arrived.
  if (isPrimary) pointersDown.clear()
  pointersDown.add(id)
  if (pointersDown.size === 1) return true
  activeHolds.forEach((stop) => stop())
  return false
}
export function pointerUp(id: number): void { pointersDown.delete(id) }
/** True when `id` is the only pointer down: a hold may arm, or complete. */
export function onlyPointer(id: number): boolean { return pointersDown.size === 1 && pointersDown.has(id) }

let tracking = false
function trackPointers() {
  if (tracking) return
  tracking = true
  const opts = { capture: true, passive: true }
  window.addEventListener('pointerdown', (e) => { pointerDown(e.pointerId, e.isPrimary) }, opts)
  window.addEventListener('pointerup', (e) => pointerUp(e.pointerId), opts)
  window.addEventListener('pointercancel', (e) => pointerUp(e.pointerId), opts)
}

/**
 * Press and hold for `ms` to fire done(); a quick tap does nothing (calls
 * tap() if given). Spread the returned props onto the element and give it
 * the `holdable` class for the filling ring (base.css).
 *
 * One finger on the whole page: a hold arms only when no other pointer is
 * down, and a second finger anywhere cancels every hold, so a two-finger tap
 * or hold (on one panel or across two) can't award at all. Android WebView
 * cancels a long touch with pointercancel unless the element opts out of
 * panning, text selection and the long-press callout, so the style sets all
 * three.
 */
export function useHold(ms: number, cb: { done: () => void; tap?: (e: React.PointerEvent) => void; enabled?: () => boolean }) {
  const cbRef = useRef(cb)
  cbRef.current = cb
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useRef<number | null>(null)
  const [holding, setHolding] = useState(false)

  // `kill` is this hook's one entry in activeHolds: stable across renders,
  // so stop() always removes what onPointerDown added.
  const stopRef = useRef<() => void>(() => {})
  const [kill] = useState(() => () => stopRef.current())
  const stop = () => {
    if (t.current) clearTimeout(t.current)
    t.current = null
    id.current = null
    activeHolds.delete(kill)
    setHolding(false)
  }
  stopRef.current = stop
  useEffect(() => {
    trackPointers()
    return () => { if (t.current) clearTimeout(t.current); activeHolds.delete(kill) }
  }, [kill])

  const cancel = (e: React.PointerEvent) => {
    if (!t.current || e.pointerId !== id.current) return
    stop()
    if (e.type === 'pointerup') cbRef.current.tap?.(e)
  }

  return {
    holding,
    props: {
      style: {
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        ['--hold' as string]: ms + 'ms',
      } as React.CSSProperties,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (t.current) { stop(); return }
        const c = cbRef.current
        if (e.button !== 0 || (c.enabled && !c.enabled())) return
        // The window tracker ran first, so this pointer is already counted.
        if (!onlyPointer(e.pointerId)) return
        const pid = e.pointerId
        id.current = pid
        try { e.currentTarget.setPointerCapture(pid) } catch { /* fine */ }
        setHolding(true)
        activeHolds.add(kill)
        t.current = setTimeout(() => {
          const ok = onlyPointer(pid) && (!cbRef.current.enabled || cbRef.current.enabled())
          stop()
          if (ok) cbRef.current.done()
        }, ms)
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    },
  }
}
