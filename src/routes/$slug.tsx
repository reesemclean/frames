import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { loadDashboard } from '~/server/dashboards'
import { ensureStarted } from '~/server/startup'
import { Frame } from '~/components/Frame'

const getDashboard = createServerFn({ method: 'GET' })
  .validator((slug: string) => String(slug))
  .handler(({ data: slug }) => {
    ensureStarted()
    const d = loadDashboard(slug)
    if (!d) throw notFound()
    return d
  })

export const Route = createFileRoute('/$slug')({
  loader: ({ params }) => getDashboard({ data: params.slug }),
  // The frame can't clear its cache: the page is always revalidated, and the
  // hashed JS/CSS it names change on every deploy.
  headers: () => ({ 'Cache-Control': 'no-cache' }),
  component: DashboardPage,
  notFoundComponent: () => <div className="index-page"><h1>No such dashboard</h1><a href="/">All dashboards</a></div>,
})

function DashboardPage() {
  const dash = Route.useLoaderData()
  return <Frame dash={dash} />
}
