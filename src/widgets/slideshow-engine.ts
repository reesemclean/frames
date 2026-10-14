// The slideshow's brain, apart from React: which photos come next, in what
// layout, preloaded before they're shown. <Slideshow> owns one and renders
// whatever it hands to onShow.
//
// Built for a slow GPU: the server already resized every photo and made the
// blurred backdrop for portraits, so the frame only ever crossfades opacity.
// Each slide's images are downloaded and decoded before it's shown, and the
// next slide is prepared while the current one is up.
import type { Photo } from '~/lib/types'
import * as time from '~/lib/time'

export type Layout = 'auto' | 'cover' | 'pair' | 'collage' | 'polaroid'
export type SlideLayout = Exclude<Layout, 'auto'>

export interface Slide {
  layout: SlideLayout
  photos: Photo[]
  /** The backdrop failed to load; show the photo without it. */
  noBackdrop?: boolean
  /** Polaroid tilt in degrees, fixed when picked so prev() shows it the same. */
  rot: number
}

export type Loader = (src: string) => Promise<unknown>

const HISTORY = 20
// The frame's own screen (1280x800), until the cell is measured.
const DEFAULT_ASPECT = 1.6
// Pair: each half (aspect/2) at most square, so a portrait loses little of
// its height, and not much under 1:2, which would be a sliver.
const PAIR_ASPECT = [1, 2]
// Collage: tall pane a at 3/5 width, b and c stacked beside it; outside this
// band a and the small panes crop people to strips.
const COLLAGE_ASPECT = [1.2, 1.8]
const LOAD_TIMEOUT_MS = 20_000

/** Resolves once the image is downloaded and decoded; rejects on error. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    const t = setTimeout(() => { im.src = ''; reject(new Error('timeout ' + src)) }, LOAD_TIMEOUT_MS)
    im.onload = () => {
      clearTimeout(t)
      const done = () => resolve(im)
      if (im.decode) im.decode().then(done, done)
      else done()
    }
    im.onerror = () => { clearTimeout(t); reject(new Error('failed ' + src)) }
    im.src = src
  })
}

// "October 9, 2026 · Sam", in the household's zone (time.setZone), never
// the frame's own.
export function captionText(p: Photo): string {
  const bits: string[] = []
  if (p.taken) {
    const t = time.parts(new Date(p.taken))
    bits.push(time.names.month(t.mo) + ' ' + t.d + ', ' + t.y)
  }
  if (p.contributor) bits.push(p.contributor.split(' ')[0])
  return bits.join(' · ')
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)), t = a[i]
    a[i] = a[j]; a[j] = t
  }
  return a
}

export interface EngineOptions {
  layout: Layout
  intervalSec: number
  /** The slideshow's width / height, read at every pick; 0 or NaN (hidden,
   * not laid out yet) keeps the last good reading. */
  measure?: () => number
}

const within = (x: number, [lo, hi]: number[]) => x >= lo && x <= hi

export class Engine {
  o: EngineOptions
  photos: Photo[] = []
  private ids: string | null = null
  queue: Photo[] = []
  history: Slide[] = []
  current: Slide | null = null
  private upcoming: Promise<Slide> | null = null
  private running = false
  private busy = false
  private dead = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private count = 0
  // The previous slide's photos: the next one doesn't open with any of them.
  private lastIds: string[] = []
  private aspect = DEFAULT_ASPECT

  constructor(
    opts: EngineOptions,
    private readonly onShow: (slide: Slide) => void,
    private readonly load: Loader = loadImage,
  ) {
    this.o = { ...opts }
  }

