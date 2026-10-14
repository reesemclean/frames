// The frame's page: the fixed 1280×800 stage, the dashboard's widgets, and
// the overlays (toasts, sheets, photos and night modes). Also the shell
// duties: desktop scaling, ?at= previews, the daily reload, idle tracking.
import { useEffect } from 'react'
import type { Dashboard } from '~/server/dashboards'
import * as time from '~/lib/time'
import { retick, startClock } from '~/lib/clock'
import { scheduleDailyReload } from '~/lib/reload'
import { touched } from '~/lib/mode'
import { DashboardOptionsContext } from '~/lib/dashboard'
import { UIProvider } from './ui'
import { DashboardTree } from './DashboardTree'
import { Modes } from './Modes'
import { Boundary } from './ErrorBoundary'

declare global {
  interface Window { FRAMES?: { started?: boolean } }
}

export function Frame({ dash }: { dash: Dashboard }) {
  // Before any child renders, on the server and on the frame.
  time.setZone(dash.tz)

  useEffect(() => {
    const stage = document.getElementById('stage')!
    // Desktop preview only: scale the stage to the window.
    const fit = () => {
      const s = Math.min(window.innerWidth / 1280, window.innerHeight / 800)
      stage.style.transform = Math.abs(s - 1) < 0.01 ? '' : 'scale(' + s + ')'
    }
    fit()
    window.addEventListener('resize', fit)

    // ?at=HH:MM pins the clock for previews (e.g. ?at=22:15 for night mode).
    const at = /[?&]at=(\d{1,2}):(\d{2})/.exec(location.search)
    if (at) {
      const p = time.parts(new Date())
      time.setOffset((+at[1] * 60 + +at[2] - p.mins) * 60000 - p.s * 1000)
      retick()
    }
    startClock()

    const touch = () => touched()
    document.addEventListener('pointerdown', touch, true)

    // Module-level, so it outlives this effect (see lib/reload.ts).
    scheduleDailyReload(dash.options.reloadAt)

    window.FRAMES = { ...(window.FRAMES || {}), started: true }
    return () => {
      window.removeEventListener('resize', fit)
      document.removeEventListener('pointerdown', touch, true)
    }
  }, [dash.options.reloadAt])

  return (
    <div className="stage" id="stage" data-mode="day">
      {dash.css && <style dangerouslySetInnerHTML={{ __html: dash.css }} />}
      <DashboardOptionsContext.Provider value={dash.options}>
      <UIProvider>
        <main className="board" id="board">
          {/* Keeps #stage (and so the page's own recovery) alive if the
              tree itself throws; widgets also have their own boundaries. */}
          <Boundary name="dashboard" fallback={null}>
            <DashboardTree nodes={dash.tree} />
          </Boundary>
        </main>
        <Boundary name="modes" fallback={null}>
          <Modes options={dash.options} />
        </Boundary>
      </UIProvider>
      </DashboardOptionsContext.Provider>
    </div>
  )
}
