import { createFileRoute } from '@tanstack/react-router'
import { ensureStarted } from '~/server/startup'
import { handleNewChart } from '~/server/stars'

// POST /api/stars/<kid>/new-chart, body {fromChart?, goal?, target?} -> { kids }.
// 409 if fromChart is given and isn't the current, completed chart.
export const Route = createFileRoute('/api/stars/$kid/new-chart')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        ensureStarted()
        return handleNewChart(request, params.kid)
      },
    },
  },
})
