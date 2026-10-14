// STUB: owned by the photos workstream. Used by the photos widget and the
// full-screen photos mode:
//   <Slideshow layout="auto"|"cover"|"pair"|"collage"|"polaroid"
//              intervalSec={15} captions running />
// It polls /api/photos itself; `running` false stops its timer.
export interface SlideshowProps {
  layout: 'auto' | 'cover' | 'pair' | 'collage' | 'polaroid'
  intervalSec: number
  captions: boolean
  running: boolean
  /** Tap left/right third → prev/next (the widget); off in full screen. */
  tapZones?: boolean
}

export function Slideshow(_: SlideshowProps) {
  return <div className="slideshow" />
}
