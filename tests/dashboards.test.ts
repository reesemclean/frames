import { describe, expect, it } from 'vitest'
import { parseDashboard, DEFAULT_OPTIONS } from '~/server/dashboards'

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
    const d = parseDashboard('x', '<script type="application/json" id="dashboard-options">{nope</script>')
    expect(d.options).toEqual(DEFAULT_OPTIONS)
  })
})
