// The API contract between the server and the frame. Times for display are
// zone-local date keys ('YYYY-MM-DD') and minutes since local midnight, never
// instants: the frame's own zone is wrong (America/New_York).

/** Every GET /api/<source> returns this. data is null only before the first success. */
export interface Envelope<T> {
  data: T | null
  updated: number | null // epoch ms of the last success
  stale: boolean
  error: string | null
}

export type WeatherIcon =
  | 'sun' | 'moon' | 'partly' | 'partly-night' | 'cloud'
  | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm'

export interface Weather {
  current: { temp: number; feels: number; code: number; icon: WeatherIcon; label: string; isDay: boolean }
  today: { hi: number; lo: number; pop: number } | null
  /** The next 24 hours, starting with the current hour. */
  hourly: { key: string; mins: number; temp: number; icon: WeatherIcon; pop: number }[]
  /** 7 days, today first. dow: 0 = Sunday. */
  daily: { key: string; dow: number; hi: number; lo: number; icon: WeatherIcon; pop: number }[]
}

export interface CalendarEvent {
  id: string
  title: string
  allDay: boolean
  /** Minutes since local midnight on this day; null when allDay. end may be 1440. */
  start: number | null
  end: number | null
  calendar: string
  color: string // '#rrggbb'
  location: string | null
  /** Runs past the end of this day / began on an earlier day. */
  continues: boolean
  continued: boolean
}

/** 7 days, today first; all-day events first, then by start. */
export interface Calendar {
  days: { key: string; events: CalendarEvent[] }[]
}

export interface Photo {
  id: string
  url: string // '/photos/<file>', ≤1280×800, no metadata
  backdrop: string | null // pre-blurred 1280×800 fill for portrait photos
  w: number
  h: number
  o: 'l' | 'p'
  taken: number | null // epoch ms
  contributor: string | null
}

export interface Photos {
  photos: Photo[]
}

export interface Kid {
  id: string
  name: string
  color: string
  chart: {
    id: number
    goal: string
    target: number
    count: number
    done: boolean
    startedAt: number
    completedAt: number | null
    awards: { id: string; at: number }[]
  }
}

export interface Stars {
  kids: Kid[]
}
// Writes:
//   POST   /api/stars/<kid>/award      -> { award: {id, at}, kids }   409 if the chart is done
//   DELETE /api/stars/awards/<id>      -> { kids }                    409 if already undone / too late
//   POST   /api/stars/<kid>/new-chart  body {fromChart?, goal?, target?} -> { kids }
//          409 if fromChart is given and isn't the current, completed chart
// Errors: { error } with a 4xx status.

/** Per-dashboard options, from the dashboard file's JSON block. */
export interface DashboardOptions {
  night: { from: string; to: string }
  photos: {
    windows: { days: number[]; from: string; to: string }[]
    idleSec: number
    layout: 'auto' | 'cover' | 'pair' | 'collage' | 'polaroid'
    intervalSec: number
  }
  reloadAt: string
}
