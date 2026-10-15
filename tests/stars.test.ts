// Stars API and /admin, against a throwaway SQLite file per test. Handlers
// are called directly with Request objects (not through the router: route
// files call ensureStarted(), which would start the network sources).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '~/server/config'
import { closeForTests, db } from '~/server/db'
import * as stars from '~/server/stars'
import type { Envelope, Kid, Stars } from '~/lib/types'

const SEED = [
  { id: 'alex', name: 'Alex', color: '#3B82F6', goal: 'Make the bed', target: 5 },
  { name: 'Sam', color: '#ef4444', goal: 'Brush teeth', target: 3 },
]

const realNow = stars.clock.now
const saved = { dataDir: settings.dataDir, starsSeed: settings.starsSeed, tz: settings.tz }
let t = 1_760_000_000_000
let dir = ''

function fresh(seed: string = JSON.stringify(SEED)) {
  closeForTests()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-stars-test-'))
  settings.dataDir = dir
  settings.starsSeed = seed
}

beforeEach(() => {
  t = 1_760_000_000_000
  stars.clock.now = () => t
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fresh()
  stars.setup()
})

afterEach(() => {
  closeForTests()
  fs.rmSync(dir, { recursive: true, force: true })
  stars.clock.now = realNow
  Object.assign(settings, saved)
  vi.restoreAllMocks()
})

// --- helpers ----------------------------------------------------------------

function req(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  return new Request('http://testserver' + url, {
    method,
    body: init.body,
    headers: { host: 'testserver', ...init.headers },
  })
}
const jsonBody = (b: unknown) => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })

async function getKids(): Promise<Record<string, Kid>> {
  const r = stars.handleGet()
  expect(r.status).toBe(200)
  const body = (await r.json()) as Envelope<Stars>
  return Object.fromEntries(body.data!.kids.map((k) => [k.id, k]))
}
const byId = (kids: Kid[]) => Object.fromEntries(kids.map((k) => [k.id, k]))
const award = (kid: string, headers?: Record<string, string>) => stars.handleAward(req('POST', `/api/stars/${kid}/award`, { headers }), kid)
const undo = (id: string) => stars.handleUndo(req('DELETE', `/api/stars/awards/${id}`), id)
const newChart = (kid: string, body?: unknown, raw?: string) =>
  stars.handleNewChart(req('POST', `/api/stars/${kid}/new-chart`, raw != null ? { body: raw } : body === undefined ? {} : jsonBody(body)), kid)
const admin = (data: Record<string, string>, headers?: Record<string, string>) =>
  stars.handleAdminPost(req('POST', '/admin', { body: new URLSearchParams(data), headers }))

// --- GET / seed -------------------------------------------------------------

describe('GET /api/stars', () => {
  it('returns the envelope with the seeded kids', async () => {
    const r = stars.handleGet()
    expect(r.headers.get('cache-control')).toBe('no-cache')
    const body = (await r.json()) as Envelope<Stars>
    expect(body.stale).toBe(false)
    expect(body.error).toBeNull()
    expect(body.updated).toBe(t)
    const ks = body.data!.kids
    expect(ks.map((k) => k.id)).toEqual(['alex', 'sam'])
    expect(ks[0].color).toBe('#3b82f6')
    const ch = ks[0].chart
    expect(ch).toMatchObject({ goal: 'Make the bed', target: 5, count: 0, done: false, awards: [], completedAt: null, startedAt: t })
  })

  it('isolates databases between tests', async () => {
    // A fresh file per test: nothing awarded in other tests shows up here.
    for (const k of Object.values(await getKids())) expect(k.chart.count).toBe(0)
  })
})

describe('seed', () => {
  it('seeds only while the kids table is empty', async () => {
    settings.starsSeed = JSON.stringify([{ name: 'Zed', goal: 'x' }])
    stars.setup()
    expect(Object.keys(await getKids()).sort()).toEqual(['alex', 'sam'])
  })

  it('ignores a bad seed (and seeds nobody from a half-valid one)', () => {
    for (const raw of ['not json', '{"a": 1}', '[1]', '[{"name": "", "goal": "x"}]',
      '[{"name": "A", "goal": "x", "color": "red"}]', '[{"name": "A", "goal": "x"}, {"name": "B"}]']) {
      fresh(raw)
      stars.setup()
      expect(db().$client.prepare('SELECT COUNT(*) AS n FROM kids').get()).toEqual({ n: 0 })
    }
  })

  it('defaults colour and target, slugs ids', async () => {
    fresh(JSON.stringify([{ name: 'Mary Jane!', goal: 'Tidy' }]))
    stars.setup()
    const k = (await getKids())['mary-jane']
    expect(k.color).toBe(stars.DEFAULT_COLOR)
    expect(k.chart.target).toBe(stars.DEFAULT_TARGET)
  })
})

