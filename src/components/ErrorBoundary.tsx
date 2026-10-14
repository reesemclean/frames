// Render-error isolation. The frames run unattended for weeks and keep their
// old bundle until the daily reload, so a widget that throws on new data (an
// API shape change after a deploy, an odd value) must not take the page down:
// it shows an empty card and tries again a minute later.
import { Component, type ReactNode } from 'react'

const RETRY_MS = 60_000

interface Props { name: string; fallback: ReactNode; children: ReactNode }

export class Boundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }
  private retry: ReturnType<typeof setTimeout> | null = null

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: unknown) {
    console.error('[frames] ' + this.props.name + ' failed to render', error)
    if (this.retry) clearTimeout(this.retry)
    // Retry: the next poll may well have brought data it can render.
    this.retry = setTimeout(() => { this.retry = null; this.setState({ failed: false }) }, RETRY_MS)
  }

  componentWillUnmount() { if (this.retry) clearTimeout(this.retry) }

  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

/** One widget: on a render error, an empty card with a quiet note. */
export function WidgetBoundary({ name, children }: { name: string; children: ReactNode }) {
  const fallback = (
    <div className="card" style={{ height: '100%' }}>
      <span style={{ color: 'var(--ink-2)', fontSize: 14 }}>{name} unavailable</span>
    </div>
  )
  return <Boundary name={name} fallback={fallback}>{children}</Boundary>
}
