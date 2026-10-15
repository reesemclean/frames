// Photos widget: a slideshow filling its grid cell, with the card's corners.
//   <section data-widget="photos" data-layout="auto" data-interval="12" data-captions="false"></section>
// Tap the left or right third for the previous or next photo; press and hold
// for 2 s to start the full-screen slideshow (a bar fills while held). It
// pauses whenever the dashboard isn't showing (the full-screen photos mode
// runs its own slideshow, and at night nobody's looking).
import { useRef } from 'react'
import type { WidgetProps } from '.'
import { num } from '.'
import { requestMode, useMode } from '~/lib/mode'
import { useHold } from '~/components/ui'
import { Slideshow, type SlideshowProps } from './Slideshow'
import { useDashboardOptions } from '~/lib/dashboard'

const LAYOUTS = ['auto', 'cover', 'pair', 'collage', 'polaroid']
const HOLD_MS = 2000

export function PhotosWidget({ opts }: WidgetProps) {
  const mode = useMode()
  // data-* first, then the dashboard's photos options.
  const dash = useDashboardOptions()
  const layout = (LAYOUTS.indexOf(opts.layout) >= 0 ? opts.layout : dash?.photos.layout || 'auto') as SlideshowProps['layout']
  const api = useRef<{ prev(): void; next(): void } | null>(null)
  const hold = useHold(HOLD_MS, {
    done: () => requestMode('photos'),
    tap: (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width
      if (x < 1 / 3) api.current?.prev()
      else if (x > 2 / 3) api.current?.next()
    },
  })
  return (
    <div className={'ph' + (hold.holding ? ' is-holding' : '')} {...hold.props}>
      <Slideshow
        layout={layout}
        intervalSec={Math.max(3, num(opts.interval, dash?.photos.intervalSec || 15))}
        captions={opts.captions !== 'false'}
        running={mode === 'day'}
        api={api}
      />
      <span className="ph-bar" />
    </div>
  )
}
