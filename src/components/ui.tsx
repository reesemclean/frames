// Shared UI: toasts (with undo), modal sheets, press-and-hold.
// No alert()/confirm(): the kiosk has no handler for them.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

// ------------------------------------------------------------------ toasts
interface ToastOpts { ms?: number; undo?: () => void; tone?: 'ok' | 'warn' }
interface ToastItem extends ToastOpts { id: number; html: ReactNode }
interface SheetItem { node: ReactNode; onClose?: () => void }

interface UI {
  /** One toast at a time; the undo button runs `undo` once. */
  toast: (content: ReactNode, opts?: ToastOpts) => void
  /** A modal card. Returns close(). */
  sheet: (node: ReactNode, opts?: { onClose?: () => void }) => () => void
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

  const showSheet = useCallback((node: ReactNode, opts: { onClose?: () => void } = {}) => {
    setSheet({ node, onClose: opts.onClose })
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
            <div className="sheet">
              <button className="sheet-x" type="button" aria-label="Close" onClick={closeSheet}>×</button>
              {sheet.node}
            </div>
          </>
        )}
      </div>
    </Ctx.Provider>
  )
}

// ------------------------------------------------------------------ hold
/**
 * Press and hold for `ms` to fire done(); a quick tap does nothing (calls
 * tap() if given). Spread the returned props onto the element and give it
 * the `holdable` class for the filling ring (base.css).
 *
 * One tracked finger: a second finger while holding cancels the gesture, so
 * a two-finger tap or hold can't award twice. Android WebView cancels a long
 * touch with pointercancel unless the element opts out of panning, text
 * selection and the long-press callout, so the style sets all three.
 */
export function useHold(ms: number, cb: { done: () => void; tap?: () => void; enabled?: () => boolean }) {
  const cbRef = useRef(cb)
  cbRef.current = cb
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useRef<number | null>(null)
  const [holding, setHolding] = useState(false)

  const stop = () => {
    if (t.current) clearTimeout(t.current)
    t.current = null
    id.current = null
    setHolding(false)
  }
  useEffect(() => () => { if (t.current) clearTimeout(t.current) }, [])

  const cancel = (e: React.PointerEvent) => {
    if (!t.current || e.pointerId !== id.current) return
    stop()
    if (e.type === 'pointerup') cbRef.current.tap?.()
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
        id.current = e.pointerId
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* fine */ }
        setHolding(true)
        t.current = setTimeout(() => {
          const ok = !cbRef.current.enabled || cbRef.current.enabled()
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
