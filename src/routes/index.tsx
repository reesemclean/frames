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
    <div className="index-page">
      <h1>Dashboards</h1>
      <ul>
        {slugs.length ? slugs.map((s) => (
          <li key={s}><a href={'/' + s}>{s}</a></li>
        )) : <li>none yet</li>}
      </ul>
      <p><a href="/admin">Stars admin</a></p>
    </div>
  )
}
