// What the screen is doing when nobody's touching it.
//   day        the dashboard: after a tap (until photos.idleSec idle), and
//              for photos.dashboardForSec every photos.dashboardEverySec
//   photos     full-screen slideshow + clock/weather/next-event strip, the
//              home screen outside night hours (while there are photos)
//   night      black screen, dim red clock (after idleSec idle in night hours)
//   nightdash  the dashboard under a dark layer, after a tap at night;
//              back to night after 20 s idle
// Every decision reads time.parts(), the household's zone. React renders only
// on a mode change and on the minute (the two small info strips); the
// per-second check is arithmetic on refs, no DOM work.
import { memo, useEffect, useRef, useState } from 'react'
import type { Calendar, CalendarEvent, DashboardOptions, Photos, Weather } from '~/lib/types'
import * as time from '~/lib/time'
import { useMinute, onMinute, stampMinute } from '~/lib/clock'
import { usePoll, staleNote, type PollState } from '~/lib/api'
import { backdateTouch, idleSec, onRequestMode, setMode as storeMode, touched, type Mode } from '~/lib/mode'
import { Slideshow } from '~/widgets/Slideshow'
import { WxIcon } from '~/widgets/icons'
import { useUI } from './ui'
import { bootMode, forcedMode, nextMode } from './modeRules'

const COLOR = /^#[0-9a-fA-F]{6}$/
const KEYS: Record<string, Mode> = { p: 'photos', n: 'night', d: 'day' }
// The slideshow re-renders only when its own props change, not on ours.
const Show = memo(Slideshow)

/**
 * The first render's mode. On the server: what the rules want right now, boot
 * counting as idle, so a 03:00 reload paints the night screen in the HTML
 * itself, before any JS has run on the frame's slow CPU. On the client: the
 * server's choice, read back from the markup, so hydration always matches
 * (the two clocks can straddle a boundary). The effect corrects it after.
 */
function initialMode(options: DashboardOptions): Mode {
  if (typeof document !== 'undefined') {
    const b = document.getElementById('modes')?.getAttribute('data-boot')
    if (b === 'day' || b === 'photos' || b === 'night' || b === 'nightdash') return b
  }
  return bootMode(options, time.parts())
}

