// Weather from Open-Meteo (no key), for the configured location, in °F.
//
// The fetch stores whole parsed series (8 days of hours and days, in the
// household's zone); the endpoint slices "the next 24 hours" and "7 days from
// today" against the current time. The cached fetch can be 15 minutes old, or
// hours old if Open-Meteo is down, and the hour may have rolled since.
import { registry, Source } from '../cache'
import { settings } from '../config'
import { dowOf } from '~/lib/time'
import { localOf } from '../calendar/zone'
import type { Envelope, Weather, WeatherIcon } from '~/lib/types'

export const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast'
export const INTERVAL_MS = 900_000
// Once the fetch is this old, its "current" no longer is (see view()).
const CURRENT_MAX_AGE_MS = 3_600_000

// Test seam: what fetchWeather() uses instead of the network.
export const deps = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
}

/** One parsed hour of the stored series (more than the API sends). */
export interface Hour { key: string; mins: number; temp: number; icon: WeatherIcon; label: string; pop: number; isDay: boolean }
export type Day = Weather['daily'][number]
/** What the Source keeps (and snapshots to disk): the whole forecast, unsliced. */
export interface Series { current: Weather['current']; hours: Hour[]; days: Day[] }

// WMO weather code → [icon, label]. Night variants are chosen by isDay.
const CODES: Record<number, [WeatherIcon, string]> = {
  0: ['sun', 'Clear'],
  1: ['sun', 'Mostly clear'],
  2: ['partly', 'Partly cloudy'],
  3: ['cloud', 'Cloudy'],
  45: ['fog', 'Fog'],
  48: ['fog', 'Freezing fog'],
  51: ['drizzle', 'Light drizzle'],
  53: ['drizzle', 'Drizzle'],
  55: ['drizzle', 'Heavy drizzle'],
  56: ['drizzle', 'Freezing drizzle'],
  57: ['drizzle', 'Freezing drizzle'],
  61: ['rain', 'Light rain'],
  63: ['rain', 'Rain'],
  65: ['rain', 'Heavy rain'],
  66: ['rain', 'Freezing rain'],
  67: ['rain', 'Freezing rain'],
  71: ['snow', 'Light snow'],
  73: ['snow', 'Snow'],
  75: ['snow', 'Heavy snow'],
  77: ['snow', 'Snow grains'],
  80: ['rain', 'Showers'],
  81: ['rain', 'Showers'],
  82: ['rain', 'Heavy showers'],
  85: ['snow', 'Snow showers'],
  86: ['snow', 'Snow showers'],
  95: ['storm', 'Thunderstorms'],
  96: ['storm', 'Thunderstorms, hail'],
  99: ['storm', 'Thunderstorms, hail'],
}
const NIGHT: Partial<Record<WeatherIcon, WeatherIcon>> = { sun: 'moon', partly: 'partly-night' }
const UNKNOWN: [WeatherIcon, string] = ['cloud', 'Cloudy']

/** [icon, label] for a WMO code; an unknown code reads as plain cloud. */
export function describe(code: number | null | undefined, isDay = true): [WeatherIcon, string] {
  let [icon, label] = (code != null && CODES[code]) || UNKNOWN
  if (!isDay) icon = NIGHT[icon] || icon
  else if (code === 0) label = 'Sunny'
  return [icon, label]
}

const pop = (v: number | null | undefined) => (v == null ? 0 : Math.round(v))

export interface Raw {
  /** One offset for the whole response, even when it spans a DST change. */
  utc_offset_seconds?: number
  current: { temperature_2m: number; apparent_temperature?: number | null; weather_code?: number | null; is_day?: number | null }
  hourly: {
    time: (number | string)[] // unixtime seconds, or 'YYYY-MM-DDTHH:MM' without timeformat
    temperature_2m: (number | null)[]
    weather_code: (number | null)[]
    precipitation_probability: (number | null)[]
    is_day?: (number | null)[]
  }
  daily: {
    time: (number | string)[]
    weather_code: (number | null)[]
    temperature_2m_max: (number | null)[]
    temperature_2m_min: (number | null)[]
    precipitation_probability_max: (number | null)[]
  }
}

/**
 * Open-Meteo's column arrays → rows. Its local times all use one UTC offset
 * for the whole response, so across a DST change some of its wall-clock
 * labels are an hour off. Hours therefore come as instants
 * (timeformat=unixtime) and are put into the household zone here. A day is
 * still Open-Meteo's own local day: its date is the instant shifted by that
 * same response offset. (Plain strings are still read as wall time.)
 */
