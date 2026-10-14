// STUB: owned by the weather workstream. Interface: setup() registers the Source;
// endpoint() is what GET /api/weather returns.
import { registry, Source } from '../cache'
import type { Envelope, Weather } from '~/lib/types'

export let source: Source<Weather> | null = null

async function fetchWeather(): Promise<Weather> {
  throw new Error('not implemented')
}

export function setup(): void {
  source = registry.add(new Source<Weather>('weather', fetchWeather, 900_000))
}

// Looked up in the registry, not a module variable: Nitro bundles the startup
// plugin apart from the routes, so this module can exist twice in one process.
export function endpoint(): Envelope<Weather> {
  return registry.get<Weather>('weather')!.envelope()
}
