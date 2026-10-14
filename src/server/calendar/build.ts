// ICS text -> the /api/calendar data. A pure function (no network, no clock),
// so every edge case is tested with fixture text.
//
// The server does all the time maths: events reach the frame already cut into
// zone-local days ('YYYY-MM-DD' keys, minutes since midnight), because the
// frame's own clock is in another zone. Recurrences are expanded here with
// ical.js, so a weekly event comes back as each occurrence.
import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import type { Calendar, CalendarEvent, Envelope } from '~/lib/types'
import { addDays } from '~/lib/time'
import { dayStart, isZone, localOf, wallToInstant } from './zone'

export const DAYS = 7
// One day more than is served, so after midnight the cached value still fills
// a whole week until the next refresh (the endpoint trims to DAYS).
export const FETCH_DAYS = DAYS + 1

// For calendars with no usable calendar-color.
export const PALETTE = ['#3b82f6', '#e5261e', '#00a36c', '#ff9500', '#8b5cf6', '#0891b2', '#db2777', '#65a30d']
const HEX = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/

// A runaway rule (FREQ=MINUTELY from years ago) mustn't stall a refresh.
const MAX_OCCURRENCES = 50_000

/** One calendar: display name, colour, and its raw VCALENDAR objects (ICS text). */
export interface Feed {
  name: string
  color: string
  ics: string[]
}

/**
 * '#RRGGBBAA' (Apple's usual form) or '#RRGGBB' -> '#rrggbb'.
 * The frame's WebView rejects 8-digit hex, so the alpha goes.
 */
export function cleanColor(value: string | null | undefined, index: number): string {
  const m = HEX.exec((value || '').trim())
  if (m) return '#' + m[1].toLowerCase()
  return PALETTE[index % PALETTE.length]
}

type Time = ICAL.Time
type Ev = ICAL.Event

const pad2 = (n: number) => (n < 10 ? '0' : '') + n
const dateKey = (t: Time) => t.year + '-' + pad2(t.month) + '-' + pad2(t.day)

function tzidParam(ev: Ev, prop: string): string | null {
  const p = ev.component.getFirstProperty(prop)
  const v = p ? p.getParameter('tzid') : null
  return typeof v === 'string' ? v : null
}

/**
 * The zone a time is in: 'UTC', a TZID, or null for floating. ical.js only
 * attaches a zone it can resolve (an IANA TZID always, see IntlZone; any other
 * only with a VTIMEZONE), and its clones
 * (every recurrence occurrence) drop an unresolved TZID, so `fallback` is the
 * TZID parameter of the property the time came from.
 */
function zoneOf(t: Time, fallback: string | null): string | null {
  const z = t.zone
  if (z === ICAL.Timezone.utcTimezone || (z && z.tzid === 'UTC')) return 'UTC'
  if (z && z.tzid && z.tzid !== 'floating') return z.tzid
  const own = (t as unknown as { timezone?: string }).timezone
  return own || fallback
}

/**
 * Epoch ms of a DATE-TIME. A TZID that's an IANA name is read with Intl (full
 * DST rules, VTIMEZONE or not); any other TZID with a VTIMEZONE uses that
 * definition; floating times (and unknown TZIDs) are household time.
 */
function instant(t: Time, fallback: string | null, tz: string): number {
  const z = zoneOf(t, fallback)
  const wall = { y: t.year, mo: t.month, d: t.day, h: t.hour, mi: t.minute, s: t.second }
  if (z === 'UTC') return Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s)
  if (isZone(z)) return wallToInstant(wall, z)
  if (z && t.zone && t.zone.tzid === z && (t.zone as unknown as { component?: unknown }).component) {
    return t.toUnixTime() * 1000
  }
  return wallToInstant(wall, tz)
}

