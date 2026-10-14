// A dashboard is a file: dashboards/<slug>.html holds an options JSON block,
// a <style> for its layout, and markup with data-widget elements. It is
// parsed here into a plain tree that React renders on the server and
// hydrates on the frame. Dashboard files are trusted (they live in git).
import fs from 'node:fs'
import path from 'node:path'
import { parse, type HTMLElement, type Node, NodeType } from 'node-html-parser'
import { settings } from './config'
import type { DashboardOptions } from '~/lib/types'

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

// The app's own top-level paths. The router matches these before /$slug, so
// a dashboards/admin.html would be listed on / but never served.
export const RESERVED_SLUGS = new Set(['admin', 'api', 'photos', 'healthz', 'assets'])
const warnedReserved = new Set<string>()

export const DEFAULT_OPTIONS: DashboardOptions = {
  // Dim clock between these hours (zone-local, may wrap midnight).
  night: { from: '21:30', to: '06:00' },
  photos: {
    // Inside a window, photos take over the screen after idleSec without a
    // touch. days: 0 = Sunday. Outside every window the dashboard stays up.
    windows: [],
    idleSec: 120,
    layout: 'auto',
    intervalSec: 15,
  },
  // Reload once a day at this zone-local time, to clear slow leaks.
  reloadAt: '03:00',
}

/** A dashboard's markup, minus scripts and styles. */
export type DNode =
  | { t: 'text'; v: string }
  | { t: 'el'; tag: string; attrs: Record<string, string>; children: DNode[] }
  | { t: 'widget'; name: string; opts: Record<string, string>; attrs: Record<string, string> }

export interface Dashboard {
  slug: string
  tz: string
  options: DashboardOptions
  css: string
  tree: DNode[]
}

export function listDashboards(): string[] {
  try {
    return fs
      .readdirSync(settings.dashboardsDir)
      .filter((f) => f.endsWith('.html'))
      .map((f) => f.slice(0, -5))
      .filter((s) => SLUG.test(s))
      .filter((s) => {
        if (!RESERVED_SLUGS.has(s)) return true
        if (!warnedReserved.has(s)) {
          warnedReserved.add(s)
          console.warn(`[dashboards] ${s}.html ignored: /${s} is one of the app's own paths; rename the file`)
        }
        return false
      })
      .sort()
  } catch {
    return []
  }
}

// Each option checked on its own: a wrong type or value falls back to that
// option's default (with a warning) instead of reaching the frame, where a
// non-string "from" or a non-array "days" would crash rendering.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const LAYOUTS: DashboardOptions['photos']['layout'][] = ['auto', 'cover', 'pair', 'collage', 'polaroid']

function isHHMM(v: unknown): v is string {
  const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(v) : null
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60
}
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const isWindow = (v: unknown): v is DashboardOptions['photos']['windows'][number] =>
  isObj(v) && isHHMM(v.from) && isHHMM(v.to) && Array.isArray(v.days) &&
  v.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)

export function validateOptions(slug: string, raw: unknown): DashboardOptions {
  const warn = (what: string, v: unknown) =>
    console.warn(`[dashboards] ${slug}: ignoring ${what} ${JSON.stringify(v)}, using the default`)
  function pick<T>(what: string, v: unknown, ok: (v: unknown) => v is T, def: T): T {
    if (v === undefined) return def
    if (ok(v)) return v
    warn(what, v)
    return def
  }
  const section = (what: string, v: unknown) => pick(what, v, isObj, {})
  const D = DEFAULT_OPTIONS
  const o = section('options', raw)
  const night = section('night', o.night)
  const photos = section('photos', o.photos)
  let windows = D.photos.windows
  if (Array.isArray(photos.windows)) {
    windows = photos.windows.filter((w) => isWindow(w) || (warn('photos.windows entry', w), false))
  } else if (photos.windows !== undefined) warn('photos.windows', photos.windows)
  return {
    night: {
      from: pick('night.from', night.from, isHHMM, D.night.from),
      to: pick('night.to', night.to, isHHMM, D.night.to),
    },
    photos: {
      windows,
      idleSec: pick('photos.idleSec', photos.idleSec, isPositive, D.photos.idleSec),
      layout: pick('photos.layout', photos.layout,
        (v): v is DashboardOptions['photos']['layout'] => LAYOUTS.includes(v as never), D.photos.layout),
      intervalSec: pick('photos.intervalSec', photos.intervalSec, isPositive, D.photos.intervalSec),
    },
    reloadAt: pick('reloadAt', o.reloadAt, isHHMM, D.reloadAt),
  }
}

