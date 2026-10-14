// /admin: a parent's phone page for kids, goals and targets.
//
// Server-rendered with plain forms that POST to /admin and get a 303 back
// here (handleAdminPost in server/stars.ts), so it works on any phone
// browser, with or without JS. React escapes every value: names and goals
// come from this page and end up on the frames.
//
// No auth, by design for v1: the service is LAN-only, like the star API
// itself. The footer says so. Writes from another site's page are refused
// (same-origin check, and the page can't be framed), but anyone on the home
// network can use it.
//
// This page isn't for the frame: it's laid out for a phone, scrolls, and
// overrides the frame's fixed viewport and overflow:hidden body.
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { ensureStarted } from '~/server/startup'
import { adminView, handleAdminPost, type AdminKid, type AdminView } from '~/server/stars'

const getAdmin = createServerFn({ method: 'GET' }).handler((): AdminView => {
  ensureStarted()
  return adminView()
})

interface Search { ok?: string; error?: string }

export const Route = createFileRoute('/admin')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ok: typeof s.ok === 'string' ? s.ok : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
  }),
  server: {
    handlers: {
      POST: async ({ request }) => {
        ensureStarted()
        return handleAdminPost(request)
      },
    },
  },
  loader: () => getAdmin(),
  // No framing: a form submitted from inside a framed /admin carries this
  // site's Origin, so the same-origin write check would let a clickjacked
  // click through.
  headers: () => ({
    'Cache-Control': 'no-cache',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  }),
  head: () => ({
    meta: [
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Star charts' },
    ],
  }),
  component: AdminPage,
})

const CSS = `
html, body { height: auto; overflow: auto; background: #f2eee6; -webkit-user-select: text; user-select: text; }
body { font: 16px/1.4 system-ui, sans-serif; color: #111; touch-action: auto; }
.adm { max-width: 640px; margin: 0 auto; padding: 16px; }
.adm h1 { font-size: 26px; margin: 8px 0 16px; font-weight: 800; }
.adm h2 { font-size: 20px; margin: 0; font-weight: 800; }
.adm section { background: #fbf9f4; border: 2px solid #111; border-radius: 14px; padding: 16px; margin: 0 0 16px; }
.adm .kid h2 { display: flex; align-items: center; gap: 10px; }
.adm .dot { width: 18px; height: 18px; border-radius: 50%; flex: none; }
.adm .goal { margin: 6px 0 2px; font-size: 18px; }
.adm .count { font-weight: 700; }
.adm .muted { color: #7a756b; font-size: 14px; }
.adm details { margin-top: 12px; border-top: 1px solid #d6cfc0; padding-top: 10px; }
.adm summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
.adm form { margin: 10px 0 0; display: grid; gap: 8px; }
.adm label { display: grid; gap: 4px; font-size: 14px; color: #3b3934; }
.adm input[type=text], .adm input[type=number] { font: inherit; padding: 10px; border: 1px solid #b9b1a2; border-radius: 8px; width: 100%; background: #fff; -webkit-user-select: text; user-select: text; }
.adm input[type=color] { width: 64px; height: 44px; padding: 2px; border: 1px solid #b9b1a2; border-radius: 8px; background: #fff; }
.adm button { font: inherit; font-weight: 700; padding: 12px 16px; border-radius: 10px; border: 0; background: #111; color: #fbf9f4; justify-self: start; }
.adm button.quiet { background: #e8e2d5; color: #111; }
.adm table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 6px; }
.adm td, .adm th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #e8e2d5; }
.adm .msg { padding: 12px 14px; border-radius: 10px; margin: 0 0 16px; font-weight: 600; }
.adm .msg.ok { background: #d7f0e4; }
.adm .msg.err { background: #fbd9d6; }
.adm footer { color: #7a756b; font-size: 13px; margin: 24px 0; }
`

