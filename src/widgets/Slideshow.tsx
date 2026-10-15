// The photo slideshow, shared by the photos widget and the full-screen
// photos mode:
//   <Slideshow layout="auto"|"cover"|"pair"|"collage"|"polaroid"
//              intervalSec={15} captions running />
// It polls /api/photos itself; `running` false stops its timer. It fills its
// nearest positioned ancestor (position: absolute; inset 0).
//
// The picking and preloading live in ./slideshow-engine; this renders the
// slides it hands over. A new slide fades in over the old one (opacity only),
// and the old one leaves the DOM once the fade is done.
//
// SSR: the server and the first client render both show only the calm
// placeholder. Every slide (and everything random or time-dependent about
// it: the shuffle, the polaroid tilt, the caption date) arrives after mount.
import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { staleNote, usePoll } from '~/lib/api'
import type { Photo, Photos } from '~/lib/types'
import { captionText, Engine, type Slide } from './slideshow-engine'

export interface SlideshowProps {
  layout: 'auto' | 'cover' | 'pair' | 'collage' | 'polaroid'
  intervalSec: number
  captions: boolean
  running: boolean
  /** Filled in with prev/next while mounted (the widget's tap zones). */
  api?: MutableRefObject<{ prev(): void; next(): void } | null>
}

const FADE_MS = 900 // keep in step with slideshow.css
const POLL_MS = 10 * 60_000

interface Shown { key: number; slide: Slide; w: number; h: number; captions: boolean }

export function Slideshow({ layout, intervalSec, captions, running, api }: SlideshowProps) {
  const poll = usePoll<Photos>('/api/photos', POLL_MS)
  const list = poll.data ? poll.data.photos : null
  const [shown, setShown] = useState<Shown[]>([])
  const root = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
  const opts = useRef({ captions })
  opts.current.captions = captions
  const interval = Math.max(3, intervalSec || 15)

  // Created first: the effects below use it, and they run in order.
  useEffect(() => {
    let key = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    // The cell's shape decides whether a pair or collage fits; read at each
    // pick, since the next slide is picked ahead and a cell can change size.
    const measure = () => {
      const el = root.current
      return el && el.clientHeight ? el.clientWidth / el.clientHeight : 0
    }
    const e = new Engine({ layout, intervalSec: interval, measure }, (slide) => {
      const el = root.current
      const k = ++key
      const item: Shown = {
        key: k, slide,
        w: (el && el.clientWidth) || 1280, h: (el && el.clientHeight) || 800,
        captions: opts.current.captions,
      }
      setShown((prev) => prev.concat(item))
      // A timer, not animationend: that doesn't fire while hidden.
      const t = setTimeout(() => {
        timers.delete(t)
        setShown((prev) => (prev.length > 1 ? prev.filter((s) => s.key >= k) : prev))
      }, FADE_MS + 100)
      timers.add(t)
    })
    engine.current = e
    return () => {
      e.destroy()
      timers.forEach(clearTimeout)
      engine.current = null
    }
    // One engine for the component's life; option changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const e = engine.current
    if (e) { e.o.layout = layout; e.o.intervalSec = interval }
  }, [layout, interval])

  useEffect(() => {
    const e = engine.current
    if (!e || !list) return
    e.setPhotos(list)
    if (!list.length) setShown([])
  }, [list])

  useEffect(() => {
    const e = engine.current
    if (!e) return
    if (running) e.start()
    else e.stop()
  }, [running])

  useEffect(() => {
    if (!api) return
    api.current = {
      prev: () => { if (engine.current) void engine.current.prev() },
      next: () => { if (engine.current) void engine.current.next() },
    }
    return () => { api.current = null }
  }, [api])

  let empty: string | null = null
  if (!shown.length) empty = !list ? staleNote(poll) : list.length ? '' : 'No photos yet'

  return (
    <div className="ss" ref={root}>
      {empty != null && (
        <div className="ss-empty"><span className="ss-empty-msg">{empty}</span></div>
      )}
      {shown.map((s) => <SlideView key={s.key} item={s} />)}
    </div>
  )
}

function Img({ src, className, style }: { src: string; className?: string; style?: React.CSSProperties }) {
  return <img className={className} src={src} alt="" draggable={false} style={style} />
}

const SlideView = memo(function SlideView({ item }: { item: Shown }) {
  const { slide, w: W, h: H } = item
  const fs = Math.max(13, Math.round(H * 0.024))
  const cap = (p: Photo) => {
    const t = item.captions ? captionText(p) : ''
    return t ? <div className="ss-cap" style={{ fontSize: fs }}>{t}</div> : null
  }
  const p = slide.photos[0]
  const bg = p.backdrop && !slide.noBackdrop ? <Img src={p.backdrop} className="ss-bg" /> : null

  if (slide.layout === 'pair' || slide.layout === 'collage') {
    return (
      <div className={'ss-slide ss-' + slide.layout}>
        {slide.photos.map((x, i) => (
          <div key={x.id + i} className={'ss-pane ss-pane--' + 'abc'[i]}>
            <Img src={x.url} className="ss-cover" />
            {slide.layout === 'pair' || i === 0 ? cap(x) : null}
          </div>
        ))}
      </div>
    )
  }
  if (slide.layout === 'polaroid') {
    const capH = Math.round(H * 0.1), pad = Math.max(6, Math.round(H * 0.025))
    const ar = p.w / p.h
    const ih = Math.round(Math.min(H * 0.84 - capH - pad, (W * 0.8 - 2 * pad) / ar))
    const iw = Math.round(ih * ar)
    return (
      <div className="ss-slide ss-polaroid">
        {bg}
        <figure
          className="ss-pol"
          style={{
            padding: pad + 'px ' + pad + 'px 0',
            margin: -(ih + capH + pad) / 2 + 'px 0 0 ' + -(iw + 2 * pad) / 2 + 'px',
            transform: 'rotate(' + slide.rot + 'deg)',
          }}
        >
          <Img src={p.url} style={{ width: iw, height: ih }} />
          <figcaption style={{ height: capH, fontSize: Math.round(capH * 0.45) }}>
            {item.captions ? captionText(p) : ''}
          </figcaption>
        </figure>
      </div>
    )
  }
  if (p.o === 'p') {
    return (
      <div className="ss-slide ss-fit">
        {bg}
        <Img src={p.url} className="ss-contain" />
        {cap(p)}
      </div>
    )
  }
  return (
    <div className="ss-slide ss-full">
      <Img src={p.url} className="ss-cover" />
      {cap(p)}
    </div>
  )
})
