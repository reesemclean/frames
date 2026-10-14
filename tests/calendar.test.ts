// The calendar: ICS text -> zone-local days, and the CalDAV discovery around
// it. No network: the DAV client is a fake.
import { readFileSync } from 'node:fs'
import ICAL from 'ical.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarEvent } from '~/lib/types'
import { settings } from '~/server/config'
import { Source } from '~/server/cache'
import * as cal from '~/server/sources/calendar'
import { dayStart, localOf, todayKey, wallToInstant } from '~/server/calendar/zone'

const PHX = 'America/Phoenix'
const FIRST = '2026-10-13' // a Tuesday

function vcal(...events: string[]): string {
  const body = events.map((e) => `BEGIN:VEVENT\n${e.trim()}\nEND:VEVENT`).join('\n')
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//test//EN\n${body}\nEND:VCALENDAR\n`.replace(/\n/g, '\r\n')
}

function daysOf(events: string[], opts: { name?: string; color?: string; first?: string; days?: number; tz?: string } = {}): Record<string, CalendarEvent[]> {
  const data = cal.buildDays(
    [{ name: opts.name ?? 'Family', color: opts.color ?? '#3b82f6', ics: [vcal(...events)] }],
    opts.first ?? FIRST, opts.tz ?? PHX, opts.days ?? 7,
  )
  return Object.fromEntries(data.days.map((d) => [d.key, d.events]))
}
const withEvents = (d: Record<string, CalendarEvent[]>) => Object.keys(d).filter((k) => d[k].length)
const titled = (d: Record<string, CalendarEvent[]>, t: string) => Object.keys(d).filter((k) => d[k].some((e) => e.title === t))

