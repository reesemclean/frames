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
      .sort()
  } catch {
    return []
  }
}

function merge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base }
  for (const k of Object.keys(over)) {
    const b = (base as any)[k]
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, over[k]) : over[k]
  }
  return out
}

// "a-b" → "aB" (how data-* attributes become option names, like dataset)
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

function convert(nodes: Node[]): DNode[] {
  const out: DNode[] = []
  for (const n of nodes) {
    if (n.nodeType === NodeType.TEXT_NODE) {
      const v = n.rawText
      if (v.trim()) out.push({ t: 'text', v: n.text })
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
    out.push({ t: 'el', tag, attrs, children: convert(el.childNodes) })
  }
  return out
}

export function parseDashboard(slug: string, html: string): Dashboard {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true } })
  let options = DEFAULT_OPTIONS
  const optEl = root.querySelector('script#dashboard-options')
  if (optEl) {
    try {
      options = merge(DEFAULT_OPTIONS, JSON.parse(optEl.rawText))
    } catch (e) {
      console.error(`[dashboards] ${slug}: bad dashboard-options JSON`, e)
    }
  }
  const css = root.querySelectorAll('style').map((s) => s.rawText).join('\n')
  return { slug, tz: settings.tz, options, css, tree: convert(root.childNodes) }
}

export function loadDashboard(slug: string): Dashboard | null {
  if (!SLUG.test(slug) || !listDashboards().includes(slug)) return null
  return parseDashboard(slug, fs.readFileSync(path.join(settings.dashboardsDir, slug + '.html'), 'utf8'))
}
