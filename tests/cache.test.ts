// The Source lifecycle at shutdown, and the database refusing to reopen.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Source } from '~/server/cache'
import { settings } from '~/server/config'
import { closeDb, closeForTests, db } from '~/server/db'

let tmp: string
const saved = { ...settings }
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-cache-test-'))
  settings.dataDir = path.join(tmp, 'data')
  settings.cacheDir = path.join(tmp, 'cache')
  closeForTests()
})
afterEach(() => {
  closeForTests()
  Object.assign(settings, saved)
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A fetch that runs until its signal aborts. */
function hanging(seen: AbortSignal[]) {
  return (signal: AbortSignal) => {
    seen.push(signal)
    return new Promise<number>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  }
}

describe('Source shutdown', () => {
  it('stop() aborts the in-flight refresh, which settle() waits for', async () => {
    const seen: AbortSignal[] = []
    const src = new Source('t', hanging(seen), 60_000)
    src.start()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].aborted).toBe(false)
    src.stop()
    expect(seen[0].aborted).toBe(true)
    await src.settle(1_000)
    // Shutdown isn't a failure to report.
    expect(src.error).toBeNull()
  })

  it('settle() gives up after its timeout on a fetch that ignores the signal', async () => {
    const src = new Source('t', () => new Promise<number>(() => {}), 60_000)
    void src.refresh()
    src.stop()
    const t = Date.now()
    await src.settle(50)
    expect(Date.now() - t).toBeLessThan(1_000)
  })

  it('a restarted source gets a fresh signal', async () => {
    const seen: AbortSignal[] = []
    const src = new Source('t', hanging(seen), 60_000)
    src.start()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    src.stop()
    await src.settle(1_000)
    src.start()
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1].aborted).toBe(false)
    src.stop()
  })

  it('a real failure is still reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = new Source('t', async () => { throw new Error('boom') }, 60_000)
    expect(await src.refresh()).toBe(false)
    expect(src.error).toMatch(/boom/)
    expect(warn).toHaveBeenCalled()
  })
})

describe('database shutdown', () => {
  it('closeDb() is final; closeForTests() is not', () => {
    db()
    closeForTests()
    expect(() => db()).not.toThrow()
    closeDb()
    // A refresh still running at shutdown must not reopen the file.
    expect(() => db()).toThrow(/shut down/)
    expect(fs.existsSync(path.join(settings.dataDir, 'frames.db'))).toBe(true)
    closeForTests()
    expect(() => db()).not.toThrow()
  })
})
