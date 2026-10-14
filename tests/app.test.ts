// The same-origin rule for writes. The full stack (routing, headers, the
// built server) is covered by scripts/smoke.mjs against a production build.
import { describe, expect, it } from 'vitest'
import { crossOriginRefusal } from '~/start'

function req(method: string, headers: Record<string, string>): Request {
  return new Request('http://testserver/api/stars/award', {
    method,
    headers: { host: 'testserver', ...headers },
  })
}

describe('same-origin writes', () => {
  it.each<[string, Record<string, string>]>([
    ['no Origin or Referer (curl, scripts)', {}],
    ['same Origin', { origin: 'http://testserver' }],
    // Behind Traefik: the browser saw https, the app sees the same host.
    ['https Origin behind Traefik', { host: 'dashboard.mc-home.org', origin: 'https://dashboard.mc-home.org' }],
    ['host compared case-insensitively', { host: 'Dashboard.MC-home.org', origin: 'https://dashboard.mc-home.org' }],
    ['same-host Referer', { referer: 'http://testserver/admin' }],
  ])('passes: %s', (_, headers) => {
    expect(crossOriginRefusal(req('POST', headers))).toBeNull()
  })

  it.each<[string, Record<string, string>]>([
    ['other host', { origin: 'http://evil.lan' }],
    ['Origin: null', { origin: 'null' }],
    ['other port', { origin: 'http://testserver:8080' }],
    ['sibling subdomain', { host: 'dashboard.mc-home.org', origin: 'https://evil.mc-home.org' }],
    ['other-host Referer', { referer: 'http://evil.lan/page' }],
    // Origin wins over Referer when both are present.
    ['bad Origin, good Referer', { origin: 'http://evil.lan', referer: 'http://testserver/admin' }],
    ['garbage Referer', { referer: 'not a url' }],
  ])('refuses: %s', (_, headers) => {
    expect(crossOriginRefusal(req('POST', headers))).toMatch(/cross-origin/)
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('checks %s too', (method) => {
    expect(crossOriginRefusal(req(method, { origin: 'http://evil.lan' }))).not.toBeNull()
  })

  it.each(['GET', 'HEAD', 'OPTIONS'])('lets cross-origin %s through', (method) => {
    expect(crossOriginRefusal(req(method, { origin: 'http://evil.lan' }))).toBeNull()
  })
})
