// Stars: one star chart per kid. A grown-up presses and holds anywhere on a
// kid's panel (~1 s) to give the next star; a quick tap only shows a hint, so
// a passing child can't award one. Undo sits in the toast for 8 s. At the
// target the panel turns into a done state with a hold-to-start-a-new-chart
// button.
//
// Counts live on the server (/api/stars), so every frame agrees; this polls
// every 20 s and refreshes right after its own writes. Each kid's panel is
// memoized on its own data, so a poll that changes nothing re-renders
// nothing, and a star for one kid doesn't re-render the other. Two panels
// sit side by side or stack, whichever gives bigger stars in this cell.
// Options: none.
//
// SSR: there's no data on the server or on the first client render (the
// query isn't prefetched), so both render the same calm placeholder and
// hydration matches; the data arrives after mount.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { WidgetProps } from '.'
import type { Envelope, Kid, Stars } from '~/lib/types'
import { send, staleNote, usePoll, type SendError } from '~/lib/api'
import { useHold, useUI } from '~/components/ui'

const PATH = '/api/stars'
const POLL_MS = 20_000
const HOLD_MS = 1000
const UNDO_TOAST_MS = 8000
const HINT_MS = 2500
const COLOR = /^#[0-9a-fA-F]{6}$/

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
// Light kid colours (yellow, lime) are unreadable as text on the card; darken them.
function textColor(hex: string): string {
  const [r, g, b] = rgb(hex)
  if ((0.299 * r + 0.587 * g + 0.114 * b) / 255 <= 0.5) return hex
  return 'rgb(' + Math.round(r * 0.6) + ',' + Math.round(g * 0.6) + ',' + Math.round(b * 0.6) + ')'
}

const kidSig = (k: Kid) =>
  k.id + ':' + k.name + ':' + k.color + ':' + k.chart.id + ':' + k.chart.count + ':' + k.chart.target + ':' + k.chart.done + ':' + k.chart.goal

type Toast = ReturnType<typeof useUI>['toast']
interface Actions {
  toast: Toast
  /** A write returned fresh kids: show them now, then refetch. */
  wrote: (kids: Kid[]) => void
  refresh: () => void
}

export function StarsWidget(_: WidgetProps) {
  const state = usePoll<Stars>(PATH, POLL_MS)
  const qc = useQueryClient()
  const { toast } = useUI()
  const kids = state.data ? state.data.kids : null

  // A poll that left before our write landed would briefly undo it on
  // screen. setQueryData shows the write's own answer at once, and
  // invalidateQueries cancels any in-flight poll (getJSON honours the
  // signal) and fetches again, after the write.
  const actions = useRef<Actions | null>(null)
  if (!actions.current) {
    const refresh = () => { void qc.invalidateQueries({ queryKey: [PATH] }) }
    actions.current = {
      toast,
      refresh,
      wrote: (list) => {
        const env: Envelope<Stars> = { data: { kids: list }, updated: Date.now(), stale: false, error: null }
        qc.setQueryData([PATH], env)
        refresh()
      },
    }
  }

  const box = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ row: true, name: 34, goal: 24 })
  const shape = useRef({ n: 0, maxT: 1 })
  shape.current = {
    n: kids ? kids.length : 0,
    maxT: kids ? kids.reduce((m, k) => Math.max(m, k.chart.target), 1) : 1,
  }
  const shapeKey = shape.current.n + ':' + shape.current.maxT

  // Side by side or stacked: whichever gives each star more room. Star size
  // itself is CSS (each slot shares the row; the SVG fits it).
  const fit = useCallback(() => {
    const el = box.current
    if (!el) return
    const W = el.clientWidth, H = el.clientHeight
    const { n, maxT } = shape.current
    if (!W || !H || !n) return // hidden (photos/night mode): keep the last layout
    const chrome = 110 // name/goal above, count/button below
    const side = Math.min(W / n / maxT, H - chrome)
    const stack = Math.min(W / maxT, H / n - chrome)
    const row = n === 1 || side >= stack
    const ph = row ? H : H / n
    const name = Math.round(Math.max(22, Math.min(44, ph * 0.12)))
    const goal = Math.round(Math.max(18, Math.min(32, ph * 0.09)))
    setLayout((l) => (l.row === row && l.name === name && l.goal === goal ? l : { row, name, goal }))
  }, [])

  useLayoutEffect(fit, [shapeKey, fit])
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  const style = { '--st-name': layout.name + 'px', '--st-goal': layout.goal + 'px' } as CSSProperties
  return (
    <div className="card st" style={style}>
      <div ref={box} className={'st-kids ' + (layout.row ? 'is-row' : 'is-col')}>
        {kids == null ? (
          <div className="st-empty">Loading star charts…</div>
        ) : kids.length === 0 ? (
          <div className="st-empty">No star charts yet. A grown-up can add kids on the admin page.</div>
        ) : (
          kids.map((k) => <KidPanel key={k.id} kid={k} actions={actions.current!} />)
        )}
      </div>
      <div className="stale st-stale">{staleNote(state)}</div>
    </div>
  )
}

