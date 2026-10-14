// Photos: an iCloud Shared Album and/or a folder, resized for the frame.
//
// Every photo is fetched once, shrunk to fit 1280×800 with its metadata (GPS
// included) dropped, and portrait photos also get a pre-blurred backdrop
// (see ../photos/process). The results are indexed in the `photos` table and
// served from cacheDir/photos under content-addressed names, so the
// immutable cache headers on /photos/<name> are safe.
//
// Work per refresh is capped (maxPerRun); a big album fills in over a few
// quick refreshes instead of blocking for an hour. A photo that disappears
// from its source is kept for MISSING_GRACE before its files are deleted, so
// a briefly broken album or folder doesn't wipe the cache.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { registry, Source } from '../cache'
import { settings } from '../config'
import { db, tx } from '../db'
import { photos as T } from '../schema'
import { processImage, type Processed } from '../photos/process'
import type { Envelope, Photo, Photos } from '~/lib/types'

export const INTERVAL_MS = 30 * 60_000
export const ASSET_BATCH = 25
export const MISSING_GRACE = 7 * 24 * 3600_000
// A photo that failed to download or decode is left alone this long, so it
// can't eat every run's budget (or keep the backlog kick firing) forever.
export const RETRY_FAILED_MS = 6 * 3600_000
const FOLDER_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp'])
// The prebuilt sharp's libheif has only the AV1 decoder (AVIF), not HEVC, so
// iPhone HEIC files can't be read. They're counted and logged, not tried.
const FOLDER_UNREADABLE = new Set(['.heic', '.heif'])
const ALBUM_START_HOST = 'p23-sharedstreams.icloud.com'
const FETCH_TIMEOUT_MS = 30_000
// The whole folder sync (scan, reads, resizes). A hung NAS mount can't be
// cancelled, only abandoned; this is long enough for a slow share's full
// run of maxPerRun photos.
const FOLDER_TIMEOUT_MS = 10 * 60_000

type Row = typeof T.$inferSelect
type SourceName = 'album' | 'folder'

interface Hooks {
  fetch: typeof fetch
  now: () => number
  maxPerRun: number
  folderTimeoutMs: number
  /** Where refreshSoon() and partial results go; the registered source unless a test swaps it. */
  source: { refreshSoon(): void; data: Photos | null } | null
}

// Process-global, on globalThis: Nitro can load this module twice (the
// startup plugin's bundle and the routes'), and both must share iCloud's
// partition host and the failure memory. Tests swap the hooks.
interface State {
  hooks: Hooks
  /** iCloud redirects to the album's partition once; remember it. */
  albumHost: string | null
  /** `${source}\0${key}\0${checksum}` → epoch ms of the failure */
  failed: Map<string, number>
  /** A folder sync that timed out but whose fs calls are still pending. */
  folderBusy: Promise<unknown> | null
}
const g = globalThis as unknown as { __framesPhotos?: State }
function initialState(): State {
  return {
    hooks: { fetch: (...a) => globalThis.fetch(...a), now: () => Date.now(), maxPerRun: 50, folderTimeoutMs: FOLDER_TIMEOUT_MS, source: null },
    albumHost: null,
    failed: new Map(),
    folderBusy: null,
  }
}
export const state: State = (g.__framesPhotos ??= initialState())
/** Tests: forget the partition host, failures, and swapped hooks. */
export function resetForTests(): void {
  Object.assign(state, initialState())
}

const now = () => state.hooks.now()

/** A request's own timeout, cut short by shutdown. */
const fetchSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])

/** `p`, or a rejection as soon as `signal` aborts. Doesn't cancel `p`. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
const failKey = (s: SourceName, k: string, cs: string) => `${s}\0${k}\0${cs}`

export function photosDir(): string {
  return path.join(settings.cacheDir, 'photos')
}

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex')
export function photoId(source: SourceName, key: string): string {
  return sha1(`${source}:${key}`)
}
/** Content-addressed: a changed photo gets a new name, so caching forever is safe. */
export function fileBase(source: SourceName, key: string, checksum: string): string {
  return `${photoId(source, key).slice(0, 16)}-${sha1(checksum).slice(0, 8)}`
}

