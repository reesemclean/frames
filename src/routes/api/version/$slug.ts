// GET /api/version/<slug>: the frame checks this every few minutes and
// reloads itself when it no longer matches its page (lib/reload.ts).
import { createFileRoute } from '@tanstack/react-router'
import { dashboardVersion } from '~/server/dashboards'

export const Route = createFileRoute('/api/version/$slug')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const version = dashboardVersion(params.slug)
        const headers = { 'Cache-Control': 'no-cache' }
        return version
          ? Response.json({ version }, { headers })
          : Response.json({ error: 'no such dashboard' }, { status: 404, headers })
      },
    },
  },
})
