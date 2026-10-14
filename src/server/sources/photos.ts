// STUB: owned by the photos workstream. Interface: setup() registers the Source;
// endpoint() is what GET /api/photos returns.
import { registry, Source } from '../cache'
import type { Envelope, Photos } from '~/lib/types'

export let source: Source<Photos> | null = null

async function fetchPhotos(): Promise<Photos> {
  throw new Error('not implemented')
}

export function setup(): void {
  source = registry.add(new Source<Photos>('photos', fetchPhotos, 1_800_000))
}

// Looked up in the registry, not a module variable: Nitro bundles the startup
// plugin apart from the routes, so this module can exist twice in one process.
export function endpoint(): Envelope<Photos> {
  return registry.get<Photos>('photos')!.envelope()
}
