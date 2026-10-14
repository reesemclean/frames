import { afterEach, beforeEach, describe as group, expect, it } from 'vitest'
import { Source, registry } from '~/server/cache'
import { settings } from '~/server/config'
import * as weather from '~/server/sources/weather'
import type { Raw, Series } from '~/server/sources/weather'
import { addDays } from '~/lib/time'

/** An Open-Meteo-shaped response: `days` days of hours from `start`. */
function raw(start = '2026-10-13', days = 8, code = 0): Raw {
  const time: string[] = [], temps: number[] = [], codes: number[] = [], pops: (number | null)[] = [], isDay: number[] = []
  const keys: string[] = []
  for (let d = 0; d < days; d++) {
    const day = addDays(start, d)
    keys.push(day)
    for (let h = 0; h < 24; h++) {
      time.push(`${day}T${h < 10 ? '0' : ''}${h}:00`)
      temps.push(60 + h + d * 0.5)
      codes.push(code)
      pops.push(h === 5 ? null : h)
      isDay.push(h >= 6 && h < 18 ? 1 : 0)
    }
  }
  return {
    current: { temperature_2m: 71.6, apparent_temperature: 69.4, weather_code: code, is_day: 1 },
    hourly: { time, temperature_2m: temps, weather_code: codes, precipitation_probability: pops, is_day: isDay },
    daily: {
      time: keys,
      weather_code: keys.map(() => code),
      temperature_2m_max: keys.map((_, d) => 80.4 + d),
      temperature_2m_min: keys.map((_, d) => 55.5 + d),
      precipitation_probability_max: keys.map((_, d) => (d === 0 ? null : 10 * d)),
    },
  }
}

const at = (key: string, h: number) => ({ key, hour: h * 60 })
const realFetch = weather.deps.fetch
afterEach(() => {
  weather.deps.fetch = realFetch
  registry.sources.delete('weather')
})

group('describe', () => {
  it('maps codes, with night variants', () => {
    expect(weather.describe(0, true)).toEqual(['sun', 'Sunny'])
    expect(weather.describe(0, false)).toEqual(['moon', 'Clear'])
    expect(weather.describe(2, false)[0]).toBe('partly-night')
    expect(weather.describe(3, false)[0]).toBe('cloud')
    expect(weather.describe(45)[0]).toBe('fog')
    expect(weather.describe(55)[0]).toBe('drizzle')
    expect(weather.describe(81)[0]).toBe('rain')
    expect(weather.describe(86)[0]).toBe('snow')
    expect(weather.describe(95)[0]).toBe('storm')
    expect(weather.describe(12345)).toEqual(['cloud', 'Cloudy'])
    expect(weather.describe(null)).toEqual(['cloud', 'Cloudy'])
  })
})

group('fetchWeather', () => {
  it('requests the right series and parses', async () => {
    let seen: URLSearchParams | null = null
    weather.deps.fetch = async (url) => {
      seen = new URL(url).searchParams
      return Response.json(raw())
    }
    const series = await weather.fetchWeather()
    const p = seen! as URLSearchParams
    expect(p.get('temperature_unit')).toBe('fahrenheit')
    expect(p.get('timezone')).toBe(settings.tz)
    expect(p.get('forecast_days')).toBe('8')
    expect(p.get('timeformat')).toBe('unixtime')
    expect(Number(p.get('latitude'))).toBe(settings.latitude)
    expect(p.get('current')).toContain('apparent_temperature')
    expect(new Set(p.get('hourly')!.split(','))).toEqual(new Set(['temperature_2m', 'weather_code', 'precipitation_probability', 'is_day']))
    expect(new Set(p.get('daily')!.split(','))).toEqual(
      new Set(['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max']),
    )

    expect(series.current).toEqual({ temp: 72, feels: 69, code: 0, icon: 'sun', label: 'Sunny', isDay: true })
    expect(series.hours).toHaveLength(8 * 24)
    const h5 = series.hours[5]
    expect([h5.key, h5.mins, h5.pop, h5.icon]).toEqual(['2026-10-13', 300, 0, 'moon'])
    expect(series.days[0].dow).toBe(2) // 2026-10-13 is a Tuesday
    expect(series.days[0].pop).toBe(0)
  })

  it('throws on an error so the cache keeps the last good value', async () => {
    weather.deps.fetch = async () => new Response('down', { status: 503 })
    const src = new Source<Series | { kept: boolean }>('weather', weather.fetchWeather, weather.INTERVAL_MS)
    src.data = { kept: true }
    expect(await src.refresh()).toBe(false)
    expect(src.data).toEqual({ kept: true })
    expect(src.error).toContain('503')
  })
})

