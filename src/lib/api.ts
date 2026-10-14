// Every read goes through usePoll(): TanStack Query with endless retries and
// backoff, and the last good data kept when a refresh fails. Never a
// permanent error after one failure.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Envelope } from './types'
import * as time from './time'
import { useMinute } from './clock'

export interface PollState<T> {
  data: T | null
  updated: number | null
  stale: boolean
  error: string | null
  /** This frame couldn't reach the server on its latest attempt. */
  offline: boolean
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<Envelope<T>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  signal?.addEventListener('abort', () => ctrl.abort())
  try {
    const r = await fetch(path, { cache: 'no-store', signal: ctrl.signal })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return (await r.json()) as Envelope<T>
  } finally {
    clearTimeout(t)
  }
}

/**
 * Is what this frame shows out of date? The server's own `stale` covers its
 * upstreams; `fetchedAt` (this frame's last successful poll) covers the frame
 * not hearing from the server at all, whatever the reason. Three missed polls
 * is out of date. The server's `updated` can't be used for that: some sources
 * refresh upstream less often than the frame polls.
 */
export function isStale(env: { stale: boolean } | undefined, fetchedAt: number, everyMs: number, offline: boolean, now: number): boolean {
  return !env || env.stale || offline || now - fetchedAt > 3 * everyMs
}

/** Poll an /api/<source> envelope every `everyMs`. One query per path, shared. */
export function usePoll<T>(path: string, everyMs: number): PollState<T> {
  // Re-render each minute so the age check below moves even when no poll lands.
  useMinute()
  const q = useQuery({
    // Keep polling through the browser's 'offline' events. In the default
    // 'online' mode they pause every query silently (no failure, no stale
    // mark); each attempt is already bounded by getJSON's timeout.
    networkMode: 'always',
    queryKey: [path],
    queryFn: ({ signal }) => getJSON<T>(path, signal),
    refetchInterval: everyMs,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    retry: Infinity,
    retryDelay: (n) => Math.min(2000 * 2 ** n, 60_000),
    staleTime: everyMs / 2,
    // The envelope's own data survives a failed refetch (react-query keeps it).
    placeholderData: (prev) => prev,
  })
  const env = q.data
  const offline = q.failureCount > 0 || (q.isError && !env)
  return {
    data: env?.data ?? null,
    updated: env?.updated ?? null,
    stale: isStale(env, q.dataUpdatedAt, everyMs, offline, Date.now()),
    error: env?.error ?? null,
    offline,
  }
}

/** Refetch a polled path now (after a write). */
export function useRefresh(): (path: string) => void {
  const qc = useQueryClient()
  return (path) => { void qc.invalidateQueries({ queryKey: [path] }) }
}

export class SendError extends Error {
  /** HTTP status, or undefined for a network failure. 409 = refused (already done, too late). */
  status?: number
}

/** A write: one attempt (no silent retries of a star award). Throws SendError. */
export async function send<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const r = await fetch(path, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await r.json().catch(() => null)
    if (!r.ok) {
      const err = new SendError((json && json.error) || 'HTTP ' + r.status)
      err.status = r.status
      throw err
    }
    return json as T
  } catch (e) {
    if (e instanceof SendError) throw e
    throw new SendError(String((e as Error)?.message || e))
  } finally {
    clearTimeout(t)
  }
}

/** '' when fresh; 'updated 12 min ago' when stale or offline. */
export function staleNote(s: PollState<unknown>): string {
  if (!s.stale && !s.offline) return ''
  if (!s.updated) return 'waiting for data…'
  return 'updated ' + time.ago(s.updated)
}
