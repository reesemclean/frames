// Photos: the album protocol, the image pipeline, and the index lifecycle.
//
// No network: iCloud is a fake fetch serving JPEGs generated with sharp.
// settings is one shared object, so paths and the token are swapped per test
// and restored afterwards.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '~/server/config'
import { closeForTests, db } from '~/server/db'
import * as photos from '~/server/sources/photos'
import { processImage } from '~/server/photos/process'
import { exifTaken, zonedEpoch } from '~/server/photos/exif'

const TOKEN = 'TESTTOKEN'

interface JpegOpts { gps?: boolean; taken?: string; offset?: string; orientation?: number }

async function jpeg(w: number, h: number, o: JpegOpts = {}): Promise<Buffer> {
  let s = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 40 } } })
  if (o.orientation) s = s.withMetadata({ orientation: o.orientation })
  const exif: Record<string, Record<string, string>> = {}
  if (o.gps) exif.IFD3 = { GPSLatitudeRef: 'N', GPSLatitude: '33/1 27/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '112/1 4/1 0/1' }
  if (o.taken) exif.IFD2 = { DateTimeOriginal: o.taken, ...(o.offset ? { OffsetTimeOriginal: o.offset } : {}) }
  if (Object.keys(exif).length) s = s.withExifMerge(exif)
  return s.jpeg().toBuffer()
}

/** JPEG marker segments up to the image data: [marker, payload]. */
function segments(buf: Buffer): [number, Buffer][] {
  expect(buf.readUInt16BE(0)).toBe(0xffd8)
  const out: [number, Buffer][] = []
  let i = 2
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i)
    if (marker === 0xffda) break // start of scan
    const len = buf.readUInt16BE(i + 2)
    out.push([marker, buf.subarray(i + 4, i + 2 + len)])
    i += 2 + len
  }
  return out
}

/** No APP1 (EXIF, XMP), APP2 (ICC), APP13 (IPTC), or COM; nothing secret. */
function expectNoMetadata(buf: Buffer) {
  const markers = segments(buf).map(([m]) => m)
  for (const bad of [0xffe1, 0xffe2, 0xffed, 0xfffe]) expect(markers).not.toContain(bad)
  expect(buf.includes('secret')).toBe(false)
  expect(buf.includes('Exif')).toBe(false)
}

let tmp: string
const saved = { ...settings }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-photos-test-'))
  settings.dataDir = path.join(tmp, 'data')
  settings.cacheDir = path.join(tmp, 'cache')
  settings.sharedAlbumToken = ''
  settings.photosDir = ''
  settings.tz = 'America/Phoenix'
  closeForTests()
  photos.resetForTests()
})