describe('buildDays', () => {
  it('is seven zone-local days', () => {
    const data = cal.buildDays([], FIRST, PHX)
    expect(data.days.map((d) => d.key)).toEqual([13, 14, 15, 16, 17, 18, 19].map((n) => `2026-10-${n}`))
    expect(data.days.every((d) => d.events.length === 0)).toBe(true)
  })

  it('shapes a timed event', () => {
    const d = daysOf(['UID:a\nSUMMARY:Swim\nLOCATION:Pool\nDTSTART;TZID=America/Phoenix:20261013T153000\nDTEND;TZID=America/Phoenix:20261013T163000'])
    expect(d['2026-10-13']).toHaveLength(1)
    const ev = d['2026-10-13'][0]
    expect(ev).toEqual({
      id: ev.id, title: 'Swim', calendar: 'Family', color: '#3b82f6', location: 'Pool',
      allDay: false, start: 15 * 60 + 30, end: 16 * 60 + 30, continued: false, continues: false,
    })
    expect(ev.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('expands recurrences with EXDATE and a cancelled override', () => {
    const d = daysOf([
      `UID:weekly
SUMMARY:Piano
DTSTART;TZID=America/Phoenix:20261006T160000
DTEND;TZID=America/Phoenix:20261006T163000
RRULE:FREQ=DAILY;INTERVAL=2`,
      // The 10-16 occurrence is overridden as STATUS:CANCELLED.
      `UID:weekly
RECURRENCE-ID;TZID=America/Phoenix:20261016T160000
SUMMARY:Piano
STATUS:CANCELLED
DTSTART;TZID=America/Phoenix:20261016T160000
DTEND;TZID=America/Phoenix:20261016T163000`,
      `UID:monday
SUMMARY:Soccer
DTSTART;TZID=America/Phoenix:20261005T170000
DTEND;TZID=America/Phoenix:20261005T180000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=America/Phoenix:20261014T170000`,
    ])
    // Every 2 days from 10-06: 10-14, 10-16 (cancelled), 10-18.
    expect(titled(d, 'Piano')).toEqual(['2026-10-14', '2026-10-18'])
    // Wed 10-14 excluded; next Mon 10-19.
    expect(titled(d, 'Soccer')).toEqual(['2026-10-19'])
  })

  it('a moved override keeps its id and shows the new time', () => {
    const master = `UID:m
SUMMARY:Lesson
DTSTART;TZID=America/Phoenix:20261013T090000
DTEND;TZID=America/Phoenix:20261013T100000
RRULE:FREQ=DAILY;COUNT=3`
    const moved = `UID:m
RECURRENCE-ID;TZID=America/Phoenix:20261014T090000
SUMMARY:Lesson (moved)
DTSTART;TZID=America/Phoenix:20261014T130000
DTEND;TZID=America/Phoenix:20261014T140000`
    const plain = daysOf([master])
    const d = daysOf([master, moved])
    expect(d['2026-10-14']).toHaveLength(1)
    const ev = d['2026-10-14'][0]
    expect([ev.title, ev.start]).toEqual(['Lesson (moved)', 13 * 60])
    expect(ev.id).toBe(plain['2026-10-14'][0].id)
    expect(new Set(['2026-10-13', '2026-10-14', '2026-10-15'].map((k) => d[k][0].id)).size).toBe(3)
  })

  it('a THISANDFUTURE override reshapes every later occurrence, each with its own id', () => {
    const master = `UID:m
SUMMARY:Lesson
DTSTART;TZID=America/Phoenix:20261013T090000
DTEND;TZID=America/Phoenix:20261013T100000
RRULE:FREQ=DAILY;COUNT=5`
    const future = `UID:m
RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/Phoenix:20261014T090000
SUMMARY:Lesson (later)
DTSTART;TZID=America/Phoenix:20261014T130000
DTEND;TZID=America/Phoenix:20261014T140000`
    const d = daysOf([master, future])
    const keys = [13, 14, 15, 16, 17].map((n) => `2026-10-${n}`)
    expect(keys.map((k) => [d[k][0].title, d[k][0].start])).toEqual([
      ['Lesson', 9 * 60],
      ...Array(4).fill(['Lesson (later)', 13 * 60]),
    ])
    expect(new Set(keys.map((k) => d[k][0].id)).size).toBe(5)
    expect(d).toEqual(daysOf([master, future])) // ids stable across builds
  })

  it('ids are stable across builds and windows', () => {
    const ev = 'UID:s\nSUMMARY:X\nDTSTART:20261015T150000Z\nDTEND:20261015T160000Z'
    const a = daysOf([ev])['2026-10-15'][0].id
    const b = daysOf([ev], { first: '2026-10-14' })['2026-10-15'][0].id
    expect(a).toBe(b)
  })

  it('a multi-day all-day event has an exclusive DTEND', () => {
    const d = daysOf(['UID:trip\nSUMMARY:Camping\nDTSTART;VALUE=DATE:20261012\nDTEND;VALUE=DATE:20261015'])
    // Covers 10-12, 10-13, 10-14; 10-15 is the exclusive end.
    expect(withEvents(d)).toEqual(['2026-10-13', '2026-10-14'])
    const a = d['2026-10-13'][0], b = d['2026-10-14'][0]
    expect(a.allDay).toBe(true)
    expect(a.start).toBeNull()
    expect(a.end).toBeNull()
    expect([a.continued, a.continues]).toEqual([true, true])
    expect([b.continued, b.continues]).toEqual([true, false])
  })

  it('a single all-day event without DTEND lasts the day', () => {
    const d = daysOf(['UID:b\nSUMMARY:Birthday\nDTSTART;VALUE=DATE:20261016'])
    expect(withEvents(d)).toEqual(['2026-10-16'])
    expect(d['2026-10-16'][0].continues).toBe(false)
  })

  it('splits an event crossing midnight', () => {
    const d = daysOf(['UID:n\nSUMMARY:Flight\nDTSTART;TZID=America/Phoenix:20261013T220000\nDTEND;TZID=America/Phoenix:20261014T013000'])
    const a = d['2026-10-13'][0], b = d['2026-10-14'][0]
    expect([a.start, a.end, a.continued, a.continues]).toEqual([22 * 60, 1440, false, true])
    expect([b.start, b.end, b.continued, b.continues]).toEqual([0, 90, true, false])
    expect(a.id).toBe(b.id)
  })

  it('an event ending exactly at midnight stays on its day', () => {
    const d = daysOf(['UID:z\nSUMMARY:Late\nDTSTART;TZID=America/Phoenix:20261013T230000\nDTEND;TZID=America/Phoenix:20261014T000000'])
    expect(d['2026-10-13'][0].end).toBe(1440)
    expect(d['2026-10-13'][0].continues).toBe(false)
    expect(d['2026-10-14']).toEqual([])
  })

  it('converts a TZID other than the household zone', () => {
    // 9 AM in New York on 10-13 (EDT, UTC-4) is 6 AM in Phoenix (UTC-7).
    const d = daysOf(['UID:ny\nSUMMARY:Call\nDTSTART;TZID=America/New_York:20261013T090000\nDTEND;TZID=America/New_York:20261013T100000'])
    const ev = d['2026-10-13'][0]
    expect([ev.start, ev.end]).toEqual([6 * 60, 7 * 60])
  })

  it('a TZID can shift an event onto the previous day', () => {
    // 1 AM New York on 10-15 is 10 PM Phoenix on 10-14.
    const d = daysOf(['UID:ny2\nSUMMARY:Red-eye\nDTSTART;TZID=America/New_York:20261015T010000\nDTEND;TZID=America/New_York:20261015T020000'])
    expect(withEvents(d)).toEqual(['2026-10-14'])
    expect(d['2026-10-14'][0].start).toBe(22 * 60)
  })

  it('reads UTC times', () => {
    const d = daysOf(['UID:u\nSUMMARY:Standup\nDTSTART:20261013T160000Z\nDTEND:20261013T163000Z'])
    const ev = d['2026-10-13'][0]
    expect([ev.start, ev.end]).toEqual([9 * 60, 9 * 60 + 30])
  })

  it('floating time is household time', () => {
    const d = daysOf(['UID:f\nSUMMARY:Float\nDTSTART:20261013T070000\nDTEND:20261013T080000'])
    const ev = d['2026-10-13'][0]
    expect([ev.start, ev.end]).toEqual([7 * 60, 8 * 60])
  })

  it('handles DURATION and instant events', () => {
    const d = daysOf([
      'UID:d\nSUMMARY:Dur\nDTSTART:20261013T170000Z\nDURATION:PT45M',
      'UID:i\nSUMMARY:Instant\nDTSTART:20261013T180000Z',
    ])
    const evs = Object.fromEntries(d['2026-10-13'].map((e) => [e.title, e]))
    expect([evs.Dur.start, evs.Dur.end]).toEqual([600, 645])
    expect([evs.Instant.start, evs.Instant.end]).toEqual([660, 660])
  })

  it('drops events outside the window', () => {
    const d = daysOf([
      'UID:p\nSUMMARY:Past\nDTSTART;TZID=America/Phoenix:20261012T220000\nDTEND;TZID=America/Phoenix:20261012T230000',
      'UID:l\nSUMMARY:Later\nDTSTART;TZID=America/Phoenix:20261020T010000\nDTEND;TZID=America/Phoenix:20261020T020000',
    ])
    expect(withEvents(d)).toEqual([])
  })

  it('sorts all-day first, then by start', () => {
    const d = daysOf([
      'UID:1\nSUMMARY:Late\nDTSTART;TZID=America/Phoenix:20261013T180000\nDTEND;TZID=America/Phoenix:20261013T190000',
      'UID:2\nSUMMARY:Early\nDTSTART;TZID=America/Phoenix:20261013T080000\nDTEND;TZID=America/Phoenix:20261013T090000',
      'UID:3\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20261013',
    ])
    expect(d['2026-10-13'].map((e) => e.title)).toEqual(['Holiday', 'Early', 'Late'])
  })

  it('feeds carry their colour, and a duplicate is shown once', () => {
    const same = 'UID:dup\nSUMMARY:Party\nDTSTART:20261013T200000Z\nDTEND:20261013T210000Z'
    const data = cal.buildDays([
      { name: 'Mom', color: '#ff0000', ics: [vcal(same)] },
      { name: 'Family', color: '#00ff00', ics: [vcal(same, 'UID:k\nSUMMARY:Kid\nDTSTART:20261013T220000Z\nDTEND:20261013T230000Z')] },
    ], FIRST, PHX)
    expect(data.days[0].events.map((e) => [e.title, e.calendar, e.color])).toEqual([
      ['Party', 'Mom', '#ff0000'], ['Kid', 'Family', '#00ff00'],
    ])
  })

  it('events without a UID stay distinct', () => {
    const d = daysOf([
      'SUMMARY:One\nDTSTART:20261013T200000Z\nDTEND:20261013T210000Z',
      'SUMMARY:Two\nDTSTART:20261013T200000Z\nDTEND:20261013T210000Z',
    ])
    expect(d['2026-10-13'].map((e) => e.title).sort()).toEqual(['One', 'Two'])
  })

  // --- beyond the Python suite: the ical.js-specific paths ----------------

  it('uses an embedded VTIMEZONE for a non-IANA TZID', () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
      'BEGIN:VTIMEZONE', 'TZID:Custom Eastern',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:v', 'SUMMARY:Call', 'DTSTART;TZID=Custom Eastern:20261013T090000', 'DTEND;TZID=Custom Eastern:20261013T100000', 'END:VEVENT',
      'END:VCALENDAR', '',
    ].join('\r\n')
    const data = cal.buildDays([{ name: 'F', color: '#000000', ics: [ics] }], FIRST, PHX)
    const ev = data.days[0].events[0]
    expect([ev.start, ev.end]).toEqual([6 * 60, 7 * 60])
  })

  it('keeps wall time across a DST change in a household zone that has one', () => {
    // Daily 9 AM in New York across the 2026-11-01 fall-back stays 9 AM.
    const d = daysOf(
      ['UID:dst\nSUMMARY:School\nDTSTART;TZID=America/New_York:20261030T090000\nDTEND;TZID=America/New_York:20261030T093000\nRRULE:FREQ=DAILY'],
      { first: '2026-10-30', tz: 'America/New_York' },
    )
    for (const k of Object.keys(d)) expect([d[k][0].start, d[k][0].end]).toEqual([540, 570])
    // ...and the same series seen from Phoenix moves by the hour New York changed.
    const p = daysOf(
      ['UID:dst\nSUMMARY:School\nDTSTART;TZID=America/New_York:20261030T090000\nDTEND;TZID=America/New_York:20261030T093000\nRRULE:FREQ=DAILY'],
      { first: '2026-10-30' },
    )
    expect(p['2026-10-31'][0].start).toBe(6 * 60)
    expect(p['2026-11-02'][0].start).toBe(7 * 60)
  })

  it('a day is 23 or 25 hours on DST changes, and still ends at 1440', () => {
    const d = daysOf(
      ['UID:long\nSUMMARY:Lock-in\nDTSTART;TZID=America/New_York:20261031T200000\nDTEND;TZID=America/New_York:20261102T080000'],
      { first: '2026-10-31', tz: 'America/New_York', days: 3 },
    )
    expect([d['2026-10-31'][0].start, d['2026-10-31'][0].end]).toEqual([20 * 60, 1440])
    expect([d['2026-11-01'][0].start, d['2026-11-01'][0].end, d['2026-11-01'][0].continued, d['2026-11-01'][0].continues]).toEqual([0, 1440, true, true])
    expect([d['2026-11-02'][0].start, d['2026-11-02'][0].end]).toEqual([0, 480])
  })

  it('shows an override moved in from beyond the window', () => {
    const d = daysOf([
      `UID:w
SUMMARY:Club
DTSTART;TZID=America/Phoenix:20261001T150000
DTEND;TZID=America/Phoenix:20261001T160000
RRULE:FREQ=WEEKLY`,
      `UID:w
RECURRENCE-ID;TZID=America/Phoenix:20261029T150000
SUMMARY:Club (early)
DTSTART;TZID=America/Phoenix:20261016T150000
DTEND;TZID=America/Phoenix:20261016T160000`,
    ])
    expect(titled(d, 'Club')).toEqual(['2026-10-15'])
    expect(titled(d, 'Club (early)')).toEqual(['2026-10-16'])
  })

  it('an override alone (an invite to one instance) is shown', () => {
    const d = daysOf([`UID:o
RECURRENCE-ID;TZID=America/Phoenix:20261014T090000
SUMMARY:Only this one
DTSTART;TZID=America/Phoenix:20261014T100000
DTEND;TZID=America/Phoenix:20261014T110000`])
    expect(d['2026-10-14'].map((e) => [e.title, e.start])).toEqual([['Only this one', 600]])
  })

  it('a master cancelled outright drops every occurrence', () => {
    const d = daysOf(['UID:c\nSUMMARY:Gone\nSTATUS:CANCELLED\nDTSTART:20261013T200000Z\nRRULE:FREQ=DAILY'])
    expect(withEvents(d)).toEqual([])
  })

  it('reads an iCloud-shaped object (VTIMEZONEs, overrides, UTC RECURRENCE-ID)', () => {
    // What production sees: every TZID has its VTIMEZONE, so ical.js resolves
    // zones itself rather than leaving times floating.
    const ics = readFileSync(new URL('./fixtures/apple-recurring.ics', import.meta.url), 'utf8')
    const run = () => {
      const data = cal.buildDays([{ name: 'Family', color: '#3b82f6', ics: [ics] }], FIRST, PHX)
      return Object.fromEntries(data.days.map((d) => [d.key, d.events.map((e) => [e.title, e.start, e.end])]))
    }
    const d = run()
    expect(d).toEqual({
      '2026-10-13': [['Grandma call', 360, 390], ['Swim', 930, 990]],
      '2026-10-14': [['Swim (moved)', 1020, 1080]],
      '2026-10-15': [], // EXDATE
      '2026-10-16': [], // cancelled override
      // THISANDFUTURE from the 17th; the call's override names its slot in UTC.
      // Same start: the earlier end first.
      '2026-10-17': [['Grandma call (late)', 480, 510], ['Swim (new time)', 480, 540]],
      '2026-10-18': [['Swim (new time)', 480, 540]],
      '2026-10-19': [['Swim (new time)', 480, 540]],
    })
    const data = cal.buildDays([{ name: 'Family', color: '#3b82f6', ics: [ics] }], FIRST, PHX)
    const ids = data.days.flatMap((x) => x.events.map((e) => e.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(cal.buildDays([{ name: 'Family', color: '#3b82f6', ics: [ics] }], FIRST, PHX)).toEqual(data)
  })

  it('a UTC EXDATE / RECURRENCE-ID matches an IANA TZID with no VTIMEZONE, whatever came before', () => {
    // ical.js resolves TZIDs through one process-wide registry; the outcome
    // mustn't depend on whether an earlier object registered this zone.
    const bare = (uid: string) => vcal(`UID:${uid}
SUMMARY:Lunch
DTSTART;TZID=America/New_York:20261012T120000
DTEND;TZID=America/New_York:20261012T130000
RRULE:FREQ=DAILY;COUNT=6
EXDATE:20261014T160000Z`, `UID:${uid}
RECURRENCE-ID:20261015T160000Z
SUMMARY:Lunch (late)
DTSTART;TZID=America/New_York:20261015T140000
DTEND;TZID=America/New_York:20261015T150000`)
    const withVtz = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
      'BEGIN:VTIMEZONE', 'TZID:America/New_York',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:other', 'SUMMARY:Other', 'DTSTART;TZID=America/New_York:20261013T090000', 'END:VEVENT',
      'END:VCALENDAR', '',
    ].join('\r\n')
    const run = (uid: string) => {
      const data = cal.buildDays([{ name: 'F', color: '#000000', ics: [bare(uid)] }], FIRST, PHX)
      return Object.fromEntries(data.days.map((d) => [d.key, d.events.map((e) => [e.title, e.start])]))
    }
    const expected = {
      '2026-10-13': [['Lunch', 540]],
      '2026-10-14': [], // EXDATE
      '2026-10-15': [['Lunch (late)', 660]],
      '2026-10-16': [['Lunch', 540]],
      '2026-10-17': [['Lunch', 540]],
      '2026-10-18': [],
      '2026-10-19': [],
    }
    ICAL.TimezoneService.reset() // as in a fresh process
    expect(run('a')).toEqual(expected)
    cal.buildDays([{ name: 'F', color: '#000000', ics: [withVtz] }], FIRST, PHX)
    expect(run('b')).toEqual(expected)
    ICAL.TimezoneService.reset()
    cal.buildDays([{ name: 'F', color: '#000000', ics: [withVtz] }], FIRST, PHX)
    expect(run('c')).toEqual(expected)
  })

  it('one unreadable object does not hide the rest', () => {
    const data = cal.buildDays([{
      name: 'F', color: '#000000',
      ics: ['not ics at all', vcal('UID:ok\nSUMMARY:Fine\nDTSTART:20261013T200000Z\nDTEND:20261013T210000Z')],
    }], FIRST, PHX)
    expect(data.days[0].events.map((e) => e.title)).toEqual(['Fine'])
  })
})

describe('zone helpers', () => {
  it('maps skipped and repeated wall times like zoneinfo fold=0', () => {
    // 2026-03-08 02:30 doesn't exist in New York: read with the EST offset.
    const gap = wallToInstant({ y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 }, 'America/New_York')
    expect(new Date(gap).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // 2026-11-01 01:30 happens twice: the first (EDT).
    const twice = wallToInstant({ y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0 }, 'America/New_York')
    expect(new Date(twice).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('dayStart / localOf / todayKey', () => {
    expect(new Date(dayStart('2026-10-13', PHX)).toISOString()).toBe('2026-10-13T07:00:00.000Z')
    expect(localOf(Date.UTC(2026, 9, 14, 1, 0), PHX)).toEqual({ key: '2026-10-13', mins: 18 * 60 })
    expect(todayKey(PHX, Date.UTC(2026, 9, 14, 6, 59))).toBe('2026-10-13')
    expect(todayKey('America/New_York', Date.UTC(2026, 9, 14, 6, 59))).toBe('2026-10-14')
  })
})

it('cleanColor', () => {
  expect(cal.cleanColor('#FF2968FF', 0)).toBe('#ff2968')
  expect(cal.cleanColor('#1BADF8', 0)).toBe('#1badf8')
  expect(cal.cleanColor(null, 1)).toBe(cal.PALETTE[1])
  expect(cal.cleanColor('blue', 9)).toBe(cal.PALETTE[9 % cal.PALETTE.length])
})

it('current trims past days and caps at seven', () => {
  const data = cal.buildDays([], FIRST, PHX, cal.FETCH_DAYS)
  const env = { data, updated: 1, stale: false, error: null }
  const out = cal.current(env, '2026-10-14')
  const keys = out.data!.days.map((d) => d.key)
  expect(keys[0]).toBe('2026-10-14')
  expect(keys).toHaveLength(7)
  expect(env.data.days).toHaveLength(cal.FETCH_DAYS) // cached value untouched
  expect(cal.current({ data: null, updated: null, stale: true, error: null }, FIRST).data).toBeNull()
})

// --- CalDAV --------------------------------------------------------------

const saved = { ...settings }
afterEach(() => {
  Object.assign(settings, saved)
  cal.setClientFactory(null)
  cal.resetDiscovery()
})

it('missing credentials is a clear source error', async () => {
  Object.assign(settings, { icloudUsername: '', icloudAppPassword: '' })
  const src = new Source('calendar', cal.fetchCalendar, cal.INTERVAL)
  expect(await src.refresh()).toBe(false)
  const env = src.envelope()
  expect(env.data).toBeNull()
  expect(env.stale).toBe(true)
  expect(env.error).toContain('ICLOUD_USERNAME')
})

function fakeCal(displayName: string, components: string[], calendarColor: unknown, objs: string[] = []) {
  const searches: { start: string; end: string }[] = []
  return {
    searches,
    objs,
    dav: { url: 'https://dav.example/' + encodeURIComponent(displayName) + components.join(''), displayName, components, calendarColor } as any,
  }
}

function fakeClient(cals: ReturnType<typeof fakeCal>[]): cal.DavClient {
  return {
    async login() {},
    async fetchCalendars() { return cals.map((c) => c.dav) },
    async fetchCalendarObjects({ calendar, timeRange }) {
      const c = cals.find((x) => x.dav === calendar)!
      c.searches.push(timeRange)
      return c.objs.map((data) => ({ data, url: 'x.ics' }))
    },
  }
}

it('fetch keeps event calendars with the wanted names, Reminders lists out', async () => {
  const ics = vcal('UID:e\nSUMMARY:Dinner\nDTSTART:20261014T010000Z\nDTEND:20261014T020000Z')
  // Apple's calendar-color comes with attributes, so tsdav returns an object.
  const family = fakeCal('Family', ['VEVENT'], { _attributes: { 'symbolic-color': 'custom' }, _text: '#FF2968FF' }, [ics])
  const reminders = fakeCal('Family ⚠️', ['VTODO'], undefined)
  const remindersSame = fakeCal('Family', ['VTODO'], undefined)
  const work = fakeCal('Work', ['VEVENT'], undefined)
  cal.setClientFactory(() => fakeClient([remindersSame, reminders, family, work]))
  Object.assign(settings, { tz: PHX, icloudUsername: 'u', icloudAppPassword: 'p', calendarNames: ['Family'] })

  const feeds = await cal.fetchFeeds(FIRST, PHX)
  expect(feeds.map((f) => [f.name, f.color])).toEqual([['Family', '#ff2968']])
  expect(family.searches).toEqual([{ start: '2026-10-13T07:00:00.000Z', end: '2026-10-21T07:00:00.000Z' }])
  expect(remindersSame.searches).toEqual([])
  const data = cal.buildDays(feeds, FIRST, PHX)
  // 01:00Z on 10-14 is 6 PM on 10-13 in Phoenix.
  expect(data.days[0].events[0].start).toBe(18 * 60)
})

it('no names configured: every event calendar, palette colours in order', async () => {
  const a = fakeCal('A', ['VEVENT', 'VTODO'], undefined)
  const b = fakeCal('B', [], '#00FF00')
  const r = fakeCal('R', ['VTODO'], undefined)
  cal.setClientFactory(() => fakeClient([a, r, b]))
  Object.assign(settings, { icloudUsername: 'u', icloudAppPassword: 'p', calendarNames: [] })
  const feeds = await cal.fetchFeeds(FIRST, PHX)
  expect(feeds.map((f) => [f.name, f.color])).toEqual([['A', cal.PALETTE[0]], ['B', '#00ff00']])
})

it('an unknown calendar name is an error, and discovery is retried', async () => {
  cal.setClientFactory(() => fakeClient([fakeCal('Work', ['VEVENT'], undefined)]))
  Object.assign(settings, { icloudUsername: 'u', icloudAppPassword: 'p', calendarNames: ['Family'] })
  await expect(cal.fetchCalendar()).rejects.toThrow(/Family/)
  expect(cal.hasDiscovery()).toBe(false)
})

it('discovery is cached between refreshes', async () => {
  let logins = 0
  const fam = fakeCal('Family', ['VEVENT'], undefined)
  cal.setClientFactory(() => ({ ...fakeClient([fam]), async login() { logins++ } }))
  Object.assign(settings, { icloudUsername: 'u', icloudAppPassword: 'p', calendarNames: [] })
  await cal.fetchCalendar()
  await cal.fetchCalendar()
  expect(logins).toBe(1)
  expect(fam.searches).toHaveLength(2)
})
