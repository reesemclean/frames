// Weather: now, the next 24 hours, the next 7 days (°F).
//   <section data-widget="weather" data-show="current,hourly,daily"></section>
// The layout comes from the cell's size: a wide, short cell lays the parts
// side by side; a taller one stacks them. Parts that don't fit are dropped
// from the end of data-show rather than squeezed.
//
// A tap opens the full-screen view: the same widget at the size of the
// stage, with every part.
//
// Hydration: the server can't know the cell's size and has no data (the poll
// runs in the browser), so the server render and the first client render are
// both the same calm placeholder. The real layout follows once the cell is
// measured after mount and the first poll lands.
import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { WidgetProps } from '.'
import { list } from '.'
import { usePoll, staleNote, type PollState } from '~/lib/api'
import { onMinute } from '~/lib/clock'
import * as time from '~/lib/time'
import type { Weather as WeatherData } from '~/lib/types'
import { WxIcon } from './icons'
import { useUI } from '~/components/ui'

const WET = 50 // % at which an hour/day reads as "wet" (blue icon)
const SHOW_POP = 20
const PARTS = ['current', 'hourly', 'daily'] as const
type Part = (typeof PARTS)[number]
const POLL_MS = 5 * 60_000

// The card's padding (its clientWidth includes padding, not border).
const CARD_PAD = 48
// What each part needs, in px, to be worth showing.
const MIN: Record<'row' | 'col', Record<Part, number>> = {
  row: { current: 220, hourly: 330, daily: 420 }, // widths, side by side
  col: { current: 110, hourly: 112, daily: 210 }, // heights, stacked
}
const GAP = { row: 28, col: 20 }

type Dir = 'row' | 'col'
interface Size { w: number; h: number }

/** Which parts fit, and how they're arranged. */
function plan(want: Part[], w: number, h: number): { dir: Dir; parts: Part[] } {
  const dir: Dir = w >= h * 2.2 ? 'row' : 'col'
  const room = dir === 'row' ? w : h
  const parts: Part[] = []
  let used = 0
  for (const p of want) {
    const need = MIN[dir][p] + (parts.length ? GAP[dir] : 0)
    if (used + need > room) continue
    parts.push(p)
    used += need
  }
  if (!parts.length) parts.push(want[0] || 'current')
  return { dir, parts }
}

/** "YYYY-MM-DDTHH" in the household zone; changes once an hour, so only
 * the hour rolling over re-renders the widget. */
function hourKey(): string {
  const p = time.parts()
  return p.key + 'T' + (p.h < 10 ? '0' : '') + p.h
}
function useHourKey(): string {
  return useSyncExternalStore(onMinute, hourKey, hourKey)
}
// A string snapshot (compared by value), so React sees a stable value
// between ticks, on the server and during hydration alike.
function minuteKey(): string {
  const p = time.parts()
  return p.key + ' ' + p.mins
}

interface View {
  cur: Partial<WeatherData['current']>
  today: WeatherData['today']
  hourly: WeatherData['hourly']
  daily: WeatherData['daily']
}

// Drop what's already past: the poll can be minutes old and the hour may have rolled.
function slice(data: WeatherData, hk: string): View {
  const nowKey = hk.slice(0, 10), nowMins = Number(hk.slice(11)) * 60
  const hourly = (data.hourly || []).filter((x) => x.key > nowKey || (x.key === nowKey && x.mins >= nowMins))
  const daily = (data.daily || []).filter((x) => x.key >= nowKey)
  const today = daily.length && daily[0].key === nowKey ? daily[0] : data.today
  return { cur: data.current || {}, today, hourly, daily }
}