// --- award ------------------------------------------------------------------

describe('award', () => {
  it('counts up, completes at the target, then 409s', async () => {
    for (let i = 1; i <= 2; i++) {
      t += 1000
      const r = await award('sam')
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.award.at).toBe(t)
      expect(body.award.id).toMatch(/^[0-9a-f]{32}$/)
      expect(byId(body.kids).sam.chart).toMatchObject({ count: i, done: false })
    }
    const r = await award('sam')
    const ch = byId((await r.json()).kids).sam.chart
    expect(ch).toMatchObject({ count: 3, done: true, completedAt: t })
    // A second frame holding at the same moment gets 409, not a fourth star.
    const again = await award('sam')
    expect(again.status).toBe(409)
    expect((await again.json()).error).toBeTruthy()
    const kids = await getKids()
    expect(kids.sam.chart.count).toBe(3)
    expect(kids.alex.chart.count).toBe(0)
  })

  it('404s for unknown kids and awards', async () => {
    expect((await award('nobody')).status).toBe(404)
    expect((await newChart('nobody')).status).toBe(404)
    expect((await undo('nope')).status).toBe(404)
  })
})

// --- undo -------------------------------------------------------------------

describe('undo', () => {
  it('undoes one award by id; a second undo is a 409', async () => {
    const a = (await (await award('alex')).json()).award
    await award('alex')
    const r = await undo(a.id)
    expect(r.status).toBe(200)
    const ch = byId((await r.json()).kids).alex.chart
    expect(ch.count).toBe(1)
    expect(ch.awards.map((x: { id: string }) => x.id)).not.toContain(a.id)
    // Two frames both pressing Undo: the second is a no-op 409.
    expect((await undo(a.id)).status).toBe(409)
    expect((await getKids()).alex.chart.count).toBe(1)
  })

  it('refuses after the two-minute window', async () => {
    const a = (await (await award('alex')).json()).award
    t += stars.UNDO_MS + 1
    expect((await undo(a.id)).status).toBe(409)
    expect((await getKids()).alex.chart.count).toBe(1)
  })

  it('allows it right at the edge of the window', async () => {
    const a = (await (await award('alex')).json()).award
    t += stars.UNDO_MS
    expect((await undo(a.id)).status).toBe(200)
  })

  it('un-completes a done chart', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await (await award('sam')).json()).award.id)
    expect((await getKids()).sam.chart.done).toBe(true)
    const r = await undo(ids[2])
    const ch = byId((await r.json()).kids).sam.chart
    expect(ch).toMatchObject({ done: false, completedAt: null, count: 2 })
    // Awarding again completes it again.
    expect(byId((await (await award('sam')).json()).kids).sam.chart.done).toBe(true)
  })

  it('is refused once a new chart has started', async () => {
    const a = (await (await award('alex')).json()).award
    await newChart('alex')
    expect((await undo(a.id)).status).toBe(409)
  })
})

// --- new chart ----------------------------------------------------------------

