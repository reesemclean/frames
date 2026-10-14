// The slideshow engine's picking: every photo comes round, for every album
// mix, layout and cell shape, and pair/collage only where they fit.
//
// Math.random is seeded per run, so a failure names a seed that reproduces it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Layout, type Slide } from '~/widgets/slideshow-engine'
import type { Photo } from '~/lib/types'

const ph = (id: string, o: 'l' | 'p'): Photo =>
  ({ id, url: `/photos/${id}.jpg`, backdrop: o === 'p' ? `/photos/${id}-bg.jpg` : null, w: o === 'p' ? 600 : 1067, h: 800, o, taken: null, contributor: null })

const album = (portraits: number, landscapes: number): Photo[] =>
  Array.from({ length: portraits }, (_, i) => ph('P' + i, 'p')).concat(Array.from({ length: landscapes }, (_, i) => ph('L' + i, 'l')))

function seed(s: number): void {
  // mulberry32
  vi.spyOn(Math, 'random').mockImplementation(() => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  })
}

function picks(layout: Layout, photos: Photo[], aspect: number, count: number): Slide[] {
  const e = new Engine({ layout, intervalSec: 3600, measure: () => aspect }, () => {}, async () => {})
  e.setPhotos(photos)
  return Array.from({ length: count }, () => e.pick()!)
}

// One pass of the (weighted) queue, twice over.
const enough = (n: number) => 2 * (n + (n > 4 ? Math.ceil(n / 5) : 0)) + 2

const MIXES: [string, Photo[]][] = [
  ['one portrait + landscapes', album(1, 6)],
  ['two portraits + landscapes', album(2, 8)],
  ['mixed', album(3, 3)],
  ['all portraits', album(5, 0)],
  ['all landscapes', album(0, 7)],
  ['two portraits only', album(2, 0)],
  ['a single photo', album(1, 0)],
]
const LAYOUTS: Layout[] = ['auto', 'cover', 'pair', 'collage', 'polaroid']
// Full screen, the example dashboard's wide short cell, a square cell, a tall one.
const ASPECTS = [1.6, 816 / 250, 1, 400 / 600]

afterEach(() => { vi.restoreAllMocks() })

describe('every photo comes round', () => {
  for (const [name, photos] of MIXES) {
    for (const layout of LAYOUTS) {
      it(`${name}, ${layout}`, () => {
        for (const aspect of ASPECTS) {
          for (let s = 1; s <= 25; s++) {
            seed(s)
            const slides = picks(layout, photos, aspect, enough(photos.length))
            const seen = new Set(slides.flatMap((x) => x.photos.map((p) => p.id)))
            expect([...seen].sort(), `aspect ${aspect} seed ${s}`).toEqual(photos.map((p) => p.id).sort())
            slides.forEach((x, i) => {
              const ids = x.photos.map((p) => p.id)
              expect(new Set(ids).size, `aspect ${aspect} seed ${s} slide ${i}`).toBe(ids.length)
              const prev = i ? slides[i - 1].photos.map((p) => p.id) : []
              if (photos.length > prev.length) expect(prev, `aspect ${aspect} seed ${s} slide ${i}`).not.toContain(ids[0])
            })
            vi.restoreAllMocks()
          }
        }
      })
    }
  }
})

describe('layouts follow the cell shape', () => {
  const kinds = (layout: Layout, photos: Photo[], aspect: number) => {
    const out = new Set<string>()
    for (let s = 1; s <= 10; s++) {
      seed(s)
      for (const x of picks(layout, photos, aspect, 30)) out.add(x.layout)
      vi.restoreAllMocks()
    }
    return out
  }

  it('auto pairs portraits and makes collages full screen', () => {
    const k = kinds('auto', album(4, 8), 1.6)
    expect(k.has('pair')).toBe(true)
    expect(k.has('collage')).toBe(true)
  })

  it.each([['wide short', 816 / 250], ['tall', 400 / 600]])('auto never pairs or collages in a %s cell', (_, aspect) => {
    const k = kinds('auto', album(4, 8), aspect)
    expect(k.has('pair')).toBe(false)
    expect(k.has('collage')).toBe(false)
    expect(k.has('cover')).toBe(true)
  })

  it('a square cell pairs but makes no collage', () => {
    const k = kinds('auto', album(4, 8), 1)
    expect(k.has('pair')).toBe(true)
    expect(k.has('collage')).toBe(false)
  })

  it('forced pair and collage fall back to cover where they would not fit', () => {
    expect([...kinds('pair', album(4, 4), 816 / 250)]).toEqual(['cover'])
    expect([...kinds('collage', album(4, 4), 816 / 250)]).toEqual(['cover'])
    expect([...kinds('collage', album(4, 4), 1)]).toEqual(['cover'])
    expect(kinds('collage', album(4, 4), 1.6).has('collage')).toBe(true)
  })

  it('an unmeasured or hidden cell keeps the last good shape', () => {
    let aspect = 816 / 250
    const e = new Engine({ layout: 'pair', intervalSec: 3600, measure: () => aspect }, () => {}, async () => {})
    e.setPhotos(album(4, 0))
    expect(e.pick()!.layout).toBe('cover')
    aspect = NaN // 0/0: the full-screen stage while it's hidden
    expect(e.pick()!.layout).toBe('cover')
    aspect = 1.6
    expect(e.pick()!.layout).toBe('pair')
  })
})

describe('forced pair', () => {
  it('one portrait among landscapes does not freeze on that portrait', () => {
    for (let s = 1; s <= 25; s++) {
      seed(s)
      const ids = picks('pair', album(1, 6), 1.6, 12).map((x) => x.photos.map((p) => p.id).join('+'))
      expect(new Set(ids).size, `seed ${s}`).toBeGreaterThan(5)
      vi.restoreAllMocks()
    }
  })

  it('shows the landscapes as cover between portrait pairs', () => {
    seed(7)
    const slides = picks('pair', album(2, 8), 1.6, 30)
    expect(slides.filter((x) => x.layout === 'cover' && x.photos[0].o === 'l').length).toBeGreaterThan(8)
    for (const x of slides) if (x.layout === 'pair') expect(x.photos.map((p) => p.o)).toEqual(['p', 'p'])
  })
})

describe('collage', () => {
  it('puts the portrait in the tall pane and landscapes in the small ones', () => {
    for (let s = 1; s <= 25; s++) {
      seed(s)
      const slides = picks('collage', album(1, 6), 1.6, 20)
      for (const x of slides) {
        expect(x.layout).toBe('collage')
        expect(x.photos.slice(1).map((p) => p.o), `seed ${s}`).toEqual(['l', 'l'])
      }
      expect(slides.some((x) => x.photos[0].o === 'p'), `seed ${s}`).toBe(true)
      vi.restoreAllMocks()
    }
  })

  it('uses any orientation when the album has nothing better', () => {
    seed(3)
    for (const x of picks('collage', album(4, 0), 1.6, 10)) expect(x.layout).toBe('collage')
    seed(4)
    for (const x of picks('collage', album(0, 4), 1.6, 10)) expect(x.layout).toBe('collage')
  })
})
