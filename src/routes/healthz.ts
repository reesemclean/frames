import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/server/db'
import { ensureStarted } from '~/server/startup'

export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: async () => {
        ensureStarted()
        db().$client.prepare('SELECT 1').get()
        return Response.json({ ok: true })
      },
    },
  },
})