describe('new chart', () => {
  it('keeps goal and target by default, or takes overrides', async () => {
    for (let i = 0; i < 3; i++) await award('sam')
    const oldId = (await getKids()).sam.chart.id
    t += 5000
    let ch = byId((await (await newChart('sam')).json()).kids).sam.chart
    expect(ch.id).not.toBe(oldId)
    expect(ch).toMatchObject({ goal: 'Brush teeth', target: 3, count: 0, done: false, startedAt: t })
    ch = byId((await (await newChart('sam', { goal: '  Brush teeth ', target: 7 })).json()).kids).sam.chart
    expect(ch).toMatchObject({ goal: 'Brush teeth', target: 7 })
    // Exactly one open chart per kid.
    expect(db().$client.prepare("SELECT COUNT(*) AS n FROM charts WHERE kid_id='sam' AND closed_at IS NULL").get()).toEqual({ n: 1 })
  })

  it('guards stale frames with fromChart', async () => {
    const done = (await getKids()).sam.chart.id
    // Not done yet: a frame can't start over from it.
    expect((await newChart('sam', { fromChart: done })).status).toBe(409)
    for (let i = 0; i < 3; i++) await award('sam')
    const r = await newChart('sam', { fromChart: done })
    expect(r.status).toBe(200)
    const freshChart = byId((await r.json()).kids).sam.chart
    await award('sam')
    // A second frame still showing the old done chart must not close the new one.
    const stale = await newChart('sam', { fromChart: done })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toBeTruthy()
    const ch = (await getKids()).sam.chart
    expect(ch.id).toBe(freshChart.id)
    expect(ch.count).toBe(1)
    // /admin (no fromChart) still restarts at will.
    expect((await newChart('sam')).status).toBe(200)
    expect((await newChart('sam', { fromChart: '1' })).status).toBe(400)
    expect((await newChart('sam', { fromChart: true })).status).toBe(400)
    expect((await newChart('sam', { fromChart: 1.5 })).status).toBe(400)
  })

  it.each([
    [{ target: 0 }], [{ target: 21 }], [{ target: true }], [{ target: 2.5 }], [{ target: 'x' }],
    [{ goal: '' }], [{ goal: 'x'.repeat(81) }], [{ goal: 5 }], [[1, 2]], [null], ['str'],
  ])('rejects %j with 400', async (body) => {
    const r = await newChart('alex', body)
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBeTruthy()
    expect((await getKids()).alex.chart.goal).toBe('Make the bed')
  })

  it('accepts a numeric-string target', async () => {
    const r = await newChart('alex', { target: '6' })
    expect(byId((await r.json()).kids).alex.chart.target).toBe(6)
  })

  it('rejects a body that is not JSON', async () => {
    expect((await newChart('alex', undefined, '{nope')).status).toBe(400)
  })

  it('treats a blank body as no options', async () => {
    expect((await newChart('alex', undefined, '  ')).status).toBe(200)
  })
})

// --- same-origin writes ---------------------------------------------------------

describe('same-origin writes', () => {
  it.each([
    [{}],
    [{ origin: 'http://testserver' }],
    // Behind Traefik: the browser saw https, the app sees the same host.
    [{ host: 'dashboard.mc-home.org', origin: 'https://dashboard.mc-home.org' }],
    [{ referer: 'http://testserver/admin' }],
  ])('passes %j', async (headers) => {
    expect((await award('alex', headers)).status).toBe(200)
  })

  it.each([
    [{ origin: 'http://evil.lan' }],
    [{ origin: 'null' }],
    [{ origin: 'http://testserver:8080' }],
    [{ host: 'dashboard.mc-home.org', origin: 'https://evil.mc-home.org' }],
    [{ referer: 'http://evil.lan/page' }],
  ])('refuses %j', async (headers) => {
    const r = await award('alex', headers)
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBeTruthy()
    expect((await getKids()).alex.chart.count).toBe(0)
    expect((await admin({ op: 'hide', kid: 'alex' }, headers)).status).toBe(403)
  })
})

// --- /admin -------------------------------------------------------------------