export function Modes({ options }: { options: DashboardOptions }) {
  const [boot] = useState(() => initialMode(options))
  const [mode, setModeState] = useState<Mode>(boot)
  // The takeover's slideshow is built on first use: a dashboard that never
  // enters photos never mounts it.
  const [everPhotos, setEverPhotos] = useState(boot === 'photos')
  const modeRef = useRef(mode)
  // useUI() is a fresh object on every UIProvider render; closeSheet is stable.
  const { closeSheet } = useUI()
  const closeRef = useRef(closeSheet)
  closeRef.current = closeSheet
  // Set by the effect; the overlays' pointerdown calls it.
  const exitRef = useRef<(from: Mode, to: Mode, e: React.PointerEvent) => void>(() => {})
  // Unknown until the first answer: assume there are photos.
  const hasPhotos = useRef(true)

  useEffect(() => {
    const stage = document.getElementById('stage')!
    const board = document.getElementById('board')
    let parts = time.parts()
    let forced = false // ?mode= or a key: hold the mode until a touch
    let swallowUntil = 0
    let enteredAt = Date.now()

    function go(m: Mode) {
      stage.setAttribute('data-mode', m)
      storeMode(m)
      if (m === modeRef.current) return
      modeRef.current = m
      enteredAt = Date.now()
      if (m === 'photos' || m === 'night') closeRef.current()
      if (m === 'photos') setEverPhotos(true)
      setModeState(m)
    }
    // The server's mode, until the boot pick below.
    go(modeRef.current)

    // A tap that leaves photos or night lands on a full-screen layer, which
    // disappears on pointerdown. Swallow the rest of that gesture so the
    // widget that is now under the finger doesn't get it, and any contact
    // that starts in the same window too (the rest of a palm or a second
    // hand would otherwise start a star hold). The exiting pointerdown itself
    // passes: swallowUntil is set by its own handler, after this one ran. On
    // window, capture phase: ahead of React's own listeners on the document.
    // stopPropagation only, never stopImmediatePropagation: useHold's pointer
    // tracker also listens on window and must still see these.
    const swallow = (e: Event) => {
      if (Date.now() < swallowUntil) { e.preventDefault(); e.stopPropagation() }
    }
    const SWALLOW = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']
    // Not passive: Chrome makes window touch listeners passive by default,
    // which would ignore preventDefault.
    const OPTS = { capture: true, passive: false }
    SWALLOW.forEach((t) => window.addEventListener(t, swallow, OPTS))
    exitRef.current = (from, to, e) => {
      if (modeRef.current !== from) return
      e.preventDefault()
      swallowUntil = Date.now() + 700
      go(to)
    }

    // A widget's request: only the slideshow, and only with photos to show.
    const offRequest = onRequestMode((m) => {
      if (m !== 'photos' || !hasPhotos.current || modeRef.current !== 'day') return
      forced = false
      go(m)
    })

    // Any touch ends a forced preview (Frame records the touch time itself).
    const onTouch = () => { forced = false }
    document.addEventListener('pointerdown', onTouch, true)

    const check = () => {
      if (forced) return
      const m = nextMode(modeRef.current, options, parts, idleSec(), (Date.now() - enteredAt) / 1000, hasPhotos.current)
      if (m !== modeRef.current) go(m)
    }
    const tick = setInterval(check, 1000)

    // Burn-in: the board moves ±2 px every 5 minutes (the overlays shift
    // their own info each minute). #stage's transform is the desktop
    // scaling, so never touch it.
    const shiftBoard = () => {
      if (!board) return
      const x = Math.round(Math.random() * 4 - 2), y = Math.round(Math.random() * 4 - 2)
      board.style.transform = x || y ? 'translate(' + x + 'px,' + y + 'px)' : ''
    }
    const offMinute = onMinute(() => {
      parts = time.parts()
      if (parts.mins % 5 === 0) shiftBoard()
      check()
    })

    // Previews: p / n / d on a desktop keyboard.
    const onKey = (e: KeyboardEvent) => {
      const m = KEYS[e.key]
      const tag = (e.target as HTMLElement | null)?.tagName || ''
      if (!m || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(tag)) return
      forced = true
      touched()
      go(m)
    }
    document.addEventListener('keydown', onKey)

    // The boot pick waits a turn: Frame's effect (a parent's, so it runs
    // after this one) applies ?at= and starts the clock first.
    const bootTimer = setTimeout(() => {
      parts = time.parts()
      const q = forcedMode(location.search)
      if (q) {
        forced = true
        go(q)
      } else {
        // Boot counts as idle: no bright idleSec of dashboard after the
        // nightly reload; straight to what the rules want.
        backdateTouch(options.photos.idleSec)
        go(bootMode(options, parts, hasPhotos.current))
      }
    }, 0)

    return () => {
      clearTimeout(bootTimer)
      clearInterval(tick)
      offRequest()
      offMinute()
      SWALLOW.forEach((t) => window.removeEventListener(t, swallow, OPTS))
      document.removeEventListener('pointerdown', onTouch, true)
      document.removeEventListener('keydown', onKey)
      exitRef.current = () => {}
    }
  }, [options])

  const on = (m: Mode) => (mode === m ? ' is-on' : '')
  return (
    <div className="modes" id="modes" data-boot={boot}>
      <PhotosProbe has={hasPhotos} />
      <div className={'nightdim' + on('nightdash')} aria-hidden="true" />
      <div className={'takeover' + on('photos')} onPointerDown={(e) => exitRef.current('photos', 'day', e)}>
        <div className="tk-stage">
          {everPhotos && (
            <Show
              running={mode === 'photos'}
              // No captions: the info strip owns the bottom of the screen.
              captions={false}
              layout={options.photos.layout}
              intervalSec={options.photos.intervalSec}
            />
          )}
        </div>
        <div className="tk-scrim" />
        <PhotosInfo active={mode === 'photos'} />
      </div>
      <div className={'night' + on('night')} onPointerDown={(e) => exitRef.current('night', 'nightdash', e)}>
        <NightInfo active={mode === 'night'} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ data

/** Keeps `has` current: with no photos (a new album, local dev) the
 * dashboard stays up instead of a blank slideshow. Its own component, so
 * the poll's re-renders stay out of <Modes>. Shares the slideshow's query. */
function PhotosProbe({ has }: { has: React.MutableRefObject<boolean> }) {
  const photos = usePoll<Photos>('/api/photos', 10 * 60_000)
  if (photos.data) has.current = photos.data.photos.length > 0
  return null
}

function useSources() {
  const weather = usePoll<Weather>('/api/weather', 10 * 60_000)
  const calendar = usePoll<Calendar>('/api/calendar', 5 * 60_000)
  return { weather, calendar }
}

// Only for data we've had: a source that never answered just stays out.
function staleText(...sources: PollState<unknown>[]): string {
  return sources.filter((s) => s.data).map((s) => staleNote(s)).filter(Boolean)[0] || ''
}

function timedEvents(cal: Calendar | null, key: string): CalendarEvent[] {
  const d = cal ? cal.days.filter((x) => x.key === key)[0] : null
  return d ? d.events.filter((e) => !e.allDay && !e.continued && e.start != null) : []
}

function nextToday(cal: Calendar | null, p: time.Parts): CalendarEvent | null {
  return timedEvents(cal, p.key).filter((e) => (e.start as number) >= p.mins)[0] || null
}

/**
 * Burn-in: nudge the static info up to ±4 px each minute while showing.
 * Random only in an effect, never in render (hydration must match).
 */
function useShift(active: boolean, mins: number): React.CSSProperties | undefined {
  const [t, setT] = useState('')
  useEffect(() => {
    if (!active) return
    const x = Math.round(Math.random() * 8 - 4), y = Math.round(Math.random() * 8 - 4)
    setT('translate(' + x + 'px,' + y + 'px)')
  }, [active, mins])
  return t ? { transform: t } : undefined
}

// ------------------------------------------------------------------ photos

function PhotosInfo({ active }: { active: boolean }) {
  const p = useMinute()
  const { weather, calendar } = useSources()
  const style = useShift(active, p.mins)
  const cur = weather.data && weather.data.current
  const e = nextToday(calendar.data, p)
  const stale = staleText(weather, calendar)
  return (
    <div className="tk-info" style={style} data-minute={stampMinute(p)}>
      <div className="tk-clock">
        <div className="tk-time num">
          <span className="tk-hm">{time.clock(p.mins)}</span>
          <span className="tk-ampm">{time.ampm(p.mins)}</span>
        </div>
        <div className="tk-date serif">
          {time.names.day(p.dow) + ', ' + time.names.month(p.mo) + ' ' + p.d}
        </div>
      </div>
      <div className="tk-right">
        {cur && (
          <div className="tk-wx">
            <WxIcon name={cur.icon} size={64} className="tk-wx-icon" />
            <span className="num">{cur.temp + '°'}</span>
            <small>{cur.label}</small>
          </div>
        )}
        {e && (
          <div className="tk-next">
            <i style={{ background: COLOR.test(e.color || '') ? e.color : '#ffffff' }} />
            <span>{e.title + ' · ' + time.hourLabel(e.start as number)}</span>
          </div>
        )}
        {stale && <div className="stale tk-stale">{stale}</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ night

function NightInfo({ active }: { active: boolean }) {
  const p = useMinute()
  const { weather, calendar } = useSources()
  const style = useShift(active, p.mins)
  const cal = calendar.data

  // The next thing that matters when you wake: anything still to come today,
  // else tomorrow's first event. After midnight "today" is the morning
  // ahead, so the same rule covers both sides of it.
  let e = nextToday(cal, p)
  let key = p.key
  if (!e && cal) {
    key = time.addDays(p.key, 1)
    e = timedEvents(cal, key)[0] || null
  }
  // Weather for the day you'll wake into: today before noon, else tomorrow.
  const daily = weather.data && weather.data.daily
  const wkey = p.mins < 720 ? p.key : time.addDays(p.key, 1)
  const w = daily ? daily.filter((d) => d.key === wkey)[0] : null

  const bits: React.ReactNode[] = []
  if (e) {
    bits.push(<span key="e">{time.relDay(key) + ': '}<b>{e.title}</b>{' ' + time.hourLabel(e.start as number)}</span>)
  } else if (cal) {
    bits.push(<span key="e">Nothing early tomorrow</span>)
  }
  if (w) {
    const label = e && key === wkey ? '' : wkey === p.key ? 'Today ' : 'Tomorrow '
    bits.push(<span key="w">{label + w.hi + '° / ' + w.lo + '°'}</span>)
  }
  const stale = staleText(weather, calendar)

  return (
    <div className="nt-inner" style={style} data-minute={stampMinute(p)}>
      <div className="nt-time num">{time.clock(p.mins)}</div>
      <div className="nt-line">
        {bits.length === 2 ? [bits[0], <span key="sep" className="nt-sep">·</span>, bits[1]] : bits}
      </div>
      {stale && <div className="nt-stale">{stale}</div>}
    </div>
  )
}
