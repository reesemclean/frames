// Star charts: one current chart per kid, a star per award, undo by award id.
//
// Everything lives in SQLite (kids, charts, awards), so every frame shows the
// same counts and they survive restarts. Writes run in tx() (BEGIN
// IMMEDIATE): two frames awarding the last star at the same moment serialize,
// and the second gets 409 instead of a sixth star.
//
// Kids and goals are managed on /admin. A fresh database can be seeded from
// FRAMES_STARS_SEED (settings.starsSeed), a JSON list read only while the
// kids table is empty:
//
//   FRAMES_STARS_SEED='[{"id": "alex", "name": "Alex", "color": "#3b82f6",
//                        "goal": "Make the bed", "target": 5}]'
//
// id is optional (slugged from name), color defaults to blue, target to 5.
//
// API (the `data` of GET /api/stars is {kids:[...]}; writes return kids too):
//   GET    /api/stars
//   POST   /api/stars/<kid>/award          -> {award:{id, at}, kids}
//   DELETE /api/stars/awards/<id>          -> {kids}   (within 2 min, chart open)
//   POST   /api/stars/<kid>/new-chart      -> {kids}   (body optional {goal, target, fromChart})
//
// A frame sends fromChart (the done chart it shows): 409 unless that is still
// the open chart and it is done, so a stale frame can't close a chart another
// frame just started. /admin omits it to set a new goal at any time.
//
// Stars aren't a cached Source: the database is the cache, and a read is a
// few small indexed queries, so GET reads it directly and is never stale.
import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { settings } from './config'
import { db, tx, type DB } from './db'
import { awards, charts, kids } from './schema'
import type { Envelope, Kid, Stars } from '~/lib/types'

export const UNDO_MS = 2 * 60 * 1000
export const DEFAULT_COLOR = '#3b82f6'
export const DEFAULT_TARGET = 5
export const MAX_TARGET = 20
export const MAX_GOAL = 80
export const MAX_NAME = 40
const COLOR = /^#[0-9a-fA-F]{6}$/
// Kid ids share the URL space with /api/stars/awards/<id>; the router's
// static segment would win, so no kid may be called "awards".
const RESERVED_IDS = new Set(['awards'])
export const NO_CACHE = { 'Cache-Control': 'no-cache' }

/** A request the data can't satisfy; status is the HTTP code to send. */
export class StarsError extends Error {
  readonly isStarsError = true
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'StarsError'
  }
}

// Duck-typed: Nitro may bundle this module twice (the startup plugin apart
// from the routes), so instanceof against "the" class isn't reliable.
export function isStarsError(e: unknown): e is StarsError {
  return !!e && typeof e === 'object' && (e as StarsError).isStarsError === true
}

/** One place for the clock, so tests can step past the undo window. */
export const clock = { now: (): number => Date.now() }

// --- validation -------------------------------------------------------------

function text(value: unknown, what: string, limit: number): string {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) throw new StarsError(400, `${what} is required`)
  if (s.length > limit) throw new StarsError(400, `${what} is longer than ${limit} characters`)
  return s
}

export const cleanName = (v: unknown) => text(v, 'name', MAX_NAME)
export const cleanGoal = (v: unknown) => text(v, 'goal', MAX_GOAL)

export function cleanColor(value: unknown): string {
  const color = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_COLOR
  if (!COLOR.test(color)) throw new StarsError(400, 'color must be #rrggbb')
  return color.toLowerCase()
}

/** A whole number 1..MAX_TARGET, as a number or a form/JSON string. true is not a target. */
export function cleanTarget(value: unknown): number {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) n = parseInt(value, 10)
  else throw new StarsError(400, 'target must be a whole number')
  if (!Number.isInteger(n)) throw new StarsError(400, 'target must be a whole number')
  if (n < 1 || n > MAX_TARGET) throw new StarsError(400, `target must be 1 to ${MAX_TARGET}`)
  return n
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32).replace(/-+$/, '')
  return slug || 'kid'
}

// --- reads ------------------------------------------------------------------

export type ChartRow = typeof charts.$inferSelect
export type KidRow = typeof kids.$inferSelect

export function currentChart(d: DB, kidId: string): ChartRow | undefined {
  return d.select().from(charts)
    .where(and(eq(charts.kidId, kidId), isNull(charts.closedAt)))
    .orderBy(desc(charts.id)).limit(1).get()
}

export function liveAwards(d: DB, chartId: number): { id: string; at: number }[] {
  return d.select({ id: awards.id, at: awards.at }).from(awards)
    .where(and(eq(awards.chartId, chartId), isNull(awards.undoneAt)))
    .orderBy(asc(awards.at), sql`rowid`).all()
}

