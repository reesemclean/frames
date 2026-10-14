import { useEffect } from 'react'
import { createFileRoute, notFound, type ErrorComponentProps } from '@tanstack/react-router'
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
  // Unattended frames: an error or missing dashboard (a bad push, a checkout
  // mid-update) retries itself, since the kiosk only retries network errors.
  // __root's SELF_HEAL does the same without React, in case this never runs.
  errorComponent: DashboardError,
  notFoundComponent: () => <RetryPage title="No such dashboard" />,
})

function DashboardError({ error }: ErrorComponentProps) {
  useEffect(() => { console.error('[frames] dashboard failed', error) }, [error])
  return <RetryPage title="This dashboard couldn't load" />
}

function RetryPage({ title }: { title: string }) {
  useEffect(() => {
    const t = setTimeout(() => location.reload(), 60_000)
    return () => clearTimeout(t)
  }, [])
  return <div className="index-page"><h1>{title}</h1><p>Trying again in a minute.</p><a href="/">All dashboards</a></div>
}

function DashboardPage() {
  const dash = Route.useLoaderData()
  return <Frame dash={dash} />
}
