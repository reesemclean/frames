import { createFileRoute } from '@tanstack/react-router'
import { ensureStarted } from '~/server/startup'
import { endpoint } from '~/server/sources/calendar'

export const Route = createFileRoute('/api/calendar')({
  server: {
    handlers: {
      GET: async () => {
        ensureStarted()
        return Response.json(endpoint(), { headers: { 'Cache-Control': 'no-cache' } })
      },
    },
  },
})
