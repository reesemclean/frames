// The resized photos and backdrops, from cacheDir/photos. Names are
// content-addressed (a changed photo gets a new name), so they're cached
// forever. Only names the photos source writes are served: no paths, no
// traversal, nothing but [a-z0-9-]+.jpg.
import fs from 'node:fs'
import path from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { photosDir } from '~/server/sources/photos'

const NAME = /^[a-z0-9-]+\.jpg$/

function notFound(): Response {
  // no-store: a frame must not remember a miss for a file that appears later.
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
}

export const Route = createFileRoute('/photos/$')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        let name: string
        try {
          name = decodeURIComponent(params._splat || '')
        } catch {
          return notFound()
        }
        if (!NAME.test(name)) return notFound()
        const dir = path.resolve(photosDir())
        const file = path.resolve(dir, name)
        if (path.dirname(file) !== dir) return notFound()
        let body: Buffer
        try {
          body = await fs.promises.readFile(file)
        } catch {
          return notFound()
        }
        return new Response(new Uint8Array(body), {
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': String(body.length),
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      },
      // Anything else would fall through to the page renderer.
      ANY: async () => new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }),
    },
  },
})