/**
 * Stable across refreshes: the UID plus which occurrence this is.
 *
 * The occurrence is named by its RECURRENCE-ID (its original slot in the
 * series) when it has one, so a moved instance keeps its id, and every
 * occurrence reshaped by a RANGE=THISANDFUTURE override stays distinct.
 * (`uid` falls back to the title for the odd event without one, so two such
 * events at one time stay distinct.)
 */
export function eventId(uid: string, which: string): string {
  return createHash('sha1').update(uid + '|' + which).digest('hex').slice(0, 16)
}

function whichOf(t: Time, fallback: string | null, tz: string): string {
  if (t.isDate) return dateKey(t)
  const z = zoneOf(t, fallback)
  // Floating: the wall time itself names the slot, whatever the household zone.
  if (!z) return t.toString()
  return new Date(instant(t, fallback, tz)).toISOString()
}

function text(ev: Ev, name: string): string {
  const v = ev.component.getFirstPropertyValue(name)
  return v == null ? '' : String(v).trim()
}

interface Occurrence {
  item: Ev // the VEVENT whose fields apply (master, or an override)
  start: Time
  end: Time
  /** Names the occurrence for its id; null for a one-off event. */
  slot: { t: Time; tzid: string | null } | null
}

/** Every occurrence of one UID's master (+ overrides) starting before `until`. */
function expand(master: Ev, until: number, tz: string): Occurrence[] {
  const out: Occurrence[] = []
  const masterTz = tzidParam(master, 'dtstart')
  if (!master.isRecurring()) {
    out.push({ item: master, start: master.startDate, end: master.endDate, slot: null })
    return out
  }
  const used = new Set<Ev>()
  const it = master.iterator()
  let next: Time | null
  let n = 0
  while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
    if (instant(next, masterTz, tz) >= until) break
    const d = master.getOccurrenceDetails(next)
    used.add(d.item)
    out.push({ item: d.item, start: d.startDate, end: d.endDate, slot: { t: d.recurrenceId, tzid: masterTz } })
  }
  // Overrides the walk didn't reach: moved in from a slot past the window, or
  // naming a slot the rule no longer produces. Shown where they now are.
  // (Typed as Event[], but at runtime a map keyed by RECURRENCE-ID.)
  for (const ex of Object.values(master.exceptions as unknown as Record<string, Ev>)) {
    if (used.has(ex) || ex.modifiesFuture()) continue
    out.push({ item: ex, start: ex.startDate, end: ex.endDate, slot: { t: ex.recurrenceId, tzid: tzidParam(ex, 'recurrence-id') } })
  }
  return out
}

/**
 * An ical.js zone whose offsets come from Intl, for IANA TZIDs. ical.js only
 * resolves a TZID through its process-global TimezoneService, and its
 * recurrence walk compares EXDATEs and matches RECURRENCE-IDs by instant, so a
 * UTC-form EXDATE against an unresolved (floating) TZID never matches. With
 * every IANA TZID registered this way, that no longer depends on whether some
 * earlier object happened to carry a VTIMEZONE for it, and ical.js agrees with
 * instant().
 */
class IntlZone extends ICAL.Timezone {
  constructor(tzid: string) {
    super({ tzid })
  }
  override utcOffset(tt: Time): number {
    const wall = { y: tt.year, mo: tt.month, d: tt.day, h: tt.hour, mi: tt.minute, s: tt.second }
    return (Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s) - wallToInstant(wall, this.tzid)) / 1000
  }
}

function useIntlZone(id: unknown): void {
  if (typeof id !== 'string' || !isZone(id)) return
  const have = ICAL.TimezoneService.get(id)
  if (have instanceof IntlZone || have === ICAL.Timezone.utcTimezone) return
  ICAL.TimezoneService.register(new IntlZone(id), id)
}