export function chartJson(d: DB, chart: ChartRow): Kid['chart'] {
  const list = liveAwards(d, chart.id)
  return {
    id: chart.id,
    goal: chart.goal,
    target: chart.target,
    count: list.length,
    done: chart.completedAt != null,
    startedAt: chart.startedAt,
    completedAt: chart.completedAt,
    awards: list,
  }
}

/** Active kids in order. Every kid gets a chart when added (addKid), so
 * `chart` is always an object; a kid somehow without one is left out rather
 * than breaking that promise. */
export function kidsJson(d: DB): Kid[] {
  const rows = d.select().from(kids).where(eq(kids.active, 1)).orderBy(asc(kids.sort), asc(kids.name)).all()
  const out: Kid[] = []
  for (const k of rows) {
    const chart = currentChart(d, k.id)
    if (chart) out.push({ id: k.id, name: k.name, color: k.color, chart: chartJson(d, chart) })
  }
  return out
}

export function getKid(d: DB, kidId: string, activeOnly = true): KidRow {
  const kid = d.select().from(kids).where(eq(kids.id, kidId)).get()
  if (!kid || (activeOnly && !kid.active)) throw new StarsError(404, `no kid ${JSON.stringify(kidId)}`)
  return kid
}

export function allKids(d: DB): KidRow[] {
  return d.select().from(kids).orderBy(asc(kids.sort), asc(kids.name)).all()
}

export function closedCharts(d: DB, kidId: string, limit: number): ChartRow[] {
  return d.select().from(charts)
    .where(and(eq(charts.kidId, kidId), isNotNull(charts.closedAt)))
    .orderBy(desc(charts.id)).limit(limit).all()
}

// --- writes (callers hold tx()) ---------------------------------------------

/** Close the kid's current chart (it stays in history) and open a new one. */
export function startChart(d: DB, kidId: string, goal: string, target: number): number {
  const now = clock.now()
  d.update(charts).set({ closedAt: now }).where(and(eq(charts.kidId, kidId), isNull(charts.closedAt))).run()
  const r = d.insert(charts).values({ kidId, goal, target, startedAt: now }).run()
  return Number(r.lastInsertRowid)
}

/** Every kid starts with a chart: the API promises `chart` is an object. */
export function addKid(d: DB, name: string, color: string, goal: string, target: number, kidId?: unknown): string {
  const base = slugify(typeof kidId === 'string' && kidId ? kidId : name)
  const taken = (id: string) => RESERVED_IDS.has(id) || !!d.select({ id: kids.id }).from(kids).where(eq(kids.id, id)).get()
  let id = base
  for (let n = 2; taken(id); n++) id = `${base}-${n}`
  const max = d.select({ m: sql<number>`COALESCE(MAX(${kids.sort}), -1)` }).from(kids).get()
  d.insert(kids).values({ id, name, color, sort: (max?.m ?? -1) + 1 }).run()
  startChart(d, id, goal, target)
  return id
}

export function award(kidId: string): { award: { id: string; at: number }; kids: Kid[] } {
  return tx((d) => {
    getKid(d, kidId)
    const chart = currentChart(d, kidId)
    if (!chart) throw new StarsError(409, 'no chart to add a star to')
    if (chart.completedAt != null) throw new StarsError(409, 'this chart is already done')
    const at = clock.now()
    const id = randomBytes(16).toString('hex')
    d.insert(awards).values({ id, chartId: chart.id, at }).run()
    if (liveAwards(d, chart.id).length >= chart.target) {
      d.update(charts).set({ completedAt: at }).where(eq(charts.id, chart.id)).run()
    }
    return { award: { id, at }, kids: kidsJson(d) }
  })
}

export function undo(awardId: string): { kids: Kid[] } {
  return tx((d) => {
    const row = d.select({
      at: awards.at, undoneAt: awards.undoneAt, chartId: charts.id,
      target: charts.target, completedAt: charts.completedAt, closedAt: charts.closedAt,
    }).from(awards).innerJoin(charts, eq(charts.id, awards.chartId)).where(eq(awards.id, awardId)).get()
    if (!row) throw new StarsError(404, 'no such star')
    // Two frames both pressing Undo: the second is a no-op 409.
    if (row.undoneAt != null) throw new StarsError(409, 'already undone')
    if (row.closedAt != null) throw new StarsError(409, 'that chart is finished')
    const now = clock.now()
    if (now - row.at > UNDO_MS) throw new StarsError(409, 'too late to undo')
    d.update(awards).set({ undoneAt: now }).where(eq(awards.id, awardId)).run()
    if (row.completedAt != null && liveAwards(d, row.chartId).length < row.target) {
      d.update(charts).set({ completedAt: null }).where(eq(charts.id, row.chartId)).run()
    }
    return { kids: kidsJson(d) }
  })
}