function processPhoto(data: Buffer, base: string): Promise<Processed> {
  return processImage(data, base, photosDir(), settings.tz)
}

// --- index ------------------------------------------------------------------

function rows(source: SourceName): Map<string, Row> {
  const out = new Map<string, Row>()
  for (const r of db().select().from(T).where(eq(T.source, source)).all()) out.set(r.sourceKey, r)
  return out
}

/** New, changed, or its files vanished from the (regenerable) cache, and
 * not a recent failure. */
function needsWork(source: SourceName, key: string, row: Row | undefined, checksum: string): boolean {
  const failed = state.failed.get(failKey(source, key, checksum))
  if (failed != null && now() - failed < RETRY_FAILED_MS) return false
  if (!row || row.checksum !== checksum) return true
  const files = row.backdrop ? [row.file, row.backdrop] : [row.file]
  return !files.every((f) => fs.existsSync(path.join(photosDir(), f)))
}

function store(
  source: SourceName, key: string, checksum: string, result: Processed,
  meta: { taken: number | null; contributor: string | null; added: number },
): void {
  const id = photoId(source, key)
  const old = tx((d) => {
    const prev = d.select({ file: T.file, backdrop: T.backdrop }).from(T).where(eq(T.id, id)).get()
    const values = {
      checksum, width: result.width, height: result.height, takenAt: meta.taken,
      contributor: meta.contributor, file: result.file, backdrop: result.backdrop, missingSince: null,
    }
    d.insert(T)
      .values({ id, source, sourceKey: key, addedAt: meta.added, ...values })
      .onConflictDoUpdate({ target: T.id, set: values })
      .run()
    return prev
  })
  if (old) {
    const keep = new Set([result.file, result.backdrop])
    for (const f of [old.file, old.backdrop]) {
      if (f && !keep.has(f)) fs.rmSync(path.join(photosDir(), f), { force: true })
    }
  }
}

/** Flag rows gone from the source; un-flag ones that came back. */
function markSeen(source: SourceName, present: Set<string>): void {
  const t = now()
  tx((d) => {
    const all = d.select({ id: T.id, key: T.sourceKey, missing: T.missingSince }).from(T).where(eq(T.source, source)).all()
    for (const r of all) {
      if (present.has(r.key)) {
        if (r.missing != null) d.update(T).set({ missingSince: null }).where(eq(T.id, r.id)).run()
      } else if (r.missing == null) {
        d.update(T).set({ missingSince: t }).where(eq(T.id, r.id)).run()
      }
    }
  })
}

/** An empty listing for a source with photos still indexed is far more
 * likely a broken source (an empty mountpoint, a glitched album) than every
 * photo deleted at once, so it's an error rather than a blank frame. */
function checkListing(source: SourceName, present: Set<string>): void {
  if (present.size) return
  const n = db().select({ n: sql<number>`count(*)` }).from(T)
    .where(and(eq(T.source, source), isNull(T.missingSince))).get()?.n ?? 0
  if (n) {
    throw new Error(
      `${source} listing is empty but ${n} photo(s) are indexed; keeping them ` +
      '(if the source really is empty now, delete its rows from the photos table)',
    )
  }
}

/** Drop rows (and files) missing past the grace period, and any cached file
 * no row points at (e.g. a .tmp left by a crash mid-write). */
export function prune(): void {
  const cutoff = now() - MISSING_GRACE
  const known = tx((d) => {
    d.delete(T).where(and(isNotNull(T.missingSince), lt(T.missingSince, cutoff))).run()
    const s = new Set<string>()
    for (const r of d.select({ file: T.file, backdrop: T.backdrop }).from(T).all()) {
      s.add(r.file)
      if (r.backdrop) s.add(r.backdrop)
    }
    return s
  })
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(photosDir(), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isFile() && !known.has(e.name)) fs.rmSync(path.join(photosDir(), e.name), { force: true })
  }
}

/** The /api/photos payload, newest-added first (the client weights the head
 * of the list a little more). */