/** The VEVENTs of one VCALENDAR, grouped by UID into a master and its overrides. */
function occurrencesOf(vcal: ICAL.Component, until: number, tz: string): { uid: string; occ: Occurrence }[] {
  // Before any time value is read (ical.js resolves a TZID as it parses one).
  for (const v of vcal.getAllSubcomponents('vevent')) {
    for (const p of v.getAllProperties()) useIntlZone(p.getParameter('tzid'))
  }
  // Register this object's other VTIMEZONEs too, for the odd non-IANA TZID
  // that a later object uses without repeating the definition.
  for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
    const id = vtz.getFirstPropertyValue('tzid')
    if (typeof id === 'string' && !isZone(id) && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(vtz)
  }
  const groups = new Map<string, { masters: ICAL.Component[]; overrides: ICAL.Component[] }>()
  let anon = 0
  for (const v of vcal.getAllSubcomponents('vevent')) {
    const uidValue = v.getFirstPropertyValue('uid')
    const uid = uidValue ? String(uidValue).trim() : ''
    const summary = v.getFirstPropertyValue('summary')
    const key = uid || '\0' + anon++ // no UID: each VEVENT stands alone
    const g = groups.get(key) || { masters: [], overrides: [] }
    groups.set(key, g)
    if (v.hasProperty('recurrence-id')) g.overrides.push(v)
    else g.masters.push(v)
    // An id needs something: the title stands in for a missing UID.
    if (!uid) (g as { idBase?: string }).idBase = 'summary:' + (summary ? String(summary).trim() : '')
  }
  const out: { uid: string; occ: Occurrence }[] = []
  for (const [key, g] of groups) {
    const uid = (g as { idBase?: string }).idBase ?? key
    if (g.masters.length) {
      for (const m of g.masters) {
        // Overrides passed explicitly: left to itself, ical.js relates every
        // RECURRENCE-ID VEVENT in the object to this master, whatever its UID.
        const ev = new ICAL.Event(m, { exceptions: g.overrides })
        for (const occ of expand(ev, until, tz)) out.push({ uid, occ })
      }
    } else {
      // Only overrides (an invitation to one instance): each is a one-off.
      for (const o of g.overrides) {
        const ev = new ICAL.Event(o, { exceptions: [] })
        out.push({ uid, occ: { item: ev, start: ev.startDate, end: ev.endDate, slot: { t: ev.recurrenceId, tzid: tzidParam(ev, 'recurrence-id') } } })
      }
    }
  }
  return out
}

function parseAll(ics: string): ICAL.Component[] {
  const jcal = ICAL.parse(ics) as unknown
  // ICAL.parse returns one component, or a list when the text holds several.
  const list = Array.isArray(jcal) && Array.isArray(jcal[0]) ? (jcal as unknown[]) : [jcal]
  return list.map((j) => new ICAL.Component(j as unknown[]))
}

interface Day { key: string; start: number; end: number }
type Placed = { key: string; sort: [number, number, number, string]; item: CalendarEvent }

/**
 * The /api/calendar data for [first, first + days) in tz.
 *
 * An event touching several days appears on each, clipped to that day
 * (0 / 1440 at a cut), with continued/continues marking the cuts. Cancelled
 * occurrences are dropped. An event in two calendars (an invite copied to a
 * shared calendar) is shown once, from the earlier feed.
 */
