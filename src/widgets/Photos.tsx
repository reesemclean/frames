// Photos widget: a slideshow filling its grid cell, with the card's corners.
//   <section data-widget="photos" data-layout="auto" data-interval="12" data-captions="false"></section>
// Tap the left or right third for the previous or next photo. It pauses
// whenever the dashboard isn't showing (the full-screen photos mode runs its
// own slideshow, and at night nobody's looking).
import type { WidgetProps } from '.'
import { num } from '.'
import { useMode } from '~/lib/mode'
import { Slideshow, type SlideshowProps } from './Slideshow'
import { useDashboardOptions } from '~/lib/dashboard'

const LAYOUTS = ['auto', 'cover', 'pair', 'collage', 'polaroid']

export function PhotosWidget({ opts }: WidgetProps) {
  const mode = useMode()
  // data-* first, then the dashboard's photos options.
  const dash = useDashboardOptions()
  const layout = (LAYOUTS.indexOf(opts.layout) >= 0 ? opts.layout : dash?.photos.layout || 'auto') as SlideshowProps['layout']
  return (
    <div className="ph">
      <Slideshow
        layout={layout}
        intervalSec={Math.max(3, num(opts.interval, dash?.photos.intervalSec || 15))}
        captions={opts.captions !== 'false'}
        running={mode === 'day'}
        tapZones
      />
    </div>
  )
}
