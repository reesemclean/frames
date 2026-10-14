import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDashboard, listDashboards, loadDashboard, validateOptions, DEFAULT_OPTIONS } from '~/server/dashboards'
import { settings } from '~/server/config'
import { DashboardTree, styleObject } from '~/components/DashboardTree'

const html = (body: string) => renderToString(createElement(DashboardTree, { nodes: parseDashboard('x', body).tree }))

afterEach(() => { vi.restoreAllMocks() })

describe('parseDashboard', () => {
  it('reads options, styles and widgets', () => {
    const d = parseDashboard('x', `
      <!-- a comment -->
      <script type="application/json" id="dashboard-options">{"night": {"from": "20:00"}}</script>
      <style>.dash { display: grid }</style>
      <div class="dash"><section data-widget="weather" data-show="current,daily" data-max-days="3" style="grid-area: w"></section></div>`)
    expect(d.options.night).toEqual({ from: '20:00', to: DEFAULT_OPTIONS.night.to })
    expect(d.options.photos).toEqual(DEFAULT_OPTIONS.photos)
    expect(d.css).toContain('.dash')
    expect(d.tree).toEqual([{
      t: 'el', tag: 'div', attrs: { class: 'dash' },
      children: [{ t: 'widget', name: 'weather', opts: { show: 'current,daily', maxDays: '3' }, attrs: { style: 'grid-area: w' } }],
    }])
  })

  it('falls back to defaults on bad JSON', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = parseDashboard('x', '<script type="application/json" id="dashboard-options">{nope</script>')
    expect(d.options).toEqual(DEFAULT_OPTIONS)
  })

  it('keeps whitespace between inline elements as one space', () => {
    expect(html('<p><span>Good</span>\n  <b>morning</b></p>')).toBe('<p><span>Good</span> <b>morning</b></p>')
  })

  it('drops whitespace at the top level and where HTML allows no text', () => {
    const d = parseDashboard('x', '\n<ul>\n <li>a</li>\n</ul>\n<table> <tbody> <tr> <td>x</td> </tr> </tbody> </table>\n')
    expect(d.tree.map((n) => n.t)).toEqual(['el', 'el'])
    expect(html('<ul>\n <li>a</li>\n</ul>')).toBe('<ul><li>a</li></ul>')
    expect(html('<table> <tbody> <tr> <td>x</td> </tr> </tbody> </table>')).toBe('<table><tbody><tr><td>x</td></tr></tbody></table>')
  })

  it('wraps rows written straight in a table in the tbody the browser would add', () => {
    expect(html('<table><thead><tr><th>h</th></tr></thead><tr><td>1</td></tr><tr><td>2</td></tr><col></table>'))
      .toBe('<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody><colgroup><col/></colgroup></table>')
  })

  it('renders a link nested in a link as its contents, as the browser would not nest it', () => {
    expect(html('<p><a href="#x">a <a href="#y">y</a></a></p>')).toBe('<p><a href="#x">a <!-- -->y</a></p>')
  })
})

describe('validateOptions', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })

  it('keeps valid options', () => {
    const o = {
      night: { from: '22:00', to: '6:30' },
      photos: { windows: [{ days: [0, 6], from: '09:00', to: '16:00' }], idleSec: 60, layout: 'pair', intervalSec: 8 },
      reloadAt: '04:15',
    }
    expect(validateOptions('x', o)).toEqual(o)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('replaces each wrongly typed option with its default', () => {
    const o = validateOptions('x', {
      night: { from: 2130, to: '25:00' },
      photos: {
        windows: [
          { days: [0, 6], from: '09:00', to: '16:00' },
          { days: 'weekends', from: '09:00', to: '16:00' },
          { days: [7], from: '09:00', to: '10:00' },
          { days: [1], from: '9', to: '10:00' },
          null,
        ],
        idleSec: '120', layout: 'grid', intervalSec: -1,
      },
      reloadAt: null,
    })
    expect(o).toEqual({
      night: DEFAULT_OPTIONS.night,
      photos: { ...DEFAULT_OPTIONS.photos, windows: [{ days: [0, 6], from: '09:00', to: '16:00' }] },
      reloadAt: DEFAULT_OPTIONS.reloadAt,
    })
    expect(console.warn).toHaveBeenCalled()
  })

  it.each([[[]], ['x'], [{ night: 'late', photos: [1] }], [{ photos: { windows: {} } }]])('survives %j', (raw) => {
    expect(validateOptions('x', raw)).toEqual(DEFAULT_OPTIONS)
  })

  it('is what parseDashboard uses', () => {
    const d = parseDashboard('x', '<script type="application/json" id="dashboard-options">{"photos": {"idleSec": "soon"}}</script>')
    expect(d.options).toEqual(DEFAULT_OPTIONS)
  })
})

describe('reserved slugs', () => {
  let dir: string
  const saved = settings.dashboardsDir
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'))
    for (const s of ['kitchen', 'admin', 'photos', 'healthz', 'api', 'assets']) fs.writeFileSync(path.join(dir, s + '.html'), '<div></div>')
    settings.dashboardsDir = dir
  })
  afterEach(() => {
    settings.dashboardsDir = saved
    fs.rmSync(dir, { recursive: true })
  })

  it("never lists or serves the app's own paths, and warns once per name", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(listDashboards()).toEqual(['kitchen'])
    expect(warn).toHaveBeenCalledTimes(5)
    expect(loadDashboard('admin')).toBeNull()
    expect(loadDashboard('photos')).toBeNull()
    expect(loadDashboard('kitchen')?.slug).toBe('kitchen')
    listDashboards()
    expect(warn).toHaveBeenCalledTimes(5)
  })
})

describe('DashboardTree', () => {
  it('splits inline styles only outside quotes and parentheses', () => {
    expect(styleObject(`background:url("data:image/png;base64,iVBO=") center/cover; color: red; content: 'a;b'`)).toEqual({
      background: 'url("data:image/png;base64,iVBO=") center/cover',
      color: 'red',
      content: "'a;b'",
    })
  })

  it('renders boolean attributes as present', () => {
    expect(html('<div hidden>s</div><details open><summary>m</summary></details><video autoplay loop playsinline></video>'))
      .toBe('<div hidden="">s</div><details open=""><summary>m</summary></details><video autoPlay="" loop="" playsInline=""></video>')
  })

  it('treats form values as initial values', () => {
    expect(html('<input type="checkbox" checked disabled><input value="3" readonly>'))
      .toBe('<input type="checkbox" disabled="" checked=""/><input readOnly="" value="3"/>')
  })

  it('passes other attributes through to a widget section', () => {
    expect(html('<section data-widget="nope" class="a" hidden aria-label="x"></section>'))
      .toMatch(/^<section class="w w--nope a" hidden="" aria-label="x">/)
  })
})
