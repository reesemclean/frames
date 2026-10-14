// Calendar: today's events, optionally followed by the coming days.
// Options:
//   data-days="1"      1 = today only (default); up to 7 = today + upcoming days
//   data-title="..."   optional heading
// The server sends zone-local day keys and minutes since midnight, so nothing
// here reads the frame's own clock zone. Rows are memoized: the per-minute
// tick only re-renders the rows whose past / now / next state changed.
// Nothing scrolls: rows that don't fit become "+N more" (past rows go first,
// quietly).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { WidgetProps } from '.'
import { num } from '.'
import type { Calendar, CalendarEvent } from '~/lib/types'
import { staleNote, usePoll, useRefresh } from '~/lib/api'
import { useMinute } from '~/lib/clock'
import * as time from '~/lib/time'

const PATH = '/api/calendar'
const POLL_MS = 120_000
const HEX = /^#[0-9a-fA-F]{6}$/

type Day = Calendar['days'][number]
type RowState = '' | 'past' | 'now' | 'next'

function tint(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return 'rgba(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')'
}

function colors(ev: CalendarEvent): CSSProperties {
  const c = HEX.test(ev.color || '') ? ev.color : '#7a756b'
  return { '--c': c, '--ct': tint(c, 0.14) } as CSSProperties
}

// "3:30 – 4:30 PM", "11 AM – 1 PM", "Until 1:30 AM", "From 10 PM"
function short(m: number): string {
  const h = Math.floor(m / 60) % 24, mi = m % 60
  return (h % 12 || 12) + (mi ? ':' + (mi < 10 ? '0' : '') + mi : '')
}
function range(ev: CalendarEvent): string {
  if (ev.allDay || ev.start == null || ev.end == null) return 'All day'
  if (ev.continued && (ev.continues || ev.end >= 1440)) return 'All day'
  if (ev.continued) return 'Until ' + time.hourLabel(ev.end)
  if (ev.continues) return 'From ' + time.hourLabel(ev.start)
  if (ev.end <= ev.start) return time.hourLabel(ev.start)
  return time.ampm(ev.start) === time.ampm(ev.end)
    ? short(ev.start) + ' – ' + time.hourLabel(ev.end)
    : time.hourLabel(ev.start) + ' – ' + time.hourLabel(ev.end)
}

/** past / now / next for today's timed rows at `now` (minutes since midnight). */
function states(rows: CalendarEvent[], now: number): RowState[] {
  let next = -1
  const out: RowState[] = rows.map((e, i) => {
    const start = e.start ?? 0
    const end = e.continues ? 1441 : e.end ?? start
    const past = end > start ? end <= now : start < now
    if (past) return 'past'
    if (start <= now) return 'now'
    if (next < 0 || start < (rows[next].start ?? 0)) next = i
    return ''
  })
  if (next >= 0) out[next] = 'next'
  return out
}

const Chip = memo(function Chip({ ev }: { ev: CalendarEvent }) {
  return <span className="cal-chip" style={colors(ev)}><i /><b>{ev.title}</b></span>
})

const TodayRow = memo(function TodayRow({ ev, state }: { ev: CalendarEvent; state: RowState }) {
  const meta = ev.location ? range(ev) + ' · ' + ev.location : range(ev)
  const cls = 'cal-ev' + (state === 'past' ? ' is-past' : state === 'now' ? ' is-now' : state === 'next' ? ' is-next' : '')
  return (
    <div className={cls} style={colors(ev)}>
      <i className="cal-bar" />
      <span className="cal-n"><b>{ev.title}</b><small>{meta}</small></span>
      <span className="cal-tag">{state === 'now' ? 'Now' : state === 'next' ? 'Next' : ''}</span>
    </div>
  )
})

const LaterRow = memo(function LaterRow({ ev }: { ev: CalendarEvent }) {
  return (
    <div className="cal-ev cal-ev--compact" style={colors(ev)}>
      <i className="cal-bar" />
      <span className="cal-t num">{range(ev)}</span>
      <span className="cal-n"><b>{ev.title}</b></span>
    </div>
  )
})

function DayLabel({ dayKey }: { dayKey: string }) {
  const p = dayKey.split('-').map(Number)
  return <div className="label cal-dh">{time.relDay(dayKey)}<small>{time.names.monthShort(p[1]) + ' ' + p[2]}</small></div>
}

/**
 * Hide rows until the body fits: past rows first (they're over), then from
 * the end. "+N more" counts hidden rows that haven't happened yet, plus
 * all-day chips clipped by the chip box's two-line limit. Done on the DOM
 * (style.display, which React never writes here) after each render, since it
 * depends on measured heights.
 */
