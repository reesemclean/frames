// SQLite: everything that changes through use (stars, kids and goals, the
// photo index). One file, WAL, one Node process. Schema changes are appended
// to MIGRATIONS, never edited in place; `user_version` counts how many ran.
// Queries go through drizzle with the table definitions in ./schema.
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { settings } from './config'
import * as schema from './schema'

export const MIGRATIONS: string[] = [
  // 1: stars and the photo index
  `
  CREATE TABLE kids (
    id TEXT PRIMARY KEY,                    -- slug, e.g. 'alex'
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3b82f6',  -- #rrggbb only (the frame rejects #rrggbbaa)
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  -- One row per round of a kid's chart. The current chart is the newest row
  -- for that kid with closed_at NULL.
  CREATE TABLE charts (
    id INTEGER PRIMARY KEY,
    kid_id TEXT NOT NULL REFERENCES kids(id),
    goal TEXT NOT NULL,
    target INTEGER NOT NULL DEFAULT 5,
    started_at INTEGER NOT NULL,            -- epoch ms
    completed_at INTEGER,                   -- set when awards reach target
    closed_at INTEGER                       -- set when the next chart starts
  );
  CREATE INDEX charts_kid ON charts(kid_id, closed_at);
  -- Undo marks one specific award, by id, so two frames can't double-undo.
  CREATE TABLE awards (
    id TEXT PRIMARY KEY,                    -- random hex
    chart_id INTEGER NOT NULL REFERENCES charts(id),
    at INTEGER NOT NULL,
    undone_at INTEGER
  );
  CREATE INDEX awards_chart ON awards(chart_id);
  CREATE TABLE photos (
    id TEXT PRIMARY KEY,                    -- stable: hash of source + source_key
    source TEXT NOT NULL,                   -- 'album' | 'folder'
    source_key TEXT NOT NULL,               -- album photoGuid, or folder path
    checksum TEXT NOT NULL,                 -- album derivative checksum, or mtime:size
    width INTEGER NOT NULL,                 -- of the resized file
    height INTEGER NOT NULL,
    taken_at INTEGER,                       -- epoch ms, when known
    contributor TEXT,
    file TEXT NOT NULL,                     -- relative to cacheDir/photos
    backdrop TEXT,                          -- pre-blurred fill for portrait photos, or NULL
    added_at INTEGER NOT NULL,
    missing_since INTEGER                   -- gone from its source; pruned later
  );
  `,
]

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database }

// On globalThis: Nitro bundles the startup plugin apart from the routes, so
// this module can be loaded twice; both copies must share one connection.
const g = globalThis as unknown as { __framesDb?: DB | null; __framesDbShut?: boolean }

export function db(): DB {
  let current = g.__framesDb
  if (!current) {
    // A refresh still running at shutdown must fail, not quietly reopen the
    // file the close hook just closed.
    if (g.__framesDbShut) throw new Error('database is shut down')
    fs.mkdirSync(settings.dataDir, { recursive: true })
    const sqlite = new Database(path.join(settings.dataDir, 'frames.db'))
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('busy_timeout = 5000')
    migrate(sqlite)
    current = g.__framesDb = drizzle(sqlite, { schema }) as DB
  }
  return current
}

function migrate(sqlite: Database.Database): void {
  const version = sqlite.pragma('user_version', { simple: true }) as number
  MIGRATIONS.slice(version).forEach((sql, i) => {
    sqlite.transaction(() => {
      sqlite.exec(sql)
      sqlite.pragma(`user_version = ${version + i + 1}`)
    })()
  })
}

/** BEGIN IMMEDIATE ... COMMIT, so read-modify-write is atomic. */
export function tx<T>(fn: (d: DB) => T): T {
  const d = db()
  return d.$client.transaction(() => fn(d)).immediate()
}

/** Close the connection for good (process shutdown); db() throws after this. */
export function closeDb(): void {
  g.__framesDbShut = true
  g.__framesDb?.$client.close()
  g.__framesDb = null
}

/** Close the connection; the next db() opens settings.dataDir afresh. */
export function closeForTests(): void {
  g.__framesDbShut = false
  g.__framesDb?.$client.close()
  g.__framesDb = null
}