export function parse(raw: Raw, tz: string = settings.tz): Series {
  const cur = raw.current
  const isDay = Boolean(cur.is_day ?? 1)
  const [icon, label] = describe(cur.weather_code, isDay)
  const temp = cur.temperature_2m
  const feels = cur.apparent_temperature
  const current: Weather['current'] = {
    temp: Math.round(temp),
    feels: Math.round(feels == null ? temp : feels),
    code: cur.weather_code ?? -1,
    icon,
    label,
    isDay,
  }

  const h = raw.hourly
  const hours: Hour[] = []
  h.time.forEach((t, i) => {
    const temp = h.temperature_2m[i]
    if (temp == null) return // the far end of the forecast can be empty
    const day = h.is_day ? Boolean(h.is_day[i]) : true
    const [icon, label] = describe(h.weather_code[i], day)
    const at = typeof t === 'number'
      ? localOf(t * 1000, tz)
      : { key: t.slice(0, 10), mins: Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) }
    hours.push({
      ...at,
      temp: Math.round(temp),
      icon,
      label,
      pop: pop(h.precipitation_probability[i]),
      isDay: day,
    })
  })

  const d = raw.daily
  const days: Day[] = []
  const offset = raw.utc_offset_seconds ?? 0
  d.time.forEach((t, i) => {
    const key = typeof t === 'number' ? new Date((t + offset) * 1000).toISOString().slice(0, 10) : t
    const hi = d.temperature_2m_max[i], lo = d.temperature_2m_min[i]
    if (hi == null || lo == null) return
    days.push({
      key,
      dow: dowOf(key), // 0 = Sunday, like lib/time
      hi: Math.round(hi),
      lo: Math.round(lo),
      icon: describe(d.weather_code[i], true)[0],
      pop: pop(d.precipitation_probability_max[i]),
    })
  })
  return { current, hours, days }
}

export async function fetchWeather(): Promise<Series> {
  const params = new URLSearchParams({
    latitude: String(settings.latitude),
    longitude: String(settings.longitude),
    timezone: settings.tz, // still sets the daily boundaries
    timeformat: 'unixtime',
    temperature_unit: 'fahrenheit',
    forecast_days: '8', // so 24 hours from 23:00 still has data
    current: 'temperature_2m,apparent_temperature,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  })
  const r = await deps.fetch(OPEN_METEO + '?' + params, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status)
  return parse((await r.json()) as Raw)
}

/** The household zone's wall clock at an instant: its date key and the current hour's start, in minutes. */
export function localNow(ms: number, tz: string = settings.tz): { key: string; hour: number } {
  const out: Record<string, string> = {}
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  })
  for (const p of f.formatToParts(new Date(ms))) out[p.type] = p.value
  return { key: out.year + '-' + out.month + '-' + out.day, hour: (Number(out.hour) % 24) * 60 }
}

/**
 * The API shape: the stored series sliced at `at` (household-zone wall clock).
 * Once the fetch is over an hour old its "current" no longer is, so the
 * current hour's forecast stands in.
 */
export function view(series: Series, at: { key: string; hour: number }, ageMs: number | null = null): Weather {
  const { key: today, hour } = at
  const hours = series.hours.filter((x) => x.key > today || (x.key === today && x.mins >= hour)).slice(0, 24)
  const days = series.days.filter((x) => x.key >= today).slice(0, 7)

  const current = { ...series.current }
  const h0 = hours[0]
  if (ageMs != null && ageMs > CURRENT_MAX_AGE_MS && h0 && h0.key === today && h0.mins === hour) {
    Object.assign(current, { temp: h0.temp, feels: h0.temp, icon: h0.icon, label: h0.label, isDay: h0.isDay })
  }
  const first = days[0] && days[0].key === today ? days[0] : null
  return {
    current,
    today: first ? { hi: first.hi, lo: first.lo, pop: first.pop } : null,
    hourly: hours.map(({ key, mins, temp, icon, pop }) => ({ key, mins, temp, icon, pop })),
    daily: days.map(({ key, dow, hi, lo, icon, pop }) => ({ key, dow, hi, lo, icon, pop })),
  }
}

export function setup(): void {
  registry.add(new Source<Series>('weather', fetchWeather, INTERVAL_MS))
}

// Looked up in the registry, not a module variable: Nitro bundles the startup
// plugin apart from the routes, so this module can exist twice in one process.
export function endpoint(nowMs: number = Date.now()): Envelope<Weather> {
  const src = registry.get<Series>('weather')
  if (!src) return { data: null, updated: null, stale: true, error: null }
  const env = src.envelope()
  const series = env.data
  // A snapshot on disk in some other shape is treated as no data yet.
  const data = series && Array.isArray(series.hours) && Array.isArray(series.days)
    ? view(series, localNow(nowMs), env.updated == null ? null : nowMs - env.updated)
    : null
  return { ...env, data }
}