describe('/admin', () => {
  const location = (r: Response) => r.headers.get('location') || ''

  it('hides and shows kids; hidden kids 404 on the API', async () => {
    const r = await admin({ op: 'hide', kid: 'sam' })
    expect(r.status).toBe(303)
    expect(Object.keys(await getKids())).toEqual(['alex'])
    expect((await award('sam')).status).toBe(404)
    await admin({ op: 'show', kid: 'sam' })
    expect(Object.keys(await getKids()).sort()).toEqual(['alex', 'sam'])
  })

  it('adds a kid; values are stored raw (React escapes on render)', async () => {
    const r = await admin({ op: 'add', name: '<b>Bo</b>', color: '#00FF00', goal: '"Eat" & <veg>', target: '4' })
    expect(r.status).toBe(303)
    expect(location(r).startsWith('/admin?ok=')).toBe(true)
    const bo = (await getKids())['b-bo-b']
    expect(bo).toMatchObject({ name: '<b>Bo</b>', color: '#00ff00' })
    expect(bo.chart).toMatchObject({ goal: '"Eat" & <veg>', target: 4 })
  })

  it('fixes the star count: down undoes the newest, up adds, done follows', async () => {
    await award('alex'); t += 1000; await award('alex'); t += 1000; await award('alex')
    let r = await admin({ op: 'count', kid: 'alex', count: '1' })
    expect(location(r).startsWith('/admin?ok=')).toBe(true)
    expect((await getKids()).alex.chart).toMatchObject({ count: 1, done: false })
    await admin({ op: 'count', kid: 'alex', count: '5' })
    expect((await getKids()).alex.chart).toMatchObject({ count: 5, done: true })
    await admin({ op: 'count', kid: 'alex', count: '4' })
    expect((await getKids()).alex.chart).toMatchObject({ count: 4, done: false })
    for (const bad of ['6', '-1', '2.5', 'x', '']) {
      r = await admin({ op: 'count', kid: 'alex', count: bad })
      expect(location(r).startsWith('/admin?error=')).toBe(true)
    }
    expect((await getKids()).alex.chart).toMatchObject({ count: 4 })
  })

  it('dedupes ids, and never hands out the reserved "awards" id', async () => {
    await admin({ op: 'add', name: 'Alex', color: '#111111', goal: 'g', target: '5' })
    await admin({ op: 'add', name: 'Awards', color: '#111111', goal: 'g', target: '5' })
    const ids = Object.keys(await getKids())
    expect(ids).toContain('alex-2')
    expect(ids).toContain('awards-2')
    expect(ids).not.toContain('awards')
  })

  it('edits name/colour and starts a new goal; the old chart goes to history', async () => {
    await admin({ op: 'edit', kid: 'alex', name: 'Alexander', color: '#AA0000' })
    let a = (await getKids()).alex
    expect(a).toMatchObject({ name: 'Alexander', color: '#aa0000' })
    await award('alex')
    t += 1000
    const r = await admin({ op: 'chart', kid: 'alex', goal: 'Share toys', target: '6' })
    expect(location(r)).toBe('/admin?ok=' + new URLSearchParams({ x: 'New chart: Share toys.' }).toString().slice(2))
    a = (await getKids()).alex
    expect(a.chart).toMatchObject({ goal: 'Share toys', target: 6, count: 0 })
    const view = stars.adminView().kids.find((k) => k.id === 'alex')!
    expect(view.history).toHaveLength(1)
    expect(view.history[0]).toMatchObject({ goal: 'Make the bed', count: 1, target: 5, status: 'not finished' })
  })

  it('formats admin dates in the household zone', () => {
    // 2025-10-09T06:13:20Z is still Oct 8 in Phoenix (UTC-7).
    t = Date.UTC(2025, 9, 9, 6, 13, 20)
    fresh()
    settings.tz = 'America/Phoenix'
    stars.setup()
    expect(stars.adminView().kids[0].current!.started).toBe('Oct 8')
    expect(stars.adminView().tz).toBe('America/Phoenix')
  })

  it.each([
    [{ op: 'add', name: '', goal: 'g', target: '5' }],
    [{ op: 'add', name: 'A', color: '#12345', goal: 'g', target: '5' }],
    [{ op: 'add', name: 'A', goal: 'g', target: '99' }],
    [{ op: 'edit', kid: 'alex', name: 'M', color: 'blue' }],
    [{ op: 'chart', kid: 'alex', goal: '', target: '5' }],
    [{ op: 'chart', kid: 'alex', goal: 'g', target: '' }],
    [{ op: 'hide', kid: 'ghost' }],
    [{ op: 'nope' }],
  ])('redirects %j back with an error', async (data) => {
    const r = await admin(data)
    expect(r.status).toBe(303)
    expect(location(r).startsWith('/admin?error=')).toBe(true)
    expect((await getKids()).alex).toMatchObject({ name: 'Alex', color: '#3b82f6' })
  })
})

describe('validation helpers', () => {
  it('cleanTarget', () => {
    expect(stars.cleanTarget(5)).toBe(5)
    expect(stars.cleanTarget(' 7 ')).toBe(7)
    for (const bad of [true, 2.5, '2.5', '', 'x', null, undefined, {}, 0, 21, '-1']) {
      expect(() => stars.cleanTarget(bad)).toThrow()
    }
  })
  it('slugify', () => {
    expect(stars.slugify('  Mary--Jane  ')).toBe('mary-jane')
    expect(stars.slugify('!!!')).toBe('kid')
    expect(stars.slugify('a'.repeat(31) + ' b')).toBe('a'.repeat(31))
  })
})
