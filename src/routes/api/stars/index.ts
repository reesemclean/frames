import { createFileRoute } from '@tanstack/react-router'
import { ensureStarted } from '~/server/startup'
import { handleGet } from '~/server/stars'

// GET /api/stars: the Envelope<Stars> every frame polls. Never stale: it's
// read straight from SQLite.
export const Route = createFileRoute('/api/stars/')({
  server: {
    handlers: {
      GET: async () => {
        ensureStarted()
        return handleGet()
      },
    },
  },
})