group('view', () => {
  it('slices 24 hours from the current hour', () => {
    const v = weather.view(weather.parse(raw()), at('2026-10-13', 9))
    expect(v.hourly).toHaveLength(24)
    expect([v.hourly[0].key, v.hourly[0].mins]).toEqual(['2026-10-13', 540])
    expect([v.hourly[23].key, v.hourly[23].mins]).toEqual(['2026-10-14', 480])
    expect(Object.keys(v.hourly[0]).sort()).toEqual(['icon', 'key', 'mins', 'pop', 'temp'])
    expect(v.daily).toHaveLength(7)
    expect(v.daily[0].key).toBe('2026-10-13')
    expect(Object.keys(v.daily[0]).sort()).toEqual(['dow', 'hi', 'icon', 'key', 'lo', 'pop'])
    expect(v.today).toEqual({ hi: 80, lo: 56, pop: 0 })
  })

  it('late in the evening still has 24 hours and 7 days', () => {
    let v = weather.view(weather.parse(raw()), at('2026-10-13', 23))
    expect(v.hourly).toHaveLength(24)
    expect(v.hourly[0].mins).toBe(23 * 60)
    expect(v.hourly[1].key).toBe('2026-10-14')
    // Even on the last day before the next fetch, there are 7 days from today.
    v = weather.view(weather.parse(raw()), at('2026-10-14', 23))
    expect(v.daily).toHaveLength(7)
    expect(v.daily[0].key).toBe('2026-10-14')
    expect(v.hourly).toHaveLength(24)
  })

  it('after midnight drops yesterday', () => {
    const v = weather.view(weather.parse(raw()), at('2026-10-14', 0))
    // 60.5°F rounds half up (not to even, as Python's round() would).
    expect(v.hourly[0]).toEqual({ key: '2026-10-14', mins: 0, temp: 61, icon: 'moon', pop: 0 })
    expect(v.daily[0].key).toBe('2026-10-14')
    expect(v.today!.hi).toBe(81)
  })

  it('an old fetch uses the hourly forecast for now', () => {
    const series = weather.parse(raw())
    const fresh = weather.view(series, at('2026-10-13', 14), 600_000)
    expect(fresh.current.temp).toBe(72)
    const old = weather.view(series, at('2026-10-13', 14), 3 * 3_600_000)
    expect(old.current.temp).toBe(74)
    expect(old.current.feels).toBe(74)
    // The stored series is untouched.
    expect(series.current.temp).toBe(72)
  })

  it('with nothing left degrades quietly', () => {
    const v = weather.view(weather.parse(raw()), at('2026-11-30', 12))
    expect(v.hourly).toEqual([])
    expect(v.daily).toEqual([])
    expect(v.today).toBeNull()
  })
})