/** Same goal and target as the current chart unless overridden. */
export function newChart(kidId: string, goal?: unknown, target?: unknown, fromChart?: number | null): { kids: Kid[] } {
  return tx((d) => {
    getKid(d, kidId)
    const chart = currentChart(d, kidId)
    if (fromChart != null) {
      if (!chart || chart.id !== fromChart) throw new StarsError(409, 'a new chart already started')
      if (chart.completedAt == null) throw new StarsError(409, "this chart isn't done yet")
    }
    if (goal == null && !chart) throw new StarsError(400, 'goal is required')
    const g = cleanGoal(goal != null ? goal : chart!.goal)
    const t = cleanTarget(target != null ? target : chart ? chart.target : DEFAULT_TARGET)
    startChart(d, kidId, g, t)
    return { kids: kidsJson(d) }
  })
}

/** Admin: rename / recolour (hidden kids too). Returns the clean name. */
export function editKid(kidId: string, name: unknown, color: unknown): string {
  const n = cleanName(name)
  const c = cleanColor(color)
  tx((d) => {
    getKid(d, kidId, false)
    d.update(kids).set({ name: n, color: c }).where(eq(kids.id, kidId)).run()
  })
  return n
}

/** Admin: hide from / show on the frames. Charts are kept either way. Returns the name. */
export function setActive(kidId: string, active: boolean): string {
  return tx((d) => {
    const kid = getKid(d, kidId, false)
    d.update(kids).set({ active: active ? 1 : 0 }).where(eq(kids.id, kid.id)).run()
    return kid.name
  })
}

/** Seed from settings.starsSeed, only while the kids table is empty. */
export function seed(raw: string = settings.starsSeed): void {
  raw = raw.trim()
  if (!raw) return
  try {
    let entries: unknown
    try { entries = JSON.parse(raw) } catch { throw new Error('not valid JSON') }
    if (!Array.isArray(entries) || !entries.every((e) => e && typeof e === 'object' && !Array.isArray(e))) {
      throw new Error('expected a JSON list of objects')
    }
    const seeded = tx((d) => {
      const n = d.select({ n: sql<number>`COUNT(*)` }).from(kids).get()
      if (n && n.n) return false
      for (const e of entries as Record<string, unknown>[]) {
        addKid(d, cleanName(e.name), cleanColor(e.color), cleanGoal(e.goal),
          cleanTarget(e.target ?? DEFAULT_TARGET), e.id)
      }
      return true
    })
    if (seeded) console.info(`[stars] seeded ${(entries as unknown[]).length} kid(s) from FRAMES_STARS_SEED`)
  } catch (e) {
    // A bad seed shouldn't stop the dashboards; /admin can still add kids.
    // The transaction rolled back, so a half-valid list seeds nobody.
    console.error(`[stars] FRAMES_STARS_SEED ignored: ${(e as Error)?.message || e}`)
  }
}

export function setup(): void {
  seed()
}

// --- HTTP -------------------------------------------------------------------

/**
 * Refuse writes (star awards, admin forms) sent by some other site's page.
 * Any page open in a LAN browser can POST here; its Origin (or Referer) then
 * names a different host. Only host:port is compared: TLS ends at Traefik,
 * so the scheme the browser saw isn't the one we see. Requests with neither
 * header (curl, scripts) pass.
 */
export function crossOrigin(request: Request): boolean {
  const source = request.headers.get('origin') || request.headers.get('referer')
  if (!source) return false
  const host = (request.headers.get('host') || '').toLowerCase()
  let netloc = ''
  try { netloc = new URL(source).host.toLowerCase() } catch { /* 'null' and junk: refused */ }
  return netloc !== host
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_CACHE })
}

/** Wrap a write handler: same-origin check, StarsError → { error } with its status. */
export async function write(request: Request, fn: () => unknown): Promise<Response> {
  if (crossOrigin(request)) return json({ error: 'cross-origin request refused' }, 403)
  try {
    return json(await fn())
  } catch (e) {
    if (isStarsError(e)) return json({ error: e.message }, e.status)
    throw e
  }
}

export function getEnvelope(): Envelope<Stars> {
  return { data: { kids: kidsJson(db()) }, updated: clock.now(), stale: false, error: null }
}

export function handleGet(): Response {
  return json(getEnvelope())
}

export function handleAward(request: Request, kid: string): Promise<Response> {
  return write(request, () => award(kid))
}