export function Weather({ opts }: WidgetProps) {
  const want = useMemo(
    () => list(opts.show, PARTS as unknown as string[]).filter((p): p is Part => (PARTS as readonly string[]).indexOf(p) >= 0),
    [opts.show],
  )
  const state = usePoll<WeatherData>('/api/weather', POLL_MS)
  const ui = useUI()
  const open = opts.full === 'true' ? undefined : () => ui.sheet(<WeatherFull />, { full: true })
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size | null>(null)

  // Measure after mount and whenever the cell changes size. A cell measured
  // while hidden (0×0) keeps its last real size.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth - CARD_PAD, h = el.clientHeight - CARD_PAD
      if (w <= 0 || h <= 0) return
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="card wx-card" ref={ref} onClick={open}>
      <Body want={want} data={state.data} size={size} />
      <StaleNote state={state} />
    </div>
  )
}

function WeatherFull() {
  return (
    <>
      <div className="label full-title">Weather</div>
      <div className="full-body is-fill"><Weather opts={{ show: 'current,hourly,daily', full: 'true' }} /></div>
    </>
  )
}

// Only this re-renders every minute (for "updated 12 min ago").
function StaleNote({ state }: { state: PollState<unknown> }) {
  useSyncExternalStore(onMinute, minuteKey, minuteKey)
  return <div className="stale wx-stale">{staleNote(state)}</div>
}

const Body = memo(function Body({ want, data, size }: { want: Part[]; data: WeatherData | null; size: Size | null }) {
  const hk = useHourKey()
  const d = useMemo(() => (data ? slice(data, hk) : null), [data, hk])

  if (!size || !d) {
    return (
      <div className={'wx-body' + (size ? ' wx--' + plan(want, size.w, size.h).dir : '')}>
        <div className="wx-now"><div className="wx-now-main"><span className="wx-now-t num is-wait">—°</span></div></div>
      </div>
    )
  }

  const { w, h } = size
  const { dir, parts } = plan(want, w, h)
  const hasCur = parts.indexOf('current') >= 0
  // In a row, current gets its natural width and the rest share what's left.
  const others = parts.length - (hasCur ? 1 : 0)
  const restW = dir === 'row'
    ? (w - (hasCur ? MIN.row.current + GAP.row : 0) - GAP.row * (others - 1)) / Math.max(1, others)
    : w
  // Stacked: what current and hourly take, so the daily rows get the rest.
  const fixed = (hasCur ? (h >= 520 ? 170 : 130) + 20 : 0) + (parts.indexOf('hourly') >= 0 ? 112 + 20 : 0)

  return (
    <div className={'wx-body wx--' + dir + ' wx-n' + parts.length}>
      {parts.map((p) => {
        if (p === 'current') return <Current key={p} d={d} big={dir === 'col' && h >= 520 && w >= 380} />
        if (p === 'hourly') return <Hourly key={p} d={d} w={restW} />
        if (dir === 'row') return <DailyCols key={p} d={d} />
        return <DailyRows key={p} d={d} h={h - fixed} />
      })}
    </div>
  )
})

function Current({ d, big }: { d: View; big: boolean }) {
  const c = d.cur, t = d.today
  return (
    <div className={'wx-now' + (big ? ' is-big' : '')}>
      <div className="wx-now-main">
        <span className={'wx-now-ic' + (c.icon === 'sun' ? ' is-sun' : '')}><WxIcon name={c.icon || 'cloud'} size={big ? 84 : 60} /></span>
        <span className="wx-now-t num">{c.temp == null ? '—' : c.temp}°</span>
      </div>
      <div className="wx-now-side">
        <div className="wx-now-l">{c.label || ''}</div>
        <div className="wx-now-hl">
          {t && <><span>H <b className="num">{t.hi}°</b></span><span>L <b className="num">{t.lo}°</b></span></>}
        </div>
        {c.feels != null && c.feels !== c.temp && <div className="wx-now-f">Feels like <b className="num">{c.feels}°</b></div>}
        {t && t.pop >= SHOW_POP && <div className="wx-now-p">{t.pop}% chance of rain</div>}
      </div>
    </div>
  )
}