group('parse', () => {
  it('skips empty trailing values', () => {
    const r = raw()
    r.hourly.temperature_2m[r.hourly.temperature_2m.length - 1] = null
    r.daily.temperature_2m_max[r.daily.temperature_2m_max.length - 1] = null
    const s = weather.parse(r)
    expect(s.hours).toHaveLength(8 * 24 - 1)
    expect(s.days).toHaveLength(7)
  })

  it('puts unixtime hours into the household zone across a DST change', () => {
    // What Open-Meteo sends for New York over the 2026-11-01 fall-back: one
    // offset (EDT) for the whole response, hourly instants, days at midnight
    // by that offset.
    const start = Date.UTC(2026, 9, 31, 4) / 1000 // 2026-10-31 00:00 EDT
    const time = Array.from({ length: 72 }, (_, i) => start + i * 3600)
    const r: Raw = {
      utc_offset_seconds: -14400,
      current: { temperature_2m: 50 },
      hourly: { time, temperature_2m: time.map((_, i) => i), weather_code: time.map(() => 3), precipitation_probability: time.map(() => 0) },
      daily: {
        time: [0, 1, 2].map((d) => start + d * 86400),
        weather_code: [3, 3, 3], temperature_2m_max: [60, 61, 62], temperature_2m_min: [40, 41, 42], precipitation_probability_max: [0, 0, 0],
      },
    }
    const s = weather.parse(r, 'America/New_York')
    expect(s.days.map((d) => d.key)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02'])
    expect(s.hours[0]).toMatchObject({ key: '2026-10-31', mins: 0 })
    // 01:00 happens twice; 02:00 EST is the instant 07:00 UTC (index 27).
    const nov1 = s.hours.filter((h) => h.key === '2026-11-01')
    expect(nov1).toHaveLength(25)
    expect(nov1.slice(0, 4).map((h) => h.mins)).toEqual([0, 60, 60, 120])
    expect(s.hours[27]).toMatchObject({ key: '2026-11-01', mins: 120, temp: 27 })
    expect(s.hours[48]).toMatchObject({ key: '2026-11-01', mins: 23 * 60 })
    expect(s.hours[49]).toMatchObject({ key: '2026-11-02', mins: 0 })
    // Sliced against the real wall clock: at 09:00 EST the 09:00 row is first.
    const v = weather.view(s, weather.localNow(Date.UTC(2026, 10, 1, 14), 'America/New_York'))
    expect([v.hourly[0].key, v.hourly[0].mins, v.hourly[0].temp]).toEqual(['2026-11-01', 540, 34])
  })
})

group('localNow', () => {
  it('reads the household zone, not the host zone', () => {
    // 2026-10-13 16:15 UTC: 09:15 in Phoenix (no DST), 12:15 in New York.
    const t = Date.UTC(2026, 9, 13, 16, 15)
    expect(weather.localNow(t, 'America/Phoenix')).toEqual({ key: '2026-10-13', hour: 540 })
    expect(weather.localNow(t, 'America/New_York')).toEqual({ key: '2026-10-13', hour: 720 })
  })

  it('follows DST in zones that have it', () => {
    // US DST ends 2026-11-01 at 02:00 EDT. 06:30 UTC is 01:30 EST (after the fall-back).
    expect(weather.localNow(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York')).toEqual({ key: '2026-11-01', hour: 60 })
    // The day before, 06:30 UTC is 02:30 EDT.
    expect(weather.localNow(Date.UTC(2026, 9, 31, 6, 30), 'America/New_York')).toEqual({ key: '2026-10-31', hour: 120 })
    // Just after local midnight belongs to the new day, in the zone.
    expect(weather.localNow(Date.UTC(2026, 9, 14, 7, 5), 'America/Phoenix')).toEqual({ key: '2026-10-14', hour: 0 })
  })
})

group('endpoint', () => {
  // 2026-10-13 09:15 in the household zone (Phoenix by default).
  const NOW = Date.UTC(2026, 9, 13, 16, 15)
  const tz = settings.tz
  beforeEach(() => { settings.tz = 'America/Phoenix' })
  afterEach(() => { settings.tz = tz })
  function install(): Source<Series> {
    const src = new Source<Series>('weather', weather.fetchWeather, weather.INTERVAL_MS)
    registry.sources.set('weather', src)
    return src
  }

  it('before the first success', () => {
    install()
    expect(weather.endpoint(NOW)).toEqual({ data: null, updated: null, stale: true, error: null })
  })

  it('serves the sliced view', () => {
    const src = install()
    src.data = weather.parse(raw())
    src.updated = NOW - 15 * 60_000
    const body = weather.endpoint(NOW)
    expect(Object.keys(body).sort()).toEqual(['data', 'error', 'stale', 'updated'])
    expect(body.data!.hourly[0].mins).toBe(540)
    expect(body.data!.daily).toHaveLength(7)
    expect(body.data!.current.temp).toBe(72)
    // The stored series is untouched by slicing.
    expect(src.data.hours).toHaveLength(8 * 24)
    expect(() => JSON.stringify(body)).not.toThrow()
  })

  it('treats a snapshot in another shape as no data', () => {
    const src = install()
    src.data = { current: {} } as unknown as Series
    src.updated = NOW
    expect(weather.endpoint(NOW).data).toBeNull()
  })
})