  /** A new /api/photos list (every poll; unchanged lists are ignored). */
  setPhotos(list: Photo[]): void {
    // url too: an edited photo keeps its id but gets new files, and the old
    // ones are deleted server-side.
    const ids = list.map((p) => p.id + ' ' + p.url).join(',')
    if (ids === this.ids) return
    const wasEmpty = !this.photos.length
    const before = new Set(this.photos.map((p) => p.id))
    const byId = new Map(list.map((p) => [p.id, p] as const))
    this.ids = ids
    this.photos = list
    // Swap in the fresh objects and drop vanished photos (and history slides
    // showing them); newly added ones go to the queue's front.
    this.queue = this.queue.filter((p) => byId.has(p.id)).map((p) => byId.get(p.id)!)
    const fresh = (s: Slide): Slide | null =>
      s.photos.every((p) => byId.has(p.id)) ? { layout: s.layout, rot: s.rot, photos: s.photos.map((p) => byId.get(p.id)!) } : null
    this.history = this.history.map(fresh).filter((s): s is Slide => s != null)
    if (this.current) {
      this.current = fresh(this.current)
      const added = list.filter((p) => !before.has(p.id))
      for (let i = added.length - 1; i >= 0; i--) this.queue.unshift(added[i])
    }
    // It may hold a photo that just changed or went.
    this.upcoming = null
    if (!list.length) return
    // next() bails without rescheduling while the album is empty, so the
    // timer is dead by the time photos come back.
    if (this.running && (wasEmpty || !this.current)) void this.next()
  }

  // Shuffled, with the newest fifth of the album (the list arrives
  // newest-first) in twice so recent photos come round a bit more often.
  private refill(): void {
    const n = this.photos.length, head = n > 4 ? Math.ceil(n / 5) : 0
    const q: Photo[] = []
    this.photos.forEach((p, i) => { q.push(p); if (i < head) q.push(p) })
    shuffle(q)
    if (q.length > 1 && this.lastIds.indexOf(q[0].id) >= 0) q.push(q.shift()!)
    this.queue = q
  }

  // queueOnly: no random fallback from the whole album. That fallback takes
  // nothing off the queue, so a pick built only from it would never move the
  // queue on, and the same few photos would repeat while the rest wait.
  private take(pred?: ((p: Photo) => boolean) | null, not?: string[] | null, queueOnly = false): Photo | null {
    const ok = (p: Photo) => (!pred || pred(p)) && !(not && not.indexOf(p.id) >= 0)
    if (!this.queue.length) this.refill()
    for (let i = 0; i < this.queue.length; i++) if (ok(this.queue[i])) return this.queue.splice(i, 1)[0]
    if (queueOnly) return null
    const rest = this.photos.filter(ok)
    return rest.length ? rest[Math.floor(Math.random() * rest.length)] : null
  }

  /** The next slide: its photos and layout. */
  pick(): Slide | null {
    if (!this.photos.length) return null
    const n = this.count++
    const m = this.o.measure ? this.o.measure() : 0
    if (m > 0 && isFinite(m)) this.aspect = m
    // A pair or collage that doesn't fit the cell's shape is shown as cover.
    const canPair = within(this.aspect, PAIR_ASPECT), canCollage = within(this.aspect, COLLAGE_ASPECT)
    const isP = (x: Photo) => x.o === 'p', isL = (x: Photo) => x.o !== 'p'
    let layout: Layout = this.o.layout
    let first = (this.take(null, this.lastIds.length ? this.lastIds : null) || this.take())!
    const portraits = this.photos.filter(isP).length
    if (layout === 'auto') {
      if (first.o === 'p') layout = n % 3 === 2 ? 'polaroid' : portraits >= 2 && canPair ? 'pair' : 'cover'
      else layout = this.photos.length >= 3 && n % 6 === 3 && canCollage ? 'collage' : n % 6 === 5 ? 'polaroid' : 'cover'
    }
    if ((layout === 'pair' && !canPair) || (layout === 'collage' && (!canCollage || this.photos.length < 3))) layout = 'cover'
    let ps = [first]
    if (layout === 'pair') {
      // A landscape opener swaps for a queued portrait; with none left in the
      // queue it shows as cover, so landscapes still come round.
      if (first.o !== 'p') {
        const p = this.take(isP, this.lastIds, true)
        if (p) { this.queue.unshift(first); first = p; ps = [p] }
      }
      const not = [first.id].concat(this.lastIds)
      const second = first.o === 'p' ? this.take(isP, not, true) || this.take(isP, not) || this.take(isP, [first.id]) : null
      if (second) ps.push(second)
      else layout = 'cover'
    } else if (layout === 'collage') {
      // Pane a is the tall one: a portrait there, landscapes in the short
      // b and c, any orientation when the album can't do better.
      let a = first, b: Photo | null = null
      if (first.o !== 'p') {
        const p = this.take(isP, this.lastIds, true)
        if (p) { a = p; b = first }
      }
      const pref = (not: string[]) => this.take(isL, not) || this.take(null, not)
      b = b || pref([a.id])!
      // Three distinct photos exist (checked above), so the fallback finds them.
      ps = [a, b, pref([a.id, b.id])!]
    }
    this.lastIds = ps.map((p) => p.id)
    return { layout, photos: ps, rot: Math.round((Math.random() * 5 - 2.5) * 10) / 10 }
  }