export function build(): Photos {
  const list = db().select().from(T).where(isNull(T.missingSince)).orderBy(desc(T.addedAt), asc(T.id)).all()
  // The cache dir is regenerable; a row whose file was wiped is left out
  // until the next refresh reprocesses it, rather than served as a 404.
  let onDisk: Set<string>
  try {
    onDisk = new Set(fs.readdirSync(photosDir()))
  } catch {
    onDisk = new Set()
  }
  const out: Photo[] = []
  for (const r of list) {
    if (!onDisk.has(r.file) || (r.backdrop && !onDisk.has(r.backdrop))) continue
    out.push({
      id: r.id.slice(0, 16),
      url: '/photos/' + r.file,
      backdrop: r.backdrop ? '/photos/' + r.backdrop : null,
      w: r.width,
      h: r.height,
      o: r.height > r.width ? 'p' : 'l',
      taken: r.takenAt,
      contributor: r.contributor,
    })
  }
  return { photos: out }
}

// --- iCloud Shared Album ----------------------------------------------------

interface Derivative { checksum?: string; width?: string | number; height?: string | number }
interface AlbumPhoto {
  photoGuid?: string
  mediaAssetType?: string
  derivatives?: Record<string, Derivative>
  dateCreated?: string
  batchDateCreated?: string
  contributorFullName?: string
}

/** POST to the album's partition, following iCloud's 330 host redirect
 * (fetch only follows 301/302/303/307/308). */
async function albumPost(token: string, endpoint: string, body: unknown, signal: AbortSignal): Promise<any> {
  let host = state.albumHost || ALBUM_START_HOST
  for (let i = 0; i < 3; i++) {
    const r = await state.hooks.fetch(`https://${host}/${token}/sharedstreams/${endpoint}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'text/plain' },
      signal: fetchSignal(signal),
    })
    if (r.status === 330) {
      const next = (await r.json())?.['X-Apple-MMe-Host']
      if (typeof next !== 'string' || !/^[a-z0-9.-]+$/i.test(next)) throw new Error('shared album: bad host redirect')
      host = next
      continue
    }
    // Never the URL in the message: it carries the token, and errors are
    // served in /api/photos.
    if (!r.ok) throw new Error(`shared album ${endpoint}: HTTP ${r.status}`)
    state.albumHost = host
    return r.json()
  }
  throw new Error('shared album: too many host redirects')
}

/** The largest size. Numbers arrive as strings, and some keys (a video's
 * poster frame) aren't sizes at all. */
export function bestDerivative(derivs: Record<string, Derivative> | undefined | null): Derivative | null {
  let best: Derivative | null = null, area = -1
  for (const d of Object.values(derivs || {})) {
    if (!d || d.width === '' || d.height === '') continue
    const a = Number(d.width) * Number(d.height)
    if (!Number.isFinite(a)) continue
    if (a > area && d.checksum) { best = d; area = a }
  }
  return best
}

function isoMs(s: string | undefined | null): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Index the album, processing at most `budget` photos; returns [stored, still waiting]. */
async function syncAlbum(token: string, budget: number, signal: AbortSignal): Promise<[number, number]> {
  const stream = await albumPost(token, 'webstream', { streamCtag: null }, signal)
  const items = new Map<string, { p: AlbumPhoto; checksum: string }>()
  for (const p of (stream?.photos || []) as AlbumPhoto[]) {
    if (p.mediaAssetType === 'video' || !p.photoGuid) continue
    const d = bestDerivative(p.derivatives)
    if (d?.checksum) items.set(p.photoGuid, { p, checksum: d.checksum })
  }
  const present = new Set(items.keys())
  checkListing('album', present)
  const known = rows('album')
  markSeen('album', present)
  const todo = [...items.keys()].filter((guid) => needsWork('album', guid, known.get(guid), items.get(guid)!.checksum))
  // Newest additions first, so a fresh upload shows up on the next refresh.
  const added = (guid: string) => items.get(guid)!.p.batchDateCreated || ''
  todo.sort((a, b) => (added(a) < added(b) ? 1 : added(a) > added(b) ? -1 : 0))
  const doing = todo.slice(0, budget)
  let stored = 0

  for (let i = 0; i < doing.length; i += ASSET_BATCH) {
    const batch = doing.slice(i, i + ASSET_BATCH)
    // Asset URLs expire, so ask for them right before downloading.
    signal.throwIfAborted()
    const res = await albumPost(token, 'webasseturls', { photoGuids: batch }, signal)
    const urls = (res?.items || {}) as Record<string, { url_location?: string; url_path?: string }>
    for (const guid of batch) {
      signal.throwIfAborted()
      const { p, checksum } = items.get(guid)!
      const u = urls[checksum]
      let result: Processed
      try {
        if (!u?.url_location || !u.url_path) throw new Error('no asset url')
        const r = await state.hooks.fetch(`https://${u.url_location}${u.url_path}`, { signal: fetchSignal(signal) })
        if (!r.ok) throw new Error(`download: HTTP ${r.status}`)
        result = await processPhoto(Buffer.from(await r.arrayBuffer()), fileBase('album', guid, checksum))
      } catch (e) {
        // Shutdown isn't this photo's fault; don't park it as failed.
        signal.throwIfAborted()
        // One bad photo shouldn't stop the rest. Never the asset URL: it's signed.
        console.warn(`[photos] album photo ${guid} failed: ${(e as Error)?.message || e}`)
        state.failed.set(failKey('album', guid, checksum), now())
        continue
      }
      store('album', guid, checksum, result, {
        taken: isoMs(p.dateCreated) ?? result.taken,
        contributor: (p.contributorFullName || '').trim() || null,
        added: isoMs(p.batchDateCreated) ?? now(),
      })
      stored++
    }
  }
  return [stored, todo.length - doing.length]
}