function fit(body: HTMLElement, moreEl: HTMLElement): void {
  const rows = Array.prototype.slice.call(body.querySelectorAll('.cal-ev')) as HTMLElement[]
  const sections = Array.prototype.slice.call(body.querySelectorAll('.cal-day')) as HTMLElement[]
  rows.forEach((r) => { r.style.display = '' })
  sections.forEach((s) => { s.style.display = '' })
  moreEl.textContent = ''
  moreEl.style.display = 'none'
  if (!body.clientHeight) return // not laid out (e.g. board hidden); the ResizeObserver refits
  let more = 0
  const showMore = () => {
    moreEl.textContent = '+' + more + ' more'
    moreEl.style.display = ''
  }
  const chips = body.querySelector('.cal-chips') as HTMLElement | null
  if (chips) {
    for (let i = 0; i < chips.children.length; i++) {
      const c = chips.children[i] as HTMLElement
      if (c.offsetTop - chips.offsetTop >= chips.clientHeight) more++
    }
    if (more) showMore()
  }
  const over = () => body.scrollHeight > body.clientHeight + 1
  const isPast = (r: HTMLElement) => r.classList.contains('is-past')
  const order = rows.filter(isPast).concat(rows.filter((r) => !isPast(r)).reverse())
  for (let i = 0; i < order.length && over(); i++) {
    const r = order[i]
    r.style.display = 'none'
    if (!isPast(r)) { more++; showMore() }
    const sec = r.parentNode as HTMLElement
    if (!sec.classList.contains('cal-day--today')) {
      const visible = Array.prototype.some.call(sec.querySelectorAll('.cal-ev'), (x: HTMLElement) => x.style.display !== 'none')
      if (!visible) sec.style.display = 'none'
    }
  }
}

export function CalendarWidget({ opts }: WidgetProps) {
  const days = Math.max(1, Math.min(7, Math.round(num(opts.days, 1))))
  const title = opts.title || (days === 1 ? 'Today' : '')
  const poll = usePoll<Calendar>(PATH, POLL_MS)
  const p = useMinute()
  const today = p.key
  const refresh = useRefresh()

  // Everything time-dependent waits for the client: the server renders the
  // calm placeholder, and the first client render matches it exactly.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // A new day: drop yesterday now, and ask for fresh data.
  const lastDay = useRef(today)
  useEffect(() => {
    if (lastDay.current !== today) { lastDay.current = today; refresh(PATH) }
  }, [today, refresh])

  const data = poll.data
  const list = useMemo<Day[] | null>(() => {
    if (!data) return null
    const l = data.days.filter((d) => d.key >= today)
    if (!l.length || l[0].key !== today) l.unshift({ key: today, events: [] })
    return l.slice(0, days)
  }, [data, today, days])

  const todayDay = list ? list[0] : null
  const allDay = useMemo(() => (todayDay ? todayDay.events.filter((e) => e.allDay) : []), [todayDay])
  const timed = useMemo(() => (todayDay ? todayDay.events.filter((e) => !e.allDay) : []), [todayDay])
  const rowStates = states(timed, p.mins)
  const pastSig = rowStates.map((s) => (s === 'past' ? '1' : '0')).join('')

  const bodyRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const ready = mounted && list != null
  // Refit when the rows change or one turns past (it may now be the one hidden).
  useLayoutEffect(() => {
    if (ready && bodyRef.current && moreRef.current) fit(bodyRef.current, moreRef.current)
  }, [ready, list, pastSig])
  useEffect(() => {
    const body = bodyRef.current
    if (!body || typeof ResizeObserver === 'undefined') return
    let lastH = -1
    const ro = new ResizeObserver(() => {
      if (body.clientHeight !== lastH && moreRef.current) { lastH = body.clientHeight; fit(body, moreRef.current) }
    })
    ro.observe(body)
    return () => ro.disconnect()
  }, [])

  const later = list ? list.slice(1) : []
  const laterEmpty = days > 1 && later.length > 0 && !later.some((d) => d.events.length)

  return (
    <div className={'card cal' + (days === 1 ? ' cal--today' : ' cal--week')}>
      <div className="cal-head">
        {title && <span className="label cal-title">{title}</span>}
        {days === 1 && <span className="cal-date">{mounted ? time.names.day(p.dow) + ', ' + time.names.monthShort(p.mo) + ' ' + p.d : ''}</span>}
        <span className="stale cal-stale">{mounted ? staleNote(poll) : ''}</span>
      </div>
      <div className="cal-body" ref={bodyRef}>
        {!ready ? (
          <div className="cal-wait"><i /><i /><i /></div>
        ) : (
          <>
            <section className="cal-day cal-day--today">
              {days > 1 && <DayLabel dayKey={today} />}
              {allDay.length > 0 && <div className="cal-chips">{allDay.map((e) => <Chip key={e.id} ev={e} />)}</div>}
              {timed.map((e, i) => <TodayRow key={e.id} ev={e} state={rowStates[i]} />)}
              {todayDay!.events.length === 0 && <div className="cal-free serif">Nothing on today</div>}
            </section>
            {later.map((d) => d.events.length > 0 && (
              <section className="cal-day" key={d.key}>
                <DayLabel dayKey={d.key} />
                {d.events.map((e) => <LaterRow key={e.id} ev={e} />)}
              </section>
            ))}
            {laterEmpty && <div className="cal-free cal-free--later serif">Nothing else coming up</div>}
          </>
        )}
      </div>
      <div className="cal-more" ref={moreRef} style={{ display: 'none' }} />
    </div>
  )
}
