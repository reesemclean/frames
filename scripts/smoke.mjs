// End-to-end check of the production build: starts .output/server/index.mjs
// on a free port with throwaway data/cache dirs and probes what the frame and
// Traefik depend on (routing, cache headers, envelopes, same-origin writes).
// Run after `npm run build`. Exits non-zero on any failure.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const entry = path.join(root, '.output/server/index.mjs')
if (!fs.existsSync(entry)) {
  console.error(`smoke: ${entry} missing; run npm run build first`)
  process.exit(1)
}

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-smoke-'))
const host = `127.0.0.1:${port}`

const server = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    FRAMES_DATA_DIR: path.join(tmp, 'data'),
    FRAMES_CACHE_DIR: path.join(tmp, 'cache'),
    FRAMES_DASHBOARDS_DIR: path.join(root, 'dashboards'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))

/** SIGTERM, then SIGKILL if it outlives srvx's own 5s graceful shutdown.
 *
 * The listeners above keep draining the child's pipes until it's gone. If we
 * exited first, its shutdown write would hit a closed pipe (EPIPE), and
 * Nitro's error hook logs that to the same broken pipe forever: an orphan
 * spinning at 100% CPU. */
async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = new Promise((r) => setTimeout(r, 10_000, 'timeout'))
  if ((await Promise.race([exited, timer])) === 'timeout') {
    child.kill('SIGKILL')
    await exited
  }
}

/** A raw request: no redirects followed, any Host/Origin header allowed. */
function request(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { host, accept: '*/*', ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}
const get = (p, h) => request('GET', p, h)

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL ${name}: ${e.message}`)
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg)
}
function json(r) {
  try {
    return JSON.parse(r.body)
  } catch {
    throw new Error(`not JSON: ${r.body.slice(0, 120)}`)
  }
}

try {
  // Wait for the server (Nitro also starts the source loops at boot).
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await get('/healthz')).status === 200) break
    } catch {}
    if (server.exitCode != null || Date.now() > deadline) throw new Error('server did not start')
    await new Promise((r) => setTimeout(r, 250))
  }

  await check('GET /healthz', async () => {
    const r = await get('/healthz')
    expect(r.status === 200, `status ${r.status}`)
    expect(json(r).ok === true, r.body)
  })

  await check('GET / lists dashboards, no-cache', async () => {
    const r = await get('/')
    expect(r.status === 200, `status ${r.status}`)
    expect(r.headers['cache-control'] === 'no-cache', `cache-control ${r.headers['cache-control']}`)
    expect(r.body.includes('href="/example"'), 'no link to /example')
  })

  let page = ''
  await check('GET /example renders the stage, no-cache', async () => {
    const r = await get('/example')
    page = r.body
    expect(r.status === 200, `status ${r.status}`)
    expect(r.headers['cache-control'] === 'no-cache', `cache-control ${r.headers['cache-control']}`)
    expect(r.headers['content-type']?.startsWith('text/html'), `content-type ${r.headers['content-type']}`)
    expect(r.body.includes('id="stage"'), 'no #stage in the page')
  })

  for (const p of ['/nope', '/..%2fetc', '/..%2F..%2Fetc%2Fpasswd', '/example.html', '/Example']) {
    await check(`GET ${p} is 404`, async () => {
      const r = await get(p)
      expect(r.status === 404, `status ${r.status}`)
      expect(!r.body.includes('root:'), 'leaked a file')
    })
  }

  for (const source of ['weather', 'calendar', 'photos', 'stars']) {
    await check(`GET /api/${source} is an envelope, no-cache`, async () => {
      const r = await get(`/api/${source}`)
      expect(r.status === 200, `status ${r.status}`)
      expect(r.headers['cache-control'] === 'no-cache', `cache-control ${r.headers['cache-control']}`)
      const e = json(r)
      for (const k of ['data', 'updated', 'stale', 'error']) expect(k in e, `no "${k}" in ${r.body.slice(0, 120)}`)
      expect(typeof e.stale === 'boolean', 'stale is not a boolean')
    })
  }

  await check('GET /api/version/example matches the page; /nope 404', async () => {
    const r = await get('/api/version/example')
    expect(r.status === 200, `status ${r.status}`)
    const v = json(r).version
    expect(typeof v === 'string' && v.length > 0, r.body)
    const page = await get('/example')
    expect(page.body.includes(v), 'page has a different version (would reload forever)')
    expect((await get('/api/version/nope')).status === 404, 'unknown slug not 404')
  })

  await check('hashed /assets/* are immutable', async () => {
    const assets = [...new Set(page.match(/\/assets\/[\w.-]+\.(?:js|css)/g) || [])]
    expect(assets.length >= 2, `found ${assets.length} assets in /example`)
    for (const a of assets) {
      const r = await get(a)
      expect(r.status === 200, `${a}: status ${r.status}`)
      expect(/immutable/.test(r.headers['cache-control'] || ''), `${a}: cache-control ${r.headers['cache-control']}`)
    }
    expect((await get('/assets/gone-00000000.js')).status === 404, 'missing asset not 404')
  })

  // A real write route; the kid doesn't exist, so a write that gets through
  // is a 4xx other than 403 and changes nothing.
  const write = '/api/stars/nobody/award'
  const refused = [
    ['other host', { origin: 'http://evil.lan' }],
    ['Origin: null', { origin: 'null' }],
    ['other port', { origin: `http://127.0.0.1:${port + 1}` }],
    ['other-host Referer', { referer: 'http://evil.lan/page' }],
    ['sibling subdomain behind Traefik', { host: 'dashboard.mc-home.org', origin: 'https://evil.mc-home.org' }],
  ]
  for (const [name, headers] of refused) {
    await check(`CSRF refuses POST: ${name}`, async () => {
      const r = await request('POST', write, headers)
      expect(r.status === 403, `status ${r.status}`)
      expect(typeof json(r).error === 'string', 'no {error}')
    })
  }
  const allowed = [
    ['no Origin or Referer', {}],
    ['same Origin', { origin: `http://${host}` }],
    ['https Origin behind Traefik', { host: 'dashboard.mc-home.org', origin: 'https://dashboard.mc-home.org' }],
    ['same-host Referer', { referer: `http://${host}/admin` }],
  ]
  for (const [name, headers] of allowed) {
    await check(`CSRF passes POST: ${name}`, async () => {
      const r = await request('POST', write, headers)
      expect(r.status !== 403, `status ${r.status}: ${r.body.slice(0, 120)}`)
    })
  }
  await check('CSRF lets cross-origin GET through', async () => {
    expect((await get('/api/weather', { origin: 'http://evil.lan' })).status === 200, 'refused')
  })

  // Same-origin checks can't stop a click inside a framed /admin (its Origin
  // matches), so the page must refuse to be framed.
  await check('GET /admin refuses framing, no-cache', async () => {
    const r = await get('/admin')
    expect(r.status === 200, `status ${r.status}`)
    expect(r.headers['cache-control'] === 'no-cache', `cache-control ${r.headers['cache-control']}`)
    expect(r.headers['x-frame-options'] === 'DENY', `x-frame-options ${r.headers['x-frame-options']}`)
    expect(
      /frame-ancestors 'none'/.test(r.headers['content-security-policy'] || ''),
      `content-security-policy ${r.headers['content-security-policy']}`,
    )
  })
} catch (e) {
  failures++
  console.log(`FAIL ${e.message}`)
} finally {
  await stop(server)
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures) {
  console.log(`\n${failures} failure(s). Server output:\n${log}`)
  process.exit(1)
}
console.log('\nsmoke ok')
process.exit(0)
