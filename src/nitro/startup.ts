// Run startup when the process starts, not when the first request arrives:
// a frame might be the first thing to ask, and it should get warm data.
import { ensureStarted } from '../server/startup'

export default function startup() {
  ensureStarted()
}