afterEach(() => {
  closeForTests()
  photos.resetForTests()
  Object.assign(settings, saved)
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

interface Item { guid: string; checksum: string; w: number; h: number; data: Buffer; video?: boolean; batch?: string }

/** iCloud's shared-stream endpoints, including the 330 partition hop. */
class FakeAlbum {
  items: Item[] = []
  calls: [string, string][] = []
  asked: string[][] = [] // guids per webasseturls request

  stream() {
    return {
      streamName: 'Test',
      photos: this.items.map((it) => {
        const p: any = {
          photoGuid: it.guid,
          derivatives: {
            '342': { checksum: 'small-' + it.checksum, width: '12', height: '16', fileSize: '1' },
            '2049': { checksum: it.checksum, width: String(it.w), height: String(it.h), fileSize: '2' },
          },
          dateCreated: '2026-10-10T00:48:52Z',
          batchDateCreated: it.batch ?? '2026-10-14T04:46:43Z',
          contributorFullName: 'Pat Example',
        }
        if (it.video) {
          p.mediaAssetType = 'video'
          p.derivatives.PosterFrame = { checksum: 'poster', width: 'x', height: 'y' }
        }
        return p
      }),
    }
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const host = url.host, p = url.pathname
    this.calls.push([host, p])
    if (p.endsWith('/sharedstreams/webstream') || p.endsWith('/sharedstreams/webasseturls')) {
      expect(p.startsWith(`/${TOKEN}/`)).toBe(true)
      if (host !== 'p101-sharedstreams.icloud.com') {
        return Response.json({ 'X-Apple-MMe-Host': 'p101-sharedstreams.icloud.com' }, { status: 330 })
      }
      if (p.endsWith('webstream')) return Response.json(this.stream())
      const guids: string[] = JSON.parse(String(init?.body)).photoGuids
      this.asked.push(guids)
      expect(guids.length).toBeLessThanOrEqual(photos.ASSET_BATCH)
      const items: Record<string, unknown> = {}
      for (const g of guids) {
        const it = this.items.find((x) => x.guid === g)!
        items[it.checksum] = { url_location: 'cvws.icloud-content.com', url_path: `/dl/${g}` }
      }
      return Response.json({ items })
    }
    if (host === 'cvws.icloud-content.com') {
      const guid = p.split('/').pop()
      return new Response(new Uint8Array(this.items.find((it) => it.guid === guid)!.data))
    }
    return new Response('', { status: 404 })
  }
}

function useAlbum(): FakeAlbum {
  const fake = new FakeAlbum()
  photos.state.hooks.fetch = fake.fetch as typeof fetch
  settings.sharedAlbumToken = TOKEN
  return fake
}

const dir = () => photos.photosDir()
const fileOf = (url: string) => path.join(dir(), url.replace(/^\/photos\//, ''))
const listDir = () => fs.readdirSync(dir()).sort()
const count = (where = '') => (db().$client.prepare('SELECT count(*) AS n FROM photos ' + where).get() as { n: number }).n

describe('shared album', () => {
  it('end to end: redirect, largest derivative, videos skipped, metadata stripped', async () => {
    const album = useAlbum()
    album.items = [
      { guid: 'P1', checksum: 'c1', w: 1537, h: 2049, data: await jpeg(1536, 2048, { gps: true }) },
      { guid: 'L1', checksum: 'c2', w: 2048, h: 1536, data: await jpeg(2048, 1536, { gps: true }) },
      { guid: 'V1', checksum: 'c3', w: 1920, h: 1080, data: Buffer.alloc(0), video: true },
    ]
    const data = await photos.fetchPhotos()
    expect(data.photos).toHaveLength(2) // the video is skipped
    const p = data.photos.find((x) => x.o === 'p')!
    const l = data.photos.find((x) => x.o === 'l')!

    expect([p.w, p.h]).toEqual([600, 800])
    expect(p.backdrop).toBeTruthy()
    expect(p.url.startsWith('/photos/')).toBe(true)
    expect(p.taken).toBe(1791593332000)
    expect(p.contributor).toBe('Pat Example')
    const bg = await sharp(fileOf(p.backdrop!)).metadata()
    expect([bg.width, bg.height, bg.format]).toEqual([1280, 800, 'jpeg'])

    expect([l.w, l.h]).toEqual([1067, 800])
    expect(l.backdrop).toBeNull()

    for (const f of [p.url, p.backdrop!, l.url]) {
      const raw = fs.readFileSync(fileOf(f))
      expectNoMetadata(raw)
      const m = await sharp(raw).metadata()
      expect(m.format).toBe('jpeg')
      expect(m.exif).toBeUndefined()
      expect(m.isProgressive).toBe(true)
    }
    // The redirect host is remembered; the small derivative is never asked for.
    expect(album.calls).toContainEqual(['p23-sharedstreams.icloud.com', `/${TOKEN}/sharedstreams/webstream`])
    expect(photos.state.albumHost).toBe('p101-sharedstreams.icloud.com')
  })

  it('does not reprocess unchanged photos', async () => {
    const album = useAlbum()
    album.items = [{ guid: 'P1', checksum: 'c1', w: 600, h: 800, data: await jpeg(600, 800) }]
    await photos.fetchPhotos()
    album.calls = []
    await photos.fetchPhotos()
    expect(album.calls.some(([, p]) => p.endsWith('webasseturls'))).toBe(false)
  })

  it('replaces files when the checksum changes (an edited photo)', async () => {
    const album = useAlbum()
    album.items = [{ guid: 'P1', checksum: 'c1', w: 600, h: 800, data: await jpeg(600, 800) }]
    const first = (await photos.fetchPhotos()).photos[0]
    Object.assign(album.items[0], { checksum: 'c9', w: 800, h: 600, data: await jpeg(800, 600) })
    const second = (await photos.fetchPhotos()).photos[0]
    expect(second.id).toBe(first.id)
    expect(second.url).not.toBe(first.url)
    expect(second.o).toBe('l')
    expect(second.backdrop).toBeNull()
    // Old files go; only the new one stays.
    expect(listDir()).toEqual([path.basename(second.url)])
  })

  it('regenerates a deleted cache file', async () => {
    const album = useAlbum()
    album.items = [{ guid: 'P1', checksum: 'c1', w: 600, h: 800, data: await jpeg(600, 800) }]
    const p = (await photos.fetchPhotos()).photos[0]
    fs.unlinkSync(fileOf(p.backdrop!))
    await photos.fetchPhotos()
    expect(fs.existsSync(fileOf(p.backdrop!))).toBe(true)
  })

  it('caps work per run and works through the backlog, newest-added first', async () => {
    const album = useAlbum()
    photos.state.hooks.maxPerRun = 3
    album.items = await Promise.all([0, 1, 2, 3, 4].map(async (i) => ({
      guid: `G${i}`, checksum: `c${i}`, w: 80, h: 60, data: await jpeg(80, 60),
      batch: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
    })))
    expect((await photos.fetchPhotos()).photos).toHaveLength(3)
    const data = await photos.fetchPhotos()
    expect(data.photos).toHaveLength(5)
    expect(data.photos[0].id).toBe(photos.photoId('album', 'G4').slice(0, 16))
  })

  it('kicks a refresh only while the backlog is shrinking; failed photos wait', async () => {
    const album = useAlbum()
    photos.state.hooks.maxPerRun = 1
    const fake = { kicks: 0, data: null, refreshSoon() { this.kicks++ } }
    photos.state.hooks.source = fake
    album.items = await Promise.all([0, 1, 2].map(async (i) => ({ guid: `G${i}`, checksum: `c${i}`, w: 80, h: 60, data: await jpeg(80, 60) })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await photos.fetchPhotos()
    expect(fake.kicks).toBe(1)

    // Every download failing: no kick, and a failed photo isn't retried on
    // the next run (it would otherwise hold the whole budget).
    for (const it of album.items) it.data = Buffer.from('not an image')
    fake.kicks = 0
    await photos.fetchPhotos()
    expect(fake.kicks).toBe(0)
    await photos.fetchPhotos()
    expect(album.asked.at(-1)).not.toEqual(album.asked.at(-2))
  })

  it('hides missing photos, then prunes them after the grace period', async () => {
    const album = useAlbum()
    album.items = [
      { guid: 'A', checksum: 'ca', w: 80, h: 60, data: await jpeg(80, 60) },
      { guid: 'B', checksum: 'cb', w: 60, h: 80, data: await jpeg(60, 80) },
    ]
    await photos.fetchPhotos()
    album.items = album.items.slice(0, 1)
    expect((await photos.fetchPhotos()).photos).toHaveLength(1)
    expect(listDir()).toHaveLength(3) // B's files kept during the grace period

    const real = Date.now()
    photos.state.hooks.now = () => real + photos.MISSING_GRACE + 60_000
    await photos.fetchPhotos()
    expect(count()).toBe(1)
    expect(listDir()).toHaveLength(1)
  })

  it('shows a photo that returns without reprocessing it', async () => {
    const album = useAlbum()
    const keep = { guid: 'K', checksum: 'ck', w: 80, h: 60, data: await jpeg(80, 60) }
    const item = { guid: 'A', checksum: 'ca', w: 80, h: 60, data: await jpeg(80, 60) }
    album.items = [keep, item]
    await photos.fetchPhotos()
    album.items = [keep]
    expect((await photos.fetchPhotos()).photos).toHaveLength(1)
    album.items = [keep, item]
    album.calls = []
    expect((await photos.fetchPhotos()).photos).toHaveLength(2)
    expect(album.calls.some(([, p]) => p.endsWith('webasseturls'))).toBe(false)
  })

  it('treats an empty listing with indexed photos as an error, keeping them', async () => {
    const album = useAlbum()
    album.items = [{ guid: 'A', checksum: 'ca', w: 80, h: 60, data: await jpeg(80, 60) }]
    await photos.fetchPhotos()
    album.items = []
    await expect(photos.fetchPhotos()).rejects.toThrow(/album listing is empty/)
    expect(photos.build().photos).toHaveLength(1)
  })

  it('keeps the index on failure, and never puts the token in the error', async () => {
    const album = useAlbum()
    album.items = [{ guid: 'A', checksum: 'ca', w: 80, h: 60, data: await jpeg(80, 60) }]
    await photos.fetchPhotos()
    const fake = { data: null as any, refreshSoon() {} }
    photos.state.hooks.source = fake
    photos.state.hooks.fetch = async () => new Response('', { status: 503 })
    const err = await photos.fetchPhotos().then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/album/)
    expect(String(err?.message)).not.toContain(TOKEN)
    expect(count('WHERE missing_since IS NULL')).toBe(1)
    // What did get indexed is still served.
    expect(fake.data.photos).toHaveLength(1)
  })

  it('redacts the token from a network error that carries the URL', async () => {
    useAlbum()
    photos.state.hooks.fetch = async (u) => {
      throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${String(u)}`) })
    }
    const err = await photos.fetchPhotos().then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/ECONNREFUSED/)
    expect(err?.message).not.toContain(TOKEN)
    expect(err?.message).toContain('<token>')
  })

  it('stops between photos at shutdown, and aborts the request in flight', async () => {
    const album = useAlbum()
    album.items = await Promise.all(['A', 'B', 'C'].map(async (g) => ({ guid: g, checksum: 'c' + g, w: 80, h: 60, data: await jpeg(80, 60) })))
    const stop = new AbortController()
    const signals: AbortSignal[] = []
    photos.state.hooks.fetch = (async (u: string, init?: RequestInit) => {
      signals.push(init!.signal!)
      const r = await album.fetch(u, init)
      // Shutdown arrives during the first download.
      if (String(u).includes('/dl/')) stop.abort()
      return r
    }) as typeof fetch
    await expect(photos.fetchPhotos(stop.signal)).rejects.toThrow(/abort/i)
    // Every request carried a signal that shutdown aborts.
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => s.aborted)).toBe(true)
    // The first photo finished; the rest weren't started, nor parked as failed.
    expect(count()).toBeLessThanOrEqual(1)
    expect(album.calls.filter(([h]) => h === 'cvws.icloud-content.com')).toHaveLength(1)
    expect(photos.state.failed.size).toBe(0)
  })
})

describe('folder', () => {
  it('reads jpg/jpeg/png/webp, applies orientation, reads EXIF dates in the household zone, skips HEIC and dotfiles', async () => {
    const root = path.join(tmp, 'nas')
    fs.mkdirSync(path.join(root, '2025'), { recursive: true })
    fs.writeFileSync(path.join(root, '2025', 'a.jpg'), await jpeg(4000, 3000, { gps: true, taken: '2026:10:09 22:30:00' }))
    // Orientation 6 = rotate 90: a sideways-stored portrait.
    fs.writeFileSync(path.join(root, 'b.JPEG'), await jpeg(1600, 1200, { orientation: 6 }))
    fs.writeFileSync(path.join(root, 'c.heic'), 'not readable')
    fs.writeFileSync(path.join(root, '._a.jpg'), 'AppleDouble junk')
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
    // Transparency is flattened, not left black-or-garbage.
    fs.writeFileSync(path.join(root, 'd.png'), await sharp({ create: { width: 90, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer())
    fs.writeFileSync(path.join(root, 'e.webp'), await sharp({ create: { width: 90, height: 60, channels: 3, background: '#336699' } }).webp().toBuffer())
    settings.photosDir = root
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const data = await photos.fetchPhotos()
    expect(data.photos).toHaveLength(4)
    const l = data.photos.find((p) => p.w === 1067)!
    const p = data.photos.find((p) => p.o === 'p')!
    expect([l.w, l.h]).toEqual([1067, 800])
    expect([p.w, p.h]).toEqual([600, 800])
    expect(p.backdrop).toBeTruthy()
    // 22:30 in the household's zone, which is already the next day in UTC.
    expect(l.taken).toBe(Date.UTC(2026, 9, 10, 5, 30))
    expectNoMetadata(fs.readFileSync(fileOf(l.url)))
    expect(warn.mock.calls.some((c) => /HEIC/.test(String(c[0])))).toBe(true)
  })

  it('picks up a changed file; a vanished share is an error', async () => {
    const root = path.join(tmp, 'nas')
    fs.mkdirSync(root)
    const f = path.join(root, 'a.jpg')
    fs.writeFileSync(f, await jpeg(80, 60))
    settings.photosDir = root
    const first = (await photos.fetchPhotos()).photos[0]
    fs.writeFileSync(f, await jpeg(60, 80))
    // Same-second rewrites still differ in mtime_ns or size; make sure.
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000))
    const second = (await photos.fetchPhotos()).photos[0]
    expect(second.o).toBe('p')
    expect(second.url).not.toBe(first.url)

    // The share vanishing is an error, not "every photo was deleted".
    fs.rmSync(root, { recursive: true })
    await expect(photos.fetchPhotos()).rejects.toThrow(/folder/)
    expect(photos.build().photos).toHaveLength(1)
  })

  it('treats an empty folder with indexed photos as an error', async () => {
    // An unmounted share can leave an empty mountpoint rather than none.
    const root = path.join(tmp, 'nas')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'a.jpg'), await jpeg(80, 60))
    settings.photosDir = root
    await photos.fetchPhotos()
    fs.unlinkSync(path.join(root, 'a.jpg'))
    await expect(photos.fetchPhotos()).rejects.toThrow(/folder listing is empty/)
    expect(photos.build().photos).toHaveLength(1)
  })

  it('a hung share times out, and nothing piles onto it until it answers', async () => {
    const root = path.join(tmp, 'nas')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'a.jpg'), await jpeg(80, 60))
    settings.photosDir = root
    photos.state.hooks.folderTimeoutMs = 50
    let answer!: () => void
    const realOpendir = fs.promises.opendir
    const opendir = vi.spyOn(fs.promises, 'opendir').mockImplementation(
      (...a) => new Promise<void>((r) => { answer = r }).then(() => realOpendir(...a)),
    )
    // The event loop stays free while the share hangs.
    let ticked = false
    setTimeout(() => { ticked = true }, 10)
    await expect(photos.fetchPhotos()).rejects.toThrow(/no answer in/)
    expect(ticked).toBe(true)
    await expect(photos.fetchPhotos()).rejects.toThrow(/still waiting on the share/)
    expect(opendir).toHaveBeenCalledTimes(1)

    // Once the stuck call returns, the next run scans normally.
    opendir.mockRestore()
    answer()
    await vi.waitFor(() => expect(photos.state.folderBusy).toBeNull())
    photos.state.hooks.folderTimeoutMs = 60_000
    expect((await photos.fetchPhotos()).photos).toHaveLength(1)
  })
})

describe('pipeline', () => {
  it('strips comments, XMP, EXIF and GPS from the photo and its backdrop', async () => {
    for (const [w, h] of [[80, 60], [60, 80]]) { // landscape, and portrait for the backdrop
      let src = await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } })
        .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">secret-xmp</x:xmpmeta>')
        .withExifMerge({ IFD0: { Copyright: 'secret-exif' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '33/1 27/1 0/1' } })
        .jpeg().toBuffer()
      // A COM segment straight after SOI (sharp can't write one).
      const text = Buffer.from('secret-comment')
      const com = Buffer.alloc(4)
      com.writeUInt16BE(0xfffe, 0)
      com.writeUInt16BE(text.length + 2, 2)
      src = Buffer.concat([src.subarray(0, 2), com, text, src.subarray(2)])
      const markers = segments(src).map(([m]) => m)
      expect(markers).toContain(0xfffe)
      expect(markers).toContain(0xffe1)
      expect(src.includes('secret-xmp') && src.includes('secret-exif')).toBe(true)

      const r = await processImage(src, `t${w}`, dir(), 'America/Phoenix')
      for (const name of [r.file, r.backdrop].filter(Boolean) as string[]) {
        expectNoMetadata(fs.readFileSync(path.join(dir(), name)))
      }
    }
  })

  it('never upscales and names files from the base', async () => {
    const r = await processImage(await jpeg(80, 60), 'abc-123', dir(), 'America/Phoenix')
    expect(r).toMatchObject({ file: 'abc-123.jpg', backdrop: null, width: 80, height: 60 })
    expect(listDir()).toEqual(['abc-123.jpg']) // no .tmp left behind
  })

  it('rejects something that is not an image', async () => {
    await expect(processImage(Buffer.from('nope'), 'x', dir(), 'America/Phoenix')).rejects.toThrow()
  })
})

describe('index', () => {
  it('build() skips rows whose files are gone; the next refresh reprocesses them', async () => {
    const album = useAlbum()
    album.items = [
      { guid: 'A', checksum: 'ca', w: 80, h: 60, data: await jpeg(80, 60) },
      { guid: 'B', checksum: 'cb', w: 60, h: 80, data: await jpeg(60, 80) },
    ]
    const data = await photos.fetchPhotos()
    const portrait = data.photos.find((p) => p.o === 'p')!
    fs.unlinkSync(fileOf(portrait.backdrop!))
    expect(photos.build().photos.map((p) => p.o)).toEqual(['l'])
    for (const f of listDir()) fs.unlinkSync(path.join(dir(), f))
    expect(photos.build()).toEqual({ photos: [] })
    expect((await photos.fetchPhotos()).photos).toHaveLength(2)
  })

  it('removes orphaned files (a crash mid-write)', async () => {
    const album = useAlbum()
    album.items = [{ guid: 'A', checksum: 'ca', w: 80, h: 60, data: await jpeg(80, 60) }]
    await photos.fetchPhotos()
    fs.writeFileSync(path.join(dir(), 'deadbeef-00000000.jpg.tmp'), 'x')
    fs.writeFileSync(path.join(dir(), 'deadbeef-00000000.jpg'), 'x')
    await photos.fetchPhotos()
    expect(listDir()).toHaveLength(1)
  })

  it('is empty when nothing is configured', async () => {
    expect(await photos.fetchPhotos()).toEqual({ photos: [] })
  })

  it('bestDerivative ignores non-sizes', () => {
    const d = photos.bestDerivative({
      PosterFrame: { checksum: 'x', width: '?', height: '?' },
      '342': { checksum: 's', width: '257', height: '342' },
      '2049': { checksum: 'b', width: '1537', height: '2049' },
    })
    expect(d?.checksum).toBe('b')
  })
})

describe('EXIF dates', () => {
  const exifOf = async (o: JpegOpts) => (await sharp(await jpeg(16, 16, o)).metadata()).exif

  it('uses OffsetTimeOriginal when the camera wrote it', async () => {
    expect(exifTaken(await exifOf({ taken: '2026:07:04 12:00:00', offset: '-04:00' }), 'America/Phoenix')).toBe(Date.UTC(2026, 6, 4, 16))
  })

  it('reads a zone-less time in the household zone, DST included', async () => {
    const e = await exifOf({ taken: '2026:07:04 12:00:00' })
    expect(exifTaken(e, 'America/New_York')).toBe(Date.UTC(2026, 6, 4, 16)) // EDT
    expect(exifTaken(e, 'America/Phoenix')).toBe(Date.UTC(2026, 6, 4, 19)) // MST, no DST
    const w = await exifOf({ taken: '2026:01:04 12:00:00' })
    expect(exifTaken(w, 'America/New_York')).toBe(Date.UTC(2026, 0, 4, 17)) // EST
  })

  it('zonedEpoch is right on both sides of a DST change', () => {
    // US spring-forward 2026-03-08 02:00 EST → 03:00 EDT.
    expect(zonedEpoch(2026, 3, 8, 1, 30, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 6, 30))
    expect(zonedEpoch(2026, 3, 8, 3, 30, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30))
    expect(zonedEpoch(2026, 11, 1, 12, 0, 0, 'Europe/London')).toBe(Date.UTC(2026, 10, 1, 12))
  })

  it('is null for missing or garbage EXIF', async () => {
    expect(exifTaken(undefined, 'America/Phoenix')).toBeNull()
    expect(exifTaken(Buffer.from('Exif\0\0garbage'), 'America/Phoenix')).toBeNull()
    expect(exifTaken(await exifOf({ gps: true }), 'America/Phoenix')).toBeNull()
    expect(exifTaken(await exifOf({ taken: '0000:00:00 00:00:00' }), 'America/Phoenix')).toBeNull()
  })
})

describe('GET /photos/<name>', () => {
  async function get(splat: string): Promise<Response> {
    const { Route } = await import('~/routes/photos/$')
    const handler = (Route.options as any).server.handlers.GET
    return handler({ params: { _splat: splat }, request: new Request('http://x/photos/' + splat) })
  }

  it('serves a cached photo, immutable', async () => {
    await processImage(await jpeg(80, 60), 'abcdef0123456789-01234567', dir(), 'America/Phoenix')
    const r = await get('abcdef0123456789-01234567.jpg')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(100)
  })

  it.each([
    'missing-0000.jpg', '../data/frames.db', '..%2Fdata%2Ffoo.jpg', 'a/b.jpg', 'ABC.jpg',
    'x.jpg.tmp', 'x.png', '', '%E0%A4%A.jpg', '.jpg',
  ])('404s %s', async (name) => {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(path.join(dir(), 'x.jpg.tmp'), 'x')
    const r = await get(name)
    expect(r.status).toBe(404)
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
})

// --- the client slideshow's engine (no DOM: a fake image loader) -----------

describe('slideshow engine', async () => {
  const { Engine } = await import('~/widgets/slideshow-engine')
  type P = import('~/lib/types').Photo
  const ph = (id: string, o: 'l' | 'p' = 'l', url = `/photos/${id}.jpg`): P =>
    ({ id, url, backdrop: o === 'p' ? `/photos/${id}-bg.jpg` : null, w: o === 'p' ? 600 : 1067, h: 800, o, taken: null, contributor: null })
  const tick = () => new Promise((r) => setTimeout(r, 5))

  function make(layout: 'auto' | 'cover' | 'pair' | 'collage' | 'polaroid', bad: string[] = []) {
    const shown: import('~/widgets/slideshow-engine').Slide[] = []
    const loaded: string[] = []
    const e = new Engine({ layout, intervalSec: 3600 }, (s) => shown.push(s), async (src) => {
      loaded.push(src)
      if (bad.some((b) => src.includes(b))) throw new Error('404')
    })
    return { e, shown, loaded }
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('weights the newest fifth of the album twice', () => {
    const { e } = make('cover')
    e.setPhotos(Array.from({ length: 10 }, (_, i) => ph('p' + i)))
    e.pick()
    expect(e.queue.length).toBe(11) // 12 queued, one taken
    expect(e.queue.filter((p) => p.id === 'p0' || p.id === 'p1').length).toBeGreaterThanOrEqual(3)
  })

  it('pairs two portraits, and falls back to cover without a second', () => {
    const { e } = make('pair')
    e.setPhotos([ph('a', 'p'), ph('b', 'p'), ph('c')])
    const s = e.pick()!
    expect(s.layout).toBe('pair')
    expect(s.photos.map((p) => p.o)).toEqual(['p', 'p'])
    const { e: e2 } = make('pair')
    e2.setPhotos([ph('a', 'p'), ph('c')])
    expect(e2.pick()!.layout).toBe('cover')
  })

  it('collage needs three distinct photos', () => {
    const { e } = make('collage')
    e.setPhotos([ph('a'), ph('b'), ph('c')])
    const s = e.pick()!
    expect(s.layout).toBe('collage')
    expect(new Set(s.photos.map((p) => p.id)).size).toBe(3)
    const { e: e2 } = make('collage')
    e2.setPhotos([ph('a'), ph('b')])
    expect(e2.pick()!.layout).toBe('cover')
  })

  it('never shows the same photo twice in a row', () => {
    const { e } = make('cover')
    e.setPhotos([ph('a'), ph('b')])
    let last = ''
    for (let i = 0; i < 50; i++) {
      const id = e.pick()!.photos[0].id
      expect(id).not.toBe(last)
      last = id
    }
  })

  it('preloads before showing (backdrop too) and skips a photo that will not load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { e, shown, loaded } = make('cover', ['/photos/bad.jpg'])
    e.setPhotos([ph('bad'), ph('good', 'p')])
    e.start()
    await tick()
    expect(shown).toHaveLength(1)
    expect(shown[0].photos[0].id).toBe('good')
    expect(loaded).toContain('/photos/good-bg.jpg')
    e.destroy()
  })

  it('a backdrop that fails still shows the photo, without it', async () => {
    const { e, shown } = make('cover', ['-bg.jpg'])
    e.setPhotos([ph('a', 'p')])
    e.start()
    await tick()
    expect(shown[0].noBackdrop).toBe(true)
    e.destroy()
  })

  it('restarts when the list goes from empty to non-empty', async () => {
    const { e, shown } = make('cover')
    e.setPhotos([])
    e.start()
    await tick()
    expect(shown).toHaveLength(0)
    e.setPhotos([ph('a')])
    await tick()
    expect(shown).toHaveLength(1)
    e.destroy()
  })

  it('an edited photo (same id, new url) is shown with its new file', async () => {
    const { e, shown } = make('cover')
    e.setPhotos([ph('a')])
    e.start()
    await tick()
    e.setPhotos([ph('a', 'l', '/photos/a-v2.jpg')])
    expect(e.current?.photos[0].url).toBe('/photos/a-v2.jpg')
    await e.next()
    expect(shown.at(-1)!.photos[0].url).toBe('/photos/a-v2.jpg')
    e.destroy()
  })

  it('drops history slides whose photos vanished; prev() goes back', async () => {
    const { e, shown } = make('cover')
    e.setPhotos([ph('a'), ph('b'), ph('c')])
    e.start()
    await tick()
    await e.next()
    await e.next()
    expect(e.history).toHaveLength(2)
    const before = shown.at(-2)!.photos[0].id
    await e.prev()
    expect(shown.at(-1)!.photos[0].id).toBe(before)
    const gone = e.history.length ? e.history[0].photos[0].id : null
    if (gone) {
      e.setPhotos([ph('a'), ph('b'), ph('c')].filter((p) => p.id !== gone))
      expect(e.history.every((s) => s.photos.every((p) => p.id !== gone))).toBe(true)
    }
    e.destroy()
  })

  it('captions show the date in the household zone, not the frame\'s', async () => {
    const { captionText } = await import('~/widgets/slideshow-engine')
    const time = await import('~/lib/time')
    const p = { ...ph('a'), taken: Date.UTC(2026, 9, 10, 5, 30), contributor: 'Pat Example' }
    time.setZone('America/Phoenix')
    expect(captionText(p)).toBe('October 9, 2026') // New York would say October 10
    time.setZone('America/New_York')
    expect(captionText(p)).toBe('October 10, 2026')
    time.setZone('America/Phoenix')
    expect(captionText({ ...p, taken: null })).toBe('')
  })

  it('drops a preload that finished after the album emptied', async () => {
    let release: () => void = () => {}
    const shown: unknown[] = []
    const e = new Engine({ layout: 'cover', intervalSec: 3600 }, (s) => shown.push(s), () => new Promise<void>((r) => { release = r }))
    e.setPhotos([ph('a')])
    e.start()
    await tick()
    e.setPhotos([])
    release()
    await tick()
    expect(shown).toHaveLength(0)
    expect(e.current).toBeNull()
    e.destroy()
  })

  it('stop() stops the timer; a stopped engine shows nothing new on its own', async () => {
    const { e, shown } = make('cover')
    e.o.intervalSec = 0.01
    e.setPhotos([ph('a'), ph('b')])
    e.start()
    await new Promise((r) => setTimeout(r, 60))
    e.stop()
    const n = shown.length
    expect(n).toBeGreaterThan(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(shown.length).toBe(n)
    e.destroy()
  })
})
