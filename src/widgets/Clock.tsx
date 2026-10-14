// Clock: 12-hour time, AM/PM, "Tuesday, October 13". Needs no server data.
// Options:
//   data-size="auto|s|m|l"  auto (default) scales to the grid cell
//   data-seconds="true"     show seconds (only that one node re-renders)
// The time comes from time.parts() via useMinute(), so it reads the
// household's zone, not the frame's own, and re-renders once a minute.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ClientOnly } from '@tanstack/react-router'
import { stampMinute, useMinute, useSecond } from '~/lib/clock'
import * as time from '~/lib/time'
import type { WidgetProps } from '.'

const SIZES: Record<string, number> = { s: 56, m: 96, l: 150 }

export function Clock({ opts }: WidgetProps) {
  const p = useMinute()
  const seconds = opts.seconds === 'true'
  const size = opts.size || 'auto'
  const ref = useRef<HTMLDivElement>(null)
  const [fs, setFs] = useState<number | null>(SIZES[size] || null)

  // Size: fixed, or scaled to the cell (re-measured only when the cell
  // itself changes size).
  useEffect(() => {
    if (SIZES[size]) { setFs(SIZES[size]); return }
    const card = ref.current
    if (!card || typeof ResizeObserver === 'undefined') { setFs(SIZES.m); return }
    const fit = () => {
      const cs = getComputedStyle(card)
      const w = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const h = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      if (w <= 0 || h <= 0) return
      // "10:42" + AM is ~3.2em wide (3.9em with seconds); the date line
      // takes about a third of the height below the time.
      const f = Math.max(32, Math.min(h * 0.6, w / (seconds ? 3.9 : 3.2), 220))
      setFs(Math.round(f))
    }
    const ro = new ResizeObserver(fit)
    ro.observe(card)
    return () => ro.disconnect()
  }, [size, seconds])

  const style = fs ? ({ ['--clk-fs' as string]: fs + 'px' } as CSSProperties) : undefined
  // data-minute: hydration renders the server's minute (lib/clock), so the
  // text matches the HTML even when the frame's clock has moved past it.
  return (
    <div className="card clk" ref={ref} style={style} data-minute={stampMinute(p)}>
      <div className="clk-row">
        <span className="clk-time num">{time.clock(p.mins)}</span>
        {seconds && (
          // Seconds never match the server's render: client only.
          <ClientOnly fallback={null}>
            <Seconds />
          </ClientOnly>
        )}
        <span className="clk-ampm">{time.ampm(p.mins)}</span>
      </div>
      <div className="clk-date serif">
        {time.names.day(p.dow) + ', ' + time.names.month(p.mo) + ' ' + p.d}
      </div>
    </div>
  )
}

// The only per-second subscriber. Every real zone's offset is a whole number
// of minutes, so UTC seconds are the household's seconds too, without an Intl
// call each tick. time.now() includes the ?at= preview offset.
function Seconds() {
  useSecond()
  const s = time.now().getUTCSeconds()
  return <span className="clk-sec num">{':' + (s < 10 ? '0' : '') + s}</span>
}
