// The family calendar, from iCloud over CalDAV (tsdav), every 5 minutes.
// The conversion to zone-local days lives in ../calendar/build.ts, a pure
// function over ICS text, so it's tested without a server.
import { DAVClient, type DAVCalendar } from 'tsdav'
import { registry, Source } from '../cache'
import { settings } from '../config'
import { buildDays, cleanColor, current, FETCH_DAYS, type Feed } from '../calendar/build'
import { dayStart, todayKey } from '../calendar/zone'
import { addDays } from '~/lib/time'
import type { Envelope, Calendar } from '~/lib/types'

export { buildDays, cleanColor, current, DAYS, FETCH_DAYS, PALETTE, type Feed } from '../calendar/build'

export const INTERVAL = 300_000
const DISCOVERY_TTL = 3_600_000
const REQUEST_TIMEOUT = 30_000

/** The slice of tsdav's DAVClient used here (tests pass a fake). */
export interface DavClient {
  login(): Promise<void>
  fetchCalendars(): Promise<DAVCalendar[]>
  fetchCalendarObjects(params: { calendar: DAVCalendar; timeRange: { start: string; end: string } }): Promise<{ data?: unknown }[]>
}

function defaultClient(): DavClient {
  return new DAVClient({
    serverUrl: settings.caldavUrl,
    credentials: { username: settings.icloudUsername, password: settings.icloudAppPassword },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    // tsdav has no timeout, and one hung request would leave the Source's
    // refresh loop waiting forever. A fresh signal per request: the client is
    // reused for an hour, so a signal made once would soon be expired.
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) }),
  })
}
let makeClient: () => DavClient = defaultClient

/** Tests only: swap the client factory (null restores tsdav's). */
export function setClientFactory(fn: (() => DavClient) | null): void { makeClient = fn || defaultClient }

interface Found { client: DavClient; calendar: DAVCalendar; name: string; color: string }
let discovered: { at: number; found: Found[] } | null = null

/** Tests only. */
export function resetDiscovery(): void { discovered = null }
export function hasDiscovery(): boolean { return discovered != null }

// tsdav hands back DAV properties as text, or as xml-js objects when the
// element has attributes (Apple's <calendar-color symbolic-color="…">).
function davText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && '_text' in v) return String((v as { _text: unknown })._text)
  return ''
}

/**
 * The event calendars to show, with their colours.
 *
 * Event calendars only: iCloud lists Reminders lists over CalDAV too, and one
 * can share a calendar's name. Cached (with the client the calendars are
 * bound to) for an hour, since every refresh would otherwise repeat the
 * principal/home discovery and a PROPFIND per calendar.
 */
async function discover(): Promise<Found[]> {
  if (discovered && Date.now() - discovered.at < DISCOVERY_TTL) return discovered.found
  const client = makeClient()
  await client.login()
  const wanted = settings.calendarNames
  const found: { calendar: DAVCalendar; name: string; raw: string }[] = []
  for (const calendar of await client.fetchCalendars()) {
    const name = davText(calendar.displayName).trim()
    if (wanted.length && !wanted.includes(name)) continue
    // No supported-component set at all means every component (RFC 4791).
    const comps = calendar.components || []
    if (comps.length && !comps.includes('VEVENT')) continue
    found.push({ calendar, name, raw: davText(calendar.calendarColor) })
  }
  if (wanted.length) {
    if (!found.length) throw new Error(`no event calendar named ${wanted.join(', ')}`)
    const missing = wanted.filter((n) => !found.some((f) => f.name === n))
    if (missing.length) console.warn(`[calendar] no event calendar named ${missing.join(', ')}`)
    found.sort((a, b) => wanted.indexOf(a.name) - wanted.indexOf(b.name))
  }
  const result = found.map((f, i) => ({ client, calendar: f.calendar, name: f.name, color: cleanColor(f.raw, i) }))
  discovered = { at: Date.now(), found: result }
  return result
}

/** Every chosen calendar's objects overlapping [first, first + FETCH_DAYS) in tz. */
export async function fetchFeeds(first: string, tz: string): Promise<Feed[]> {
  const timeRange = {
    start: new Date(dayStart(first, tz)).toISOString(),
    end: new Date(dayStart(addDays(first, FETCH_DAYS), tz)).toISOString(),
  }
  const feeds: Feed[] = []
  for (const f of await discover()) {
    const objs = await f.client.fetchCalendarObjects({ calendar: f.calendar, timeRange })
    feeds.push({ name: f.name, color: f.color, ics: objs.map((o) => o.data).filter((d): d is string => typeof d === 'string') })
  }
  return feeds
}

export async function fetchCalendar(): Promise<Calendar> {
  if (!settings.icloudUsername || !settings.icloudAppPassword) {
    throw new Error('calendar not configured: set ICLOUD_USERNAME and ICLOUD_APP_PASSWORD')
  }
  const tz = settings.tz
  const first = todayKey(tz)
  let feeds: Feed[]
  try {
    feeds = await fetchFeeds(first, tz)
  } catch (e) {
    discovered = null // rediscover next time (renamed calendar, moved iCloud shard)
    throw e
  }
  return buildDays(feeds, first, tz, FETCH_DAYS)
}

export let source: Source<Calendar> | null = null

export function setup(): void {
  source = registry.add(new Source<Calendar>('calendar', fetchCalendar, INTERVAL))
}

// Looked up in the registry, not a module variable: Nitro bundles the startup
// plugin apart from the routes, so this module can exist twice in one process.
// Days before today are trimmed per request: the cache refreshes every few
// minutes, but the day rolls at midnight.
export function endpoint(): Envelope<Calendar> {
  return current(registry.get<Calendar>('calendar')!.envelope(), todayKey(settings.tz))
}