const STAR_PATH = 'M12 2.6l2.85 5.95 6.55.85-4.8 4.55 1.25 6.5L12 17.3l-5.85 3.15 1.25-6.5-4.8-4.55 6.55-.85z'
const StarSvg = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={STAR_PATH} /></svg>
)

const KidPanel = memo(function KidPanel({ kid, actions }: { kid: Kid; actions: Actions }) {
  const c = kid.chart
  const count = Math.min(c.count, c.target)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [hint, setHint] = useState(false)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current) }, [])

  // Pop the stars that just arrived, and cheer once when the chart
  // completes. Not on the first render: a frame booting up shows the
  // current count without fanfare. Layout effect, so a new star never
  // flashes full before its pop starts.
  const prev = useRef<{ chart: number; count: number; done: boolean } | null>(null)
  const [pop, setPop] = useState<{ from: number; to: number } | null>(null)
  const [cheer, setCheer] = useState(false)
  useLayoutEffect(() => {
    const p = prev.current
    prev.current = { chart: c.id, count, done: c.done }
    if (!p) return
    if (p.chart === c.id && count > p.count) setPop({ from: p.count, to: count })
    else if (p.chart !== c.id || count < p.count) setPop(null)
    if (c.done && !p.done) setCheer(true)
    if (!c.done) setCheer(false)
  }, [c.id, count, c.done])

  // Hints are inline, never a toast: a stray tap right after the last star
  // must not replace the toast holding its Undo. In the done state the
  // panel's own hint is hidden, so the button label carries it.
  const showHint = () => {
    setHint(true)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(false), HINT_MS)
  }

  const kidUrl = PATH + '/' + encodeURIComponent(kid.id)
  const name = kid.name

  async function takeBack(awardId: string) {
    try {
      const res = await send<{ kids: Kid[] }>('DELETE', PATH + '/awards/' + encodeURIComponent(awardId))
      actions.wrote(res.kids)
      actions.toast(<>Took back {name}’s star</>, { ms: 3000 })
    } catch (e) {
      // 409: already undone (maybe from another frame), or too late to undo.
      actions.toast((e as SendError).status === 409 ? 'That star can’t be undone now' : 'Couldn’t undo that star', { tone: 'warn', ms: 4000 })
      actions.refresh()
    }
  }

  async function give() {
    busy.current = true
    setPending(true)
    let res: { award: { id: string; at: number }; kids: Kid[] }
    try {
      res = await send('POST', kidUrl + '/award')
    } catch (e) {
      // No optimistic star is left behind: the pending one just clears.
      busy.current = false
      setPending(false)
      // 409: another frame already finished this chart.
      actions.toast((e as SendError).status === 409 ? 'That chart is already full' : 'Couldn’t save — try again', { tone: 'warn', ms: 4000 })
      actions.refresh()
      return
    }
    busy.current = false
    setPending(false)
    actions.wrote(res.kids)
    const now = res.kids.filter((k) => k.id === kid.id)[0]
    const nc = now && now.chart
    const awardId = res.award.id
    actions.toast(
      nc && nc.done
        ? <><b>{name}</b> did it! · {nc.target} of {nc.target}</>
        : <>Star for <b>{name}</b>{nc ? ' · ' + nc.count + ' of ' + nc.target : ''}</>,
      { tone: 'ok', ms: UNDO_TOAST_MS, undo: () => { void takeBack(awardId) } },
    )
  }

  async function restart() {
    busy.current = true
    try {
      // fromChart: the server refuses (409) if this done chart is no longer
      // the open one, so a stale frame can't close a chart just started.
      const res = await send<{ kids: Kid[] }>('POST', kidUrl + '/new-chart', { fromChart: c.id })
      busy.current = false
      actions.wrote(res.kids)
      actions.toast(<>New chart for <b>{name}</b></>, { tone: 'ok', ms: 4000 })
    } catch (e) {
      busy.current = false
      actions.toast((e as SendError).status === 409 ? 'A new chart already started' : 'Couldn’t save — try again', { tone: 'warn', ms: 4000 })
      actions.refresh()
    }
  }

  const giveHold = useHold(HOLD_MS, {
    enabled: () => !busy.current && !c.done,
    done: () => { void give() },
    tap: showHint,
  })
  const newHold = useHold(HOLD_MS, {
    enabled: () => !busy.current && c.done,
    done: () => { void restart() },
    tap: showHint,
  })

  const color = COLOR.test(kid.color) ? kid.color : '#3b82f6'
  const [r, g, b] = rgb(color)
  const style = {
    ...giveHold.props.style,
    '--c': color,
    '--c-text': textColor(color),
    '--c-soft': 'rgba(' + r + ',' + g + ',' + b + ',.14)',
  } as CSSProperties

  const cls = ['st-kid']
  if (giveHold.holding) cls.push('is-holding')
  if (hint) cls.push('is-hint')
  if (c.done) cls.push('is-done')
  if (cheer) cls.push('is-cheer')

  const slots = []
  for (let i = 0; i < c.target; i++) {
    const s = ['st-slot']
    if (i < count) s.push('is-on')
    if (i === count && !c.done) s.push('is-next')
    if (pending && i === count) s.push('is-pending')
    if (pop && i >= pop.from && i < pop.to && i < count) s.push('is-new')
    slots.push(<div key={i} className={s.join(' ')}><StarSvg /></div>)
  }

  // The button sits inside the panel: its own pointerdown mustn't also start
  // the panel's hold (the panel's enabled() is false when done, but don't
  // rely on that alone).
  const btnProps = {
    ...newHold.props,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => { e.stopPropagation(); newHold.props.onPointerDown(e) },
  }

  return (
    <div className={cls.join(' ')} {...giveHold.props} style={style}>
      <div className="st-head">
        <div className="st-name">{name}</div>
        <div className="st-goal serif">{c.goal}</div>
      </div>
      <div className="st-donehead">
        <div className="st-yay serif">{name} did it!</div>
        <div className="st-sub">{c.target}/{c.target} · {c.goal}</div>
      </div>
      <div className="st-row">{slots}</div>
      <div className="st-foot">
        <span className="st-count num">{count} of {c.target}</span>
        <span className="st-hint">Hold to give a star</span>
        <span className="st-bar" />
      </div>
      <div className="st-donefoot">
        <button className={'st-new' + (newHold.holding ? ' is-holding' : '')} type="button" {...btnProps}>
          <span>{hint && c.done ? 'Press and hold for a second' : 'Hold to start a new chart'}</span>
        </button>
      </div>
    </div>
  )
}, (a, b) => a.actions === b.actions && kidSig(a.kid) === kidSig(b.kid))
