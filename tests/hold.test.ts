// useHold's page-wide pointer tracking (components/ui.tsx): a hold arms and
// completes only while its pointer is the only one down anywhere, so two
// fingers on two kids' panels award nothing.
import { beforeEach, describe, expect, it } from 'vitest'
import { onlyPointer, pointerDown, pointerUp } from '~/components/ui'

beforeEach(() => { pointerDown(0, true); pointerUp(0) })

describe('pointer tracking', () => {
  it('one finger may hold', () => {
    expect(pointerDown(1, true)).toBe(true)
    expect(onlyPointer(1)).toBe(true)
    pointerUp(1)
    expect(onlyPointer(1)).toBe(false)
  })
  it('a second finger anywhere blocks both, until both lift', () => {
    pointerDown(1, true)
    expect(pointerDown(2, false)).toBe(false)
    expect(onlyPointer(1)).toBe(false)
    expect(onlyPointer(2)).toBe(false)
    // The cancelled hold stays cancelled; a fresh press arms again.
    pointerUp(2)
    expect(onlyPointer(1)).toBe(true)
  })
  it('a lost pointerup heals on the next primary contact', () => {
    pointerDown(5, true) // its pointerup never arrives
    expect(pointerDown(6, true)).toBe(true)
    expect(onlyPointer(6)).toBe(true)
  })
})