// --- folder -----------------------------------------------------------------

interface Found { file: string; checksum: string; mtimeMs: number }

/** {relative path: file} and how many HEIC files were skipped. Async fs
 * throughout: on a hung NAS mount a sync call would freeze the whole server,
 * /healthz included, where an async one ties up only a threadpool thread. */
export async function scanFolder(root: string, signal?: AbortSignal): Promise<{ found: Map<string, Found>; heic: number }> {
  let st: fs.Stats | undefined
  try { st = await fs.promises.stat(root) } catch { /* reported below */ }
  // An unmounted NAS share must not look like "every photo deleted".
  if (!st?.isDirectory()) throw new Error(`photos folder ${root} is missing`)
  const found = new Map<string, Found>()
  let heic = 0
  const walk = async (dir: string, rel: string) => {
    for await (const e of await fs.promises.opendir(dir)) {
      signal?.throwIfAborted()
      // Dotfiles include macOS's ._ AppleDouble files on SMB shares.
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      const key = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { await walk(abs, key); continue }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (FOLDER_UNREADABLE.has(ext)) heic++
      else if (FOLDER_TYPES.has(ext)) {
        const s = await fs.promises.stat(abs, { bigint: true })
        found.set(key, { file: abs, checksum: `${s.mtimeNs}:${s.size}`, mtimeMs: Number(s.mtimeMs) })
      }
    }
  }
  await walk(root, '')
  return { found, heic }
}

/** syncFolderNow under the folder timeout. A sync that timed out may still
 * have fs calls stuck on the mount; until they return, later runs fail fast
 * instead of piling more onto libuv's four threads (which fetch's DNS
 * lookups share). */
function syncFolder(root: string, budget: number, signal: AbortSignal): Promise<[number, number]> {
  if (state.folderBusy) return Promise.reject(new Error(`photos folder ${root}: a timed-out scan is still waiting on the share`))
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(state.hooks.folderTimeoutMs)])
  const run = syncFolderNow(root, budget, deadline)
  return abortable(run, deadline).catch((e) => {
    if (!signal.aborted && deadline.aborted) {
      const busy = run.catch(() => {}).finally(() => { if (state.folderBusy === busy) state.folderBusy = null })
      state.folderBusy = busy
      throw new Error(`photos folder ${root}: no answer in ${Math.round(state.hooks.folderTimeoutMs / 1000)} s`)
    }
    throw e
  })
}