export function handleUndo(request: Request, awardId: string): Promise<Response> {
  return write(request, () => undo(awardId))
}

export function handleNewChart(request: Request, kid: string): Promise<Response> {
  return write(request, async () => {
    const raw = await request.text()
    let body: Record<string, unknown> = {}
    if (raw.trim()) {
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new StarsError(400, 'body must be JSON') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new StarsError(400, 'body must be a JSON object')
      }
      body = parsed as Record<string, unknown>
    }
    const from = body.fromChart
    if (from != null && (typeof from !== 'number' || !Number.isInteger(from))) {
      throw new StarsError(400, 'fromChart must be a chart id')
    }
    return newChart(kid, body.goal, body.target, from as number | null | undefined)
  })
}

// --- /admin -----------------------------------------------------------------
// A parent's phone page. Plain forms POST to /admin and get a 303 back to
// /admin?ok=… or ?error=…, so it works with no JS at all. Dates are
// formatted here, in the household zone: the phone's zone may differ, and
// formatting on the client would also mismatch the server render.

export const HISTORY = 6

export interface AdminChart { goal: string; count: number; target: number; started: string; status: string }
export interface AdminKid {
  id: string
  name: string
  color: string
  active: boolean
  current: { goal: string; count: number; target: number; done: boolean; started: string } | null
  history: AdminChart[]
}
export interface AdminView { kids: AdminKid[]; tz: string; defaults: { color: string; target: number; maxGoal: number; maxName: number; maxTarget: number } }

function dayLabel(ms: number | null): string {
  if (ms == null) return '—'
  return new Intl.DateTimeFormat('en-US', { timeZone: settings.tz, month: 'short', day: 'numeric' }).format(new Date(ms))
}

export function adminView(): AdminView {
  const d = db()
  const list = allKids(d).map((k): AdminKid => {
    const chart = currentChart(d, k.id)
    const info = chart ? chartJson(d, chart) : null
    return {
      id: k.id,
      name: k.name,
      color: k.color,
      active: !!k.active,
      current: info && { goal: info.goal, count: info.count, target: info.target, done: info.done, started: dayLabel(info.startedAt) },
      history: closedCharts(d, k.id, HISTORY).map((c) => ({
        goal: c.goal,
        count: liveAwards(d, c.id).length,
        target: c.target,
        started: dayLabel(c.startedAt),
        status: c.completedAt != null ? 'done ' + dayLabel(c.completedAt) : 'not finished',
      })),
    }
  })
  return {
    kids: list,
    tz: settings.tz,
    defaults: { color: DEFAULT_COLOR, target: DEFAULT_TARGET, maxGoal: MAX_GOAL, maxName: MAX_NAME, maxTarget: MAX_TARGET },
  }
}

function back(msg: { ok?: string; error?: string }): Response {
  const q = new URLSearchParams()
  if (msg.ok) q.set('ok', msg.ok)
  if (msg.error) q.set('error', msg.error)
  const qs = q.toString()
  return new Response(null, { status: 303, headers: { Location: '/admin' + (qs ? '?' + qs : ''), ...NO_CACHE } })
}

/** POST /admin: one form endpoint, `op` says which form it was. */
export async function handleAdminPost(request: Request): Promise<Response> {
  if (crossOrigin(request)) return json({ error: 'cross-origin request refused' }, 403)
  let form: FormData
  try { form = await request.formData() } catch { return back({ error: 'unreadable form' }) }
  const field = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' ? v : undefined
  }
  const kid = field('kid') || ''
  try {
    switch (field('op')) {
      case 'add': {
        const name = cleanName(field('name'))
        const color = cleanColor(field('color'))
        const goal = cleanGoal(field('goal'))
        const target = cleanTarget(field('target') || DEFAULT_TARGET)
        tx((d) => addKid(d, name, color, goal, target))
        return back({ ok: `Added ${name}.` })
      }
      case 'edit':
        return back({ ok: `Saved ${editKid(kid, field('name'), field('color'))}.` })
      case 'chart': {
        const goal = cleanGoal(field('goal'))
        // A missing/blank target is a 400, not "keep the old one": the form always sends it.
        newChart(kid, goal, field('target') ?? '')
        return back({ ok: `New chart: ${goal}.` })
      }
      case 'hide':
        return back({ ok: `${setActive(kid, false)} is hidden from the frames.` })
      case 'show':
        return back({ ok: `${setActive(kid, true)} is back on the frames.` })
      default:
        return back({ error: 'unknown action' })
    }
  } catch (e) {
    if (isStarsError(e)) return back({ error: e.message })
    throw e
  }
}
