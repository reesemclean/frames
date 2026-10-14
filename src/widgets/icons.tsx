// Weather icons: 24×24 stroke drawings in currentColor, the same drawing
// style as the rest of the dashboard. Inline SVG (nothing loaded from
// outside the service). Exported for reuse, e.g. the photos/night info strip.
import type { ReactNode } from 'react'
import type { WeatherIcon } from '~/lib/types'

// The cloud raised a little, to leave room for what falls out of it.
const CLOUD_HI = <path d="M7 15h10.2a4.3 4.3 0 0 0 .4-8.6A6.2 6.2 0 0 0 5.8 8.1 3.5 3.5 0 0 0 7 15z" />
const CLOUD_LOW = 'M9.5 20h8.3a3.6 3.6 0 0 0 .3-7.2 5.2 5.2 0 0 0-9.9 1.4A2.9 2.9 0 0 0 9.5 20z'

export const WEATHER_ICONS: Record<WeatherIcon, ReactNode> = {
  sun: <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
  </>,
  moon: <path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.2 8.2 0 1 0 20 14.5z" />,
  partly: <>
    <path d="M8.5 2.5v1.3M3.4 4.6l.9.9M1.8 9.6h1.3M13.6 4.6l-.9.9" />
    <path d="M5.3 12.3a4 4 0 0 1 6.9-4.4" />
    <path d={CLOUD_LOW} />
  </>,
  'partly-night': <>
    <path d="M12.6 7.6A4.6 4.6 0 0 1 6.8 2.4a4.8 4.8 0 0 0-1.9 9.1" />
    <path d={CLOUD_LOW} />
  </>,
  cloud: <path d="M7 18.5h10.2a4.3 4.3 0 0 0 .4-8.6A6.2 6.2 0 0 0 5.8 11.6 3.5 3.5 0 0 0 7 18.5z" />,
  fog: <>{CLOUD_HI}<path d="M4 18.5h16M7 21.5h10" /></>,
  drizzle: <>{CLOUD_HI}<path d="M8.5 18.5v.6M12.5 20v.6M16.5 18.5v.6M10.5 22v.6M14.5 22v.6" /></>,
  rain: <>{CLOUD_HI}<path d="M8.5 18l-1 3M12.5 18l-1 3M16.5 18l-1 3" /></>,
  snow: <>{CLOUD_HI}<path d="M8 17.5v3M6.7 19h2.6M16 17.5v3M14.7 19h2.6M12 20v3M10.7 21.5h2.6" /></>,
  storm: <>{CLOUD_HI}<path d="M13 14.5l-2.5 4h3.2l-2.4 4" /></>,
}

/** One weather icon at `size` px; an unknown name draws plain cloud. */
export function WxIcon({ name, size = 24, className }: { name: WeatherIcon | string; size?: number; className?: string }) {
  return (
    <svg
      className={className ? 'wx-svg ' + className : 'wx-svg'}
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {WEATHER_ICONS[name as WeatherIcon] || WEATHER_ICONS.cloud}
    </svg>
  )
}
