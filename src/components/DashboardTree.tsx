// Renders a parsed dashboard file: plain elements as written, data-widget
// elements as the widget components.
import { createElement, type CSSProperties, type ReactNode } from 'react'
import type { DNode } from '~/server/dashboards'
import { WIDGETS } from '~/widgets'

// "grid-area: a; --x: 1" → { gridArea: 'a', '--x': '1' }
export function styleObject(s: string | undefined): CSSProperties | undefined {
  if (!s) return undefined
  const out: Record<string, string> = {}
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const k = decl.slice(0, i).trim()
    const v = decl.slice(i + 1).trim()
    if (!k) continue
    out[k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  }
  return out as CSSProperties
}

function props(attrs: Record<string, string>, key: number): Record<string, unknown> {
  const p: Record<string, unknown> = { key }
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') p.className = v
    else if (k === 'style') p.style = styleObject(v)
    else if (k === 'for') p.htmlFor = v
    else p[k] = v
  }
  return p
}

export function DashboardTree({ nodes }: { nodes: DNode[] }): ReactNode {
  return nodes.map((n, i) => {
    if (n.t === 'text') return n.v
    if (n.t === 'widget') {
      const W = WIDGETS[n.name]
      const p = props(n.attrs, i)
      const className = ['w', 'w--' + n.name, p.className].filter(Boolean).join(' ')
      return (
        <section key={i} className={className} style={p.style as CSSProperties} id={p.id as string | undefined}>
          {W ? <W opts={n.opts} /> : <div className="w-missing">Unknown widget “{n.name}”</div>}
        </section>
      )
    }
    return createElement(n.tag, props(n.attrs, i), n.children.length ? <DashboardTree nodes={n.children} /> : undefined)
  })
}