export function buildDays(feeds: Feed[], first: string, tz: string, days: number = DAYS): Calendar {
  const keys: string[] = []
  for (let i = 0; i < days; i++) keys.push(addDays(first, i))
  const bounds: Day[] = keys.map((key) => ({ key, start: dayStart(key, tz), end: dayStart(addDays(key, 1), tz) }))
  const windowStart = bounds[0]?.start ?? dayStart(first, tz)
  const windowEnd = dayStart(addDays(first, days), tz)
  // Expand a day wider each way, then clip here by one rule, so zone and
  // floating-time edge cases don't depend on the library's window maths.
  const until = windowEnd + 864e5
  const from = windowStart - 864e5

  const out = new Map<string, Placed[]>(keys.map((k) => [k, []]))
  const seen = new Set<string>()

  for (const feed of feeds) {
    for (const ics of feed.ics) {
      let occs: { uid: string; occ: Occurrence }[]
      try {
        occs = []
        for (const vcal of parseAll(ics)) occs.push(...occurrencesOf(vcal, until, tz))
      } catch (e) {
        // One bad object mustn't hide the rest.
        console.warn(`[calendar] ${feed.name}: skipping unreadable object: ${(e as Error)?.message || e}`)
        continue
      }
      for (const { uid, occ } of occs) {
        try {
          if (text(occ.item, 'status').toUpperCase() === 'CANCELLED') continue
          const startTz = tzidParam(occ.item, 'dtstart')
          const which = occ.slot ? whichOf(occ.slot.t, occ.slot.tzid, tz) : whichOf(occ.start, startTz, tz)
          const eid = eventId(uid, which)
          if (seen.has(eid)) continue
          const placed = place(occ, startTz, bounds, from, tz, feed, eid)
          if (placed.length) seen.add(eid)
          for (const p of placed) out.get(p.key)!.push(p)
        } catch (e) {
          console.warn(`[calendar] ${feed.name}: skipping unreadable event: ${(e as Error)?.message || e}`)
        }
      }
    }
  }

  return {
    days: keys.map((key) => ({
      key,
      events: out.get(key)!.sort((a, b) => cmp(a.sort, b.sort)).map((p) => p.item),
    })),
  }
}

function cmp(a: Placed['sort'], b: Placed['sort']): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
  return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0
}

/** Cut one occurrence into an entry per day it touches. */
function place(occ: Occurrence, startTz: string | null, days: Day[], from: number, tz: string, feed: Feed, eid: string): Placed[] {
  const ev = occ.item
  const title = text(ev, 'summary') || '(untitled)'
  const lower = title.toLowerCase()
  const base = { id: eid, title, calendar: feed.name, color: feed.color, location: text(ev, 'location') || null }
  const placed: Placed[] = []

  if (occ.start.isDate) {
    // An all-day end is an exclusive date, as in iCalendar. A DATE-TIME end on
    // a DATE start is malformed but seen: its date is used.
    const first = dateKey(occ.start)
    let end = dateKey(occ.end)
    if (end <= first) end = addDays(first, 1)
    const last = addDays(end, -1)
    for (const d of days) {
      if (first <= d.key && d.key <= last) {
        placed.push({
          key: d.key,
          sort: [0, 0, 0, lower],
          item: { ...base, allDay: true, start: null, end: null, continued: d.key > first, continues: d.key < last },
        })
      }
    }
    return placed
  }

  const start = instant(occ.start, startTz, tz)
  // A DATE end on a DATE-TIME start: midnight starting that day.
  let end = occ.end.isDate ? dayStart(dateKey(occ.end), tz) : instant(occ.end, startTz, tz)
  if (end < start) end = start
  if (end < from) return placed

  for (const d of days) {
    // An instant (no DTEND/DURATION) belongs to the day it happens on.
    const touches = start === end ? d.start <= start && start < d.end : start < d.end && end > d.start
    if (!touches) continue
    const continued = start < d.start
    const continues = end > d.end
    const s = continued ? 0 : localOf(start, tz).mins
    const e = end >= d.end ? 1440 : localOf(end, tz).mins
    placed.push({
      key: d.key,
      sort: [1, s, e, lower],
      item: { ...base, allDay: false, start: s, end: e, continued, continues },
    })
  }
  return placed
}

/**
 * The envelope with days before today dropped, at most DAYS kept.
 *
 * The cache refreshes every few minutes but the day rolls at midnight, so
 * this trim happens per request. The cached value itself is left alone.
 */
export function current(env: Envelope<Calendar>, today: string): Envelope<Calendar> {
  if (!env.data) return env
  return { ...env, data: { days: env.data.days.filter((d) => d.key >= today).slice(0, DAYS) } }
}