async function syncFolderNow(root: string, budget: number, signal: AbortSignal): Promise<[number, number]> {
  const { found, heic } = await scanFolder(root, signal)
  if (heic) console.warn(`[photos] folder: skipped ${heic} HEIC/HEIF file(s); export them as JPEG`)
  const present = new Set(found.keys())
  checkListing('folder', present)
  const known = rows('folder')
  markSeen('folder', present)
  const todo = [...found.keys()].filter((k) => needsWork('folder', k, known.get(k), found.get(k)!.checksum))
  todo.sort((a, b) => found.get(b)!.mtimeMs - found.get(a)!.mtimeMs)
  let stored = 0
  for (const key of todo.slice(0, budget)) {
    signal.throwIfAborted()
    const f = found.get(key)!
    let result: Processed
    try {
      result = await processPhoto(await fs.promises.readFile(f.file, { signal }), fileBase('folder', key, f.checksum))
    } catch (e) {
      signal.throwIfAborted()
      console.warn(`[photos] folder photo ${key} failed: ${(e as Error)?.message || e}`)
      state.failed.set(failKey('folder', key, f.checksum), now())
      continue
    }
    store('folder', key, f.checksum, result, { taken: result.taken, contributor: null, added: Math.floor(f.mtimeMs) })
    stored++
  }
  return [stored, Math.max(0, todo.length - budget)]
}

// --- source -----------------------------------------------------------------

function redact(s: string): string {
  const token = settings.sharedAlbumToken
  return token ? s.split(token).join('<token>') : s
}

function liveSource(): Hooks['source'] {
  return state.hooks.source ?? registry.get<Photos>('photos') ?? null
}

/** Its name is what Source puts in front of the message in /api/photos. */
class PhotosError extends Error {
  override name = 'PhotosError'
}

/** `signal` is the Source's: aborted at shutdown, it stops the work between
 * photos and cuts off any request in flight. */
export async function fetchPhotos(signal: AbortSignal = new AbortController().signal): Promise<Photos> {
  const errors: string[] = []
  let stored = 0, backlog = 0
  const syncs: [SourceName, (budget: number) => Promise<[number, number]>][] = []
  const token = settings.sharedAlbumToken
  if (token) syncs.push(['album', (b) => syncAlbum(token, b, signal)])
  else markSeen('album', new Set())
  if (settings.photosDir) syncs.push(['folder', (b) => syncFolder(path.resolve(settings.photosDir), b, signal)])
  else markSeen('folder', new Set())
  for (const [name, sync] of syncs) {
    try {
      const [done, left] = await sync(state.hooks.maxPerRun)
      stored += done
      backlog += left
    } catch (e: any) {
      // The other source still runs. Node's fetch errors can carry the URL
      // in a cause, so the whole message is redacted, not just ours.
      const cause = e?.cause?.message ? ` (${e.cause.message})` : ''
      errors.push(redact(`${name}: ${e?.name || 'Error'}: ${e?.message || e}${cause}`))
    }
  }
  signal.throwIfAborted()
  prune()
  const data = build()
  const src = liveSource()
  // Only while the backlog is actually shrinking: a run that stored nothing
  // (iCloud's CDN down, say) waits for the normal interval instead.
  if (backlog && stored && src) {
    console.info(`[photos] ${backlog} left to process; continuing shortly`)
    src.refreshSoon()
  }
  if (errors.length) {
    // Serve whatever did get processed, but still report the failure;
    // `updated` stays old, so it reads as stale.
    if (src) src.data = data
    throw new PhotosError(errors.join('; '))
  }
  return data
}

export function setup(): void {
  const source = registry.add(new Source<Photos>('photos', fetchPhotos, INTERVAL_MS))
  // Serve what's already indexed straight after a restart, even if iCloud is
  // down; it reads as stale until a refresh succeeds.
  try {
    source.data = build()
  } catch (e) {
    console.warn('[photos] couldn\'t read the index at startup:', e)
  }
}

// Looked up in the registry, not a module variable: Nitro bundles the startup
// plugin apart from the routes, so this module can exist twice in one process.
export function endpoint(): Envelope<Photos> {
  return registry.get<Photos>('photos')!.envelope()
}
