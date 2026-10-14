// Run startup when the process starts, not when the first request arrives:
// a frame might be the first thing to ask, and it should get warm data.
import type { NitroApp } from 'nitro/types'
import { registry } from '../server/cache'
import { closeDb } from '../server/db'
import { ensureStarted } from '../server/startup'

export default function startup(nitroApp: NitroApp) {
  ensureStarted()
  // On SIGTERM: stop the refresh loops (aborting any in-flight refresh),
  // give a running one a moment to stop at its next check, and close SQLite.
  // Short of Docker's 10 s grace, so the close itself is never SIGKILLed.
  nitroApp.hooks?.hook('close', async () => {
    registry.stop()
    await registry.settle(3_000)
    closeDb()
  })
}
