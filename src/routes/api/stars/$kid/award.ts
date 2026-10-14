import { createFileRoute } from '@tanstack/react-router'
import { ensureStarted } from '~/server/startup'
import { handleAward } from '~/server/stars'

// POST /api/stars/<kid>/award -> { award: {id, at}, kids }; 409 once the chart is done.
export const Route = createFileRoute('/api/stars/$kid/award')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        ensureStarted()
        return handleAward(request, params.kid)
      },
    },
  },
})