// "a-b" → "aB" (how data-* attributes become option names, like dataset)
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

// Elements whose content model has no text: a browser drops (or foster-parents)
// whitespace there, and React warns about text nodes inside them.
const NO_TEXT = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'ul', 'ol', 'select', 'optgroup'])

// A browser closes an open <a>/<button>/<form> when another starts inside it,
// so a nested one would never hydrate; it's rendered as its contents instead.
const NO_NEST = new Set(['a', 'button', 'form'])

// `parent` is the enclosing tag, or null at the top level of the file;
// `open` the NO_NEST tags among the ancestors.
function convert(nodes: Node[], parent: string | null = null, open: ReadonlySet<string> = new Set()): DNode[] {
  const out: DNode[] = []
  for (const n of nodes) {
    if (n.nodeType === NodeType.TEXT_NODE) {
      if (n.rawText.trim()) out.push({ t: 'text', v: n.text })
      // Whitespace between inline elements is a word gap (<b>Good</b> <i>morning</i>).
      // One space renders the same as any run of it outside <pre>.
      else if (parent && !NO_TEXT.has(parent)) out.push({ t: 'text', v: parent === 'pre' ? n.text : ' ' })
      continue
    }
    if (n.nodeType !== NodeType.ELEMENT_NODE) continue
    const el = n as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const attrs = { ...el.attributes }
    if (attrs['data-widget']) {
      const opts: Record<string, string> = {}
      const rest: Record<string, string> = {}
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'data-widget') continue
        if (k.startsWith('data-')) opts[camel(k.slice(5))] = v
        else rest[k] = v
      }
      out.push({ t: 'widget', name: attrs['data-widget'], opts, attrs: rest })
      continue
    }
    if (NO_NEST.has(tag) && open.has(tag)) {
      out.push(...convert(el.childNodes, parent, open))
      continue
    }
    const children = convert(el.childNodes, tag, NO_NEST.has(tag) ? new Set(open).add(tag) : open)
    out.push({ t: 'el', tag, attrs, children: tag === 'table' ? implyTableGroups(children) : children })
  }
  return out
}

// The browser's parser puts a <tr> written directly in <table> into an
// implied <tbody> (and a bare <col> into a <colgroup>). The server must render
// the same tree, or hydration fails and React re-renders the whole page.
function implyTableGroups(children: DNode[]): DNode[] {
  const out: DNode[] = []
  let group: Extract<DNode, { t: 'el' }> | null = null
  for (const c of children) {
    const wrap = c.t === 'el' && c.tag === 'tr' ? 'tbody' : c.t === 'el' && c.tag === 'col' ? 'colgroup' : null
    if (!wrap) {
      out.push(c)
      group = null
    } else if (group && group.tag === wrap) group.children.push(c)
    else out.push((group = { t: 'el', tag: wrap, attrs: {}, children: [c] }))
  }
  return out
}

export function parseDashboard(slug: string, html: string): Dashboard {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true } })
  let options = DEFAULT_OPTIONS
  const optEl = root.querySelector('script#dashboard-options')
  if (optEl) {
    try {
      options = validateOptions(slug, JSON.parse(optEl.rawText))
    } catch (e) {
      console.error(`[dashboards] ${slug}: bad dashboard-options JSON`, e)
    }
  }
  const css = root.querySelectorAll('style').map((s) => s.rawText).join('\n')
  return { slug, tz: settings.tz, options, css, tree: convert(root.childNodes) }
}

export function loadDashboard(slug: string): Dashboard | null {
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug) || !listDashboards().includes(slug)) return null
  return parseDashboard(slug, fs.readFileSync(path.join(settings.dashboardsDir, slug + '.html'), 'utf8'))
}
