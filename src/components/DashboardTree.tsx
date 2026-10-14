// Renders a parsed dashboard file: plain elements as written, data-widget
// elements as the widget components.
import { createElement, type CSSProperties, type ReactNode } from 'react'
import type { DNode } from '~/server/dashboards'
import { WIDGETS } from '~/widgets'
import { WidgetBoundary } from '~/components/ErrorBoundary'

// Split on c at depth 0 only: not inside quotes or parentheses, so
// url("data:image/png;base64,…") stays one value.
function splitTop(s: string, c: string): string[] {
  const out: string[] = []
  let depth = 0, quote = '', start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === c && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

// "grid-area: a; --x: 1" → { gridArea: 'a', '--x': '1' }
export function styleObject(s: string | undefined): CSSProperties | undefined {
  if (!s) return undefined
  const out: Record<string, string> = {}
  for (const decl of splitTop(s, ';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const k = decl.slice(0, i).trim()
    const v = decl.slice(i + 1).trim()
    if (!k) continue
    out[k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  }
  return out as CSSProperties
}

// HTML boolean attributes arrive as "" (present) — which React reads as false —
// keyed by React's prop name where it differs from the HTML one.
const BOOLEAN: Record<string, string> = {
  allowfullscreen: 'allowFullScreen', async: 'async', autofocus: 'autoFocus', autoplay: 'autoPlay',
  checked: 'checked', controls: 'controls', default: 'default', defer: 'defer', disabled: 'disabled',
  formnovalidate: 'formNoValidate', hidden: 'hidden', inert: 'inert', itemscope: 'itemScope', loop: 'loop',
  multiple: 'multiple', muted: 'muted', nomodule: 'noModule', novalidate: 'noValidate', open: 'open',
  playsinline: 'playsInline', readonly: 'readOnly', required: 'required', reversed: 'reversed', selected: 'selected',
}
// Other attributes whose React name isn't the HTML name.
const RENAME: Record<string, string> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', colspan: 'colSpan', rowspan: 'rowSpan',
  maxlength: 'maxLength', minlength: 'minLength', crossorigin: 'crossOrigin', srcset: 'srcSet',
  contenteditable: 'contentEditable', accesskey: 'accessKey', enterkeyhint: 'enterKeyHint',
  inputmode: 'inputMode', referrerpolicy: 'referrerPolicy', datetime: 'dateTime', 'http-equiv': 'httpEquiv',
}
// Form fields: the file's value is the initial one; React would make
// value/checked controlled (read-only, with a warning).
const FORM_FIELD = new Set(['input', 'textarea', 'select'])

function props(tag: string, attrs: Record<string, string>, key: number): Record<string, unknown> {
  const p: Record<string, unknown> = { key }
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') p.style = styleObject(v)
    else if (FORM_FIELD.has(tag) && k === 'checked') p.defaultChecked = true
    else if (FORM_FIELD.has(tag) && k === 'value') p.defaultValue = v
    else if (k in BOOLEAN) p[BOOLEAN[k]] = true
    else p[RENAME[k] ?? k] = v
  }
  return p
}

export function DashboardTree({ nodes }: { nodes: DNode[] }): ReactNode {
  return nodes.map((n, i) => {
    if (n.t === 'text') return n.v
    if (n.t === 'widget') {
      const W = WIDGETS[n.name]
      const { key, ...p } = props('section', n.attrs, i)
      const className = ['w', 'w--' + n.name, p.className].filter(Boolean).join(' ')
      // One widget throwing must not take the rest of the dashboard down.
      return (
        <section key={key as number} {...p} className={className}>
          <WidgetBoundary name={n.name}>
            {W ? <W opts={n.opts} /> : <div className="w-missing">Unknown widget “{n.name}”</div>}
          </WidgetBoundary>
        </section>
      )
    }
    return createElement(n.tag, props(n.tag, n.attrs, i), n.children.length ? <DashboardTree nodes={n.children} /> : undefined)
  })
}
