// The shared cache: every source is fetched on a schedule, never per request.
//
// A Source keeps its last good value. A failed refresh keeps serving that
// value, marked stale, and retries with backoff; it never replaces good data
// with an error. Registered sources also keep their last good value on disk,
// so a restart during an outage still has something to show. Every frame
// reads the same cached value, so three frames cost iCloud or Open-Meteo
// exactly as much as one.
import fs from 'node:fs'
import path from 'node:path'
import { settings } from './config'
import type { Envelope } from '~/lib/types'

const RETRY_MIN = 5_000
const RETRY_MAX = 300_000

export class Source<T> {
  data: T | null = null
  updated: number | null = null // epoch ms of the last success
  error: string | null = null
  file: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private again = false
  private stopped = true
  // Aborted by stop(), so an in-flight refresh (a photo backlog, say) winds
  // down at shutdown instead of working on until Docker's SIGKILL.
  private abort = new AbortController()
  private inflight: Promise<boolean> | null = null

  constructor(
    readonly name: string,
    readonly fetch: (signal: AbortSignal) => Promise<T>,
    readonly intervalMs: number,
  ) {}

  /** What every /api/<source> endpoint returns. `stale` once the last
   * success is older than two intervals, or the latest attempt failed. */
  envelope(): Envelope<T> {
    const age = this.updated == null ? Infinity : Date.now() - this.updated
    return {
      data: this.data,
      updated: this.updated,
      stale: this.updated == null || this.error != null || age > 2 * this.intervalMs,
      error: this.error,
    }
  }

  load(file: string): void {
    this.file = file
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.data = saved.data
      this.updated = saved.updated
    } catch (e: any) {
      if (e?.code !== 'ENOENT') console.warn(`[cache] ${this.name}: ignoring unreadable ${file}`)
    }
  }

  private save(): void {
    if (!this.file || this.data == null) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ data: this.data, updated: this.updated }))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.warn(`[cache] ${this.name}: couldn't save snapshot`, e)
    }
  }

  refresh(): Promise<boolean> {
    const run = this.attempt(this.abort.signal)
    this.inflight = run
    void run.finally(() => { if (this.inflight === run) this.inflight = null })
    return run
  }

  private async attempt(signal: AbortSignal): Promise<boolean> {
    try {
      this.data = await this.fetch(signal)
      this.updated = Date.now()
      this.error = null
      this.save()
      return true
    } catch (e: any) {
      if (signal.aborted) return false // shutting down, not a failure worth reporting
      this.error = `${e?.name || 'Error'}: ${e?.message || e}`.slice(0, 300)
      console.warn(`[cache] source ${this.name} failed: ${this.error}`)
      return false
    }
  }

  /** Skip the rest of the current wait (e.g. a backlog to work through). */
  refreshSoon(): void {
    if (this.stopped) return
    if (this.running) { this.again = true; return }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.loop(), 0)
    this.timer.unref?.()
  }

  private backoff = RETRY_MIN
  private async loop(): Promise<void> {
    if (this.stopped) return
    this.timer = null
    this.running = true
    this.again = false
    const ok = await this.refresh()
    this.running = false
    if (this.stopped) return
    let wait: number
    if (ok) { this.backoff = RETRY_MIN; wait = this.intervalMs }
    else { wait = this.backoff; this.backoff = Math.min(this.backoff * 2, RETRY_MAX) }
    if (this.again) wait = 0
    this.timer = setTimeout(() => this.loop(), wait)
    // Never what keeps the process alive: the HTTP server does that, and a
    // pending refresh mustn't turn SIGTERM into a 10 s wait and a SIGKILL.
    this.timer.unref?.()
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    if (this.abort.signal.aborted) this.abort = new AbortController()
    this.timer = setTimeout(() => this.loop(), 0)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abort.abort()
  }

  /** Resolves once no refresh is running, or after `ms`, whichever is first. */
  async settle(ms: number): Promise<void> {
    if (!this.inflight) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.inflight,
      // Not unref'd: the close hook awaits this, and closeDb() must still run.
      new Promise<void>((r) => { timer = setTimeout(r, ms) }),
    ])
    clearTimeout(timer)
  }
}

class Registry {
  sources = new Map<string, Source<any>>()

  add<T>(source: Source<T>): Source<T> {
    const existing = this.sources.get(source.name)
    if (existing) return existing as Source<T>
    source.load(path.join(settings.cacheDir, 'sources', `${source.name}.json`))
    this.sources.set(source.name, source)
    return source
  }

  get<T>(name: string): Source<T> | undefined {
    return this.sources.get(name) as Source<T> | undefined
  }

  start(): void { for (const s of this.sources.values()) s.start() }
  stop(): void { for (const s of this.sources.values()) s.stop() }
  /** After stop(): give in-flight refreshes up to `ms` to wind down. */
  async settle(ms: number): Promise<void> {
    await Promise.all([...this.sources.values()].map((s) => s.settle(ms)))
  }
}

// One registry per process, kept on globalThis so dev-server module reloads
// don't start a second set of refresh loops.
const g = globalThis as unknown as { __framesRegistry?: Registry }
export const registry = (g.__framesRegistry ??= new Registry())