  // Download + decode every image a slide needs. A missing backdrop is fine;
  // a missing photo rejects, and the caller moves on to another slide.
  prepare(slide: Slide): Promise<Slide> {
    const jobs: Promise<unknown>[] = []
    const out: Slide = { ...slide, noBackdrop: false }
    slide.photos.forEach((p, i) => {
      jobs.push(this.load(p.url))
      if (i === 0 && p.backdrop && (slide.layout === 'cover' || slide.layout === 'polaroid')) {
        jobs.push(this.load(p.backdrop).catch(() => { out.noBackdrop = true }))
      }
    })
    return Promise.all(jobs).then(() => out)
  }

  private nextPrepared(): Promise<Slide> {
    const s = this.pick()
    return s ? this.prepare(s) : Promise.reject(new Error('no photos'))
  }

  /** Every photo on the slide is still in the list, with the same file: a
   * preload can finish after the list changed (an edit, a deletion, the
   * album emptied), and nothing would replace that slide. */
  private isCurrent(slide: Slide): boolean {
    return slide.photos.every((p) => this.photos.some((x) => x.id === p.id && x.url === p.url))
  }

  private show(slide: Slide): boolean {
    if (this.dead || !this.isCurrent(slide)) return false
    this.current = slide
    this.onShow(slide)
    return true
  }

  async next(): Promise<void> {
    if (this.busy || this.dead || !this.photos.length) return
    this.busy = true
    this.clearTimer()
    try {
      let prepared: Slide | null = null
      // Skip any slide whose image won't load (a 404, a timeout).
      for (let tries = 0; !prepared && tries < 4; tries++) {
        const pending = this.upcoming
        this.upcoming = null
        try {
          prepared = await (pending || this.nextPrepared())
        } catch (e) {
          console.warn('[slideshow] skipping', (e as Error)?.message)
        }
        if (this.dead) return
        if (prepared && !this.isCurrent(prepared)) prepared = null
      }
      if (prepared) {
        const prev = this.current
        if (!this.show(prepared)) return
        if (prev) {
          this.history.push(prev)
          if (this.history.length > HISTORY) this.history.shift()
        }
        const up = this.nextPrepared()
        up.catch(() => {}) // retried in next()
        this.upcoming = up
      }
    } finally {
      this.busy = false
      this.schedule()
    }
  }

  async prev(): Promise<void> {
    if (this.busy || this.dead || !this.history.length) return
    this.busy = true
    this.clearTimer()
    try {
      const slide = await this.prepare(this.history.pop()!)
      if (this.dead) return
      this.show(slide)
    } catch (e) {
      console.warn('[slideshow] prev failed', (e as Error)?.message)
    } finally {
      this.busy = false
      this.schedule()
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    this.clearTimer()
    if (this.running && !this.dead) this.timer = setTimeout(() => void this.next(), this.o.intervalSec * 1000)
  }

  start(): void {
    if (this.running || this.dead) return
    this.running = true
    if (!this.current) void this.next()
    else this.schedule()
  }

  stop(): void {
    this.running = false
    this.clearTimer()
  }

  isRunning(): boolean { return this.running }

  destroy(): void {
    this.stop()
    this.dead = true
    this.upcoming = null
  }
}