function AdminPage() {
  const view = Route.useLoaderData()
  const { ok, error } = Route.useSearch()
  const active = view.kids.filter((k) => k.active)
  const hidden = view.kids.filter((k) => !k.active)
  const d = view.defaults
  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <h1>Star charts</h1>
      {error ? <p className="msg err">{error}</p> : ok ? <p className="msg ok">{ok}</p> : null}
      {active.length
        ? active.map((k) => <KidSection key={k.id} kid={k} view={view} />)
        : <section><p className="muted">No kids yet. Add one below.</p></section>}
      {hidden.length > 0 && (
        <section>
          <h2>Hidden</h2>
          {hidden.map((k) => (
            <form key={k.id} method="post" action="/admin">
              <input type="hidden" name="op" value="show" />
              <input type="hidden" name="kid" value={k.id} />
              <button className="quiet">Show {k.name} again</button>
            </form>
          ))}
        </section>
      )}
      <section>
        <h2>Add a kid</h2>
        <form method="post" action="/admin">
          <input type="hidden" name="op" value="add" />
          <label>Name <input type="text" name="name" maxLength={d.maxName} required /></label>
          <label>Colour <input type="color" name="color" defaultValue={d.color} /></label>
          <label>Goal <input type="text" name="goal" maxLength={d.maxGoal} required /></label>
          <label>Stars to reach it <input type="number" name="target" defaultValue={d.target} min={1} max={d.maxTarget} required /></label>
          <button>Add</button>
        </form>
      </section>
      <footer>
        Anyone on the home network can open this page and give stars; there's no login, by design.
        Times are {view.tz}. <a href="/">Dashboards</a>
      </footer>
    </main>
  )
}

function KidSection({ kid, view }: { kid: AdminKid; view: AdminView }) {
  const c = kid.current
  const d = view.defaults
  return (
    <section className="kid">
      <h2><span className="dot" style={{ background: kid.color }} />{kid.name}</h2>
      {c ? (
        <>
          <p className="goal">{c.goal}</p>
          <p className="count">{c.count} of {c.target} stars{c.done ? ' · done!' : ''}</p>
          <p className="muted">Started {c.started}</p>
        </>
      ) : <p className="muted">No chart yet.</p>}
      <details>
        <summary>New goal or target</summary>
        <form method="post" action="/admin">
          <input type="hidden" name="op" value="chart" />
          <input type="hidden" name="kid" value={kid.id} />
          <label>Goal <input type="text" name="goal" defaultValue={c ? c.goal : ''} maxLength={d.maxGoal} required /></label>
          <label>Stars to reach it <input type="number" name="target" defaultValue={c ? c.target : d.target} min={1} max={d.maxTarget} required /></label>
          <p className="muted">Starts a new chart at 0 stars. The current chart and its stars stay in the history below.</p>
          <button>Start new chart</button>
        </form>
      </details>
      <details>
        <summary>Name and colour</summary>
        <form method="post" action="/admin">
          <input type="hidden" name="op" value="edit" />
          <input type="hidden" name="kid" value={kid.id} />
          <label>Name <input type="text" name="name" defaultValue={kid.name} maxLength={d.maxName} required /></label>
          <label>Colour <input type="color" name="color" defaultValue={kid.color} /></label>
          <button>Save</button>
        </form>
      </details>
      <details>
        <summary>Earlier charts</summary>
        {kid.history.length ? (
          <table>
            <thead><tr><th>Goal</th><th>Stars</th><th>Started</th><th /></tr></thead>
            <tbody>
              {kid.history.map((h, i) => (
                <tr key={i}><td>{h.goal}</td><td>{h.count}/{h.target}</td><td>{h.started}</td><td>{h.status}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No earlier charts.</p>}
      </details>
      <details>
        <summary>Hide from the frames</summary>
        <form method="post" action="/admin">
          <input type="hidden" name="op" value="hide" />
          <input type="hidden" name="kid" value={kid.id} />
          <p className="muted">Takes {kid.name} off every frame. Their charts are kept, and you can bring them back below.</p>
          <button className="quiet">Hide {kid.name}</button>
        </form>
      </details>
    </section>
  )
}
