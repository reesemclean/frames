import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { listDashboards } from '~/server/dashboards'

const getDashboards = createServerFn({ method: 'GET' }).handler(() => listDashboards())

export const Route = createFileRoute('/')({
  loader: () => getDashboards(),
  headers: () => ({ 'Cache-Control': 'no-cache' }),
  component: Index,
})

function Index() {
  const slugs = Route.useLoaderData()
  return (
    <div className="index-page"><div className="index-inner">
      <h1>Dashboards</h1>
      {slugs.length ? (
        <ul className="dash-list">
          {slugs.map((s) => (
            <li key={s}>
              <a href={'/' + s} className="dash-card">
                {/* A live, scaled-down copy of the dashboard, held in day mode. */}
                <span className="dash-thumb">
                  <iframe src={'/' + s + '?mode=day'} title={s} loading="lazy" tabIndex={-1} aria-hidden="true" />
                </span>
                <span className="dash-name">{s}<small>/{s}</small></span>
              </a>
            </li>
          ))}
        </ul>
      ) : <p>No dashboards yet. Add a file to the dashboards folder.</p>}
      <a href="/admin" className="index-admin">Star charts admin<span>Kids, goals and star counts</span></a>
    </div></div>
  )
}
