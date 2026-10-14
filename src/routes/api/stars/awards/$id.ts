import { createFileRoute } from '@tanstack/react-router'
import { ensureStarted } from '~/server/startup'
import { handleUndo } from '~/server/stars'

// DELETE /api/stars/awards/<id> -> { kids }; 409 if already undone, the chart
// moved on, or it's past the two-minute undo window.
export const Route = createFileRoute('/api/stars/awards/$id')({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        ensureStarted()
        return handleUndo(request, params.id)
      },
    },
  },
})