function Hourly({ d, w }: { d: View; w: number }) {
  const hrs = d.hourly
  if (!hrs.length) return <div className="wx-hours is-empty" />
  const fit = Math.max(1, Math.floor(w / 58))
  // Every hour if that still covers half a day, else every other hour.
  const step = fit >= 12 ? 1 : 2
  const cols: typeof hrs = []
  for (let i = 0; i < hrs.length && cols.length < fit && i < 24; i += step) cols.push(hrs[i])
  return (
    <div className="wx-hours">
      {cols.map((x, i) => (
        <div key={x.key + x.mins} className={'wx-hr' + (i === 0 ? ' is-now' : '')}>
          <span className="wx-hr-t">{i === 0 ? 'Now' : time.hourLabel(x.mins)}</span>
          <span className={'wx-ic' + (x.pop >= WET ? ' is-wet' : '')}><WxIcon name={x.icon} size={30} /></span>
          <span className="wx-hr-temp num">{x.temp}°</span>
          <span className="wx-pop">{x.pop >= SHOW_POP ? x.pop + '%' : ''}</span>
        </div>
      ))}
    </div>
  )
}

function dayName(x: { dow: number }, i: number): string {
  return i === 0 ? 'Today' : time.names.dayShort(x.dow)
}

// One temperature scale for the whole week, so bars compare across days.
function scale(days: { hi: number; lo: number }[]): (t: number) => number {
  let lo = Infinity, hi = -Infinity
  for (const x of days) { lo = Math.min(lo, x.lo); hi = Math.max(hi, x.hi) }
  const span = Math.max(1, hi - lo)
  return (t) => Math.max(0, Math.min(100, ((t - lo) / span) * 100))
}
const pc = (n: number) => n.toFixed(1) + '%'

// Columns (wide cell): day, icon, high, vertical bar, low.
function DailyCols({ d }: { d: View }) {
  const days = d.daily.slice(0, 7)
  if (!days.length) return <div className="wx-days is-empty" />
  const pct = scale(days)
  return (
    <div className="wx-days wx-days--cols">
      {days.map((x, i) => (
        <div key={x.key} className={'wx-dc' + (i === 0 ? ' is-today' : '')}>
          <span className="wx-dn">{dayName(x, i)}</span>
          <span className={'wx-ic' + (x.pop >= WET ? ' is-wet' : '')}><WxIcon name={x.icon} size={28} /></span>
          <span className="wx-dhi num">{x.hi}°</span>
          <span className="wx-vrange"><i style={{ bottom: pc(pct(x.lo)), top: pc(100 - pct(x.hi)) }} /></span>
          <span className="wx-dlo num">{x.lo}°</span>
        </div>
      ))}
    </div>
  )
}

// Rows (tall cell): day, icon, rain %, low, horizontal bar, high.
function DailyRows({ d, h }: { d: View; h: number }) {
  const days = d.daily.slice(0, 7)
  if (!days.length) return <div className="wx-days is-empty" />
  const pct = scale(days)
  const cur = d.cur.temp
  return (
    <div className={'wx-days wx-days--rows' + (h / 7 < 40 ? ' is-tight' : '')}>
      {days.map((x, i) => (
        <div key={x.key} className={'wx-dr' + (i === 0 ? ' is-today' : '')}>
          <span className="wx-dn">{dayName(x, i)}</span>
          <span className={'wx-ic' + (x.pop >= WET ? ' is-wet' : '')}><WxIcon name={x.icon} size={30} /></span>
          <span className="wx-pop">{x.pop >= SHOW_POP ? x.pop + '%' : ''}</span>
          <span className="wx-dlo num">{x.lo}°</span>
          <span className="wx-hrange">
            <i style={{ left: pc(pct(x.lo)), right: pc(100 - pct(x.hi)) }} />
            {i === 0 && cur != null && cur >= x.lo && cur <= x.hi && <b className="wx-cur" style={{ left: pc(pct(cur)) }} />}
          </span>
          <span className="wx-dhi num">{x.hi}°</span>
        </div>
      ))}
    </div>
  )
}
