// STUB: owned by the calendar workstream. Interface: setup() registers the Source;
// endpoint() is what GET /api/calendar returns.
import { registry, Source } from '../cache'
import type { Envelope, Calendar } from '~/lib/types'

export let source: Source<Calendar> | null = null

async function fetchCalendar(): Promise<Calendar> {
  throw new Error('not implemented')
}

export function setup(): void {
  source = registry.add(new Source<Calendar>('calendar', fetchCalendar, 300_000))
}

// Looked up in the registry, not a module variable: Nitro bundles the startup
// plugin apart from the routes, so this module can exist twice in one process.
export function endpoint(): Envelope<Calendar> {
  return registry.get<Calendar>('calendar')!.envelope()
}
