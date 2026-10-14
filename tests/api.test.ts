// Client-side staleness (lib/api.ts): data is marked out of date when this
// frame stops hearing from the server, even if the last envelope said fresh.
import { describe, expect, it } from 'vitest'
import { isStale } from '~/lib/api'

const fresh = { stale: false }
const T = 1_800_000_000_000

describe('isStale', () => {
  it('is fresh within three poll intervals of the last good fetch', () => {
    expect(isStale(fresh, T, 20_000, false, T + 59_000)).toBe(false)
  })
  it('is stale after three missed polls, though the envelope said fresh', () => {
    expect(isStale(fresh, T, 20_000, false, T + 61_000)).toBe(true)
    expect(isStale(fresh, T, 5 * 60_000, false, T + 16 * 60_000)).toBe(true)
  })
  it('follows the server, a failed attempt, or no data yet', () => {
    expect(isStale({ stale: true }, T, 20_000, false, T)).toBe(true)
    expect(isStale(fresh, T, 20_000, true, T)).toBe(true)
    expect(isStale(undefined, 0, 20_000, false, T)).toBe(true)
  })
})
