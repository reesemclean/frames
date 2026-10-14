// Start's global configuration: request middleware runs before every server
// route, page render and server function.
import { createMiddleware, createStart } from '@tanstack/react-start'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function netloc(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null // 'null' (sandboxed iframes, file://) and garbage
  }
}

/** Why a write is refused, or null to let it through.
 *
 * Any page open in a LAN browser can POST here (star awards, admin forms);
 * its Origin, or Referer when there's no Origin, then names a different
 * host. Only host:port is compared: TLS ends at Traefik, so the scheme the
 * browser saw isn't the one we see. `Origin: null` is refused. Requests with
 * neither header (curl, scripts) pass.
 *
 * Start's own createCsrfMiddleware trusts Sec-Fetch-Site and compares full
 * origins against the request URL, which behind Traefik is http:// while the
 * browser's Origin is https://. Defining a startInstance also drops Start's
 * default server-function CSRF guard, so this covers server functions too. */
export function crossOriginRefusal(request: Request): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null
  const source = request.headers.get('origin') || request.headers.get('referer')
  if (!source) return null
  const host = (request.headers.get('host') || '').toLowerCase()
  return netloc(source) === host ? null : 'cross-origin request refused'
}

const sameOriginWrites = createMiddleware().server(({ request, next }) => {
  const error = crossOriginRefusal(request)
  if (error) return Response.json({ error }, { status: 403 })
  return next()
})

export const startInstance = createStart(() => ({
  requestMiddleware: [sameOriginWrites],
}))
