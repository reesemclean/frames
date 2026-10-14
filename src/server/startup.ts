// Process startup: open (and migrate) the database, register every source,
// start the refresh loops. Idempotent; the Nitro plugin calls it at boot and
// every route calls it too (the dev server has no Nitro boot).
import { db } from './db'
import { registry } from './cache'
import * as weather from './sources/weather'
import * as calendar from './sources/calendar'
import * as photos from './sources/photos'
import * as stars from './stars'

const g = globalThis as unknown as { __framesStarted?: boolean }

export function ensureStarted(): void {
  if (g.__framesStarted) return
  g.__framesStarted = true
  db()
  for (const feature of [weather, calendar, photos, stars]) feature.setup()
  registry.start()
}
