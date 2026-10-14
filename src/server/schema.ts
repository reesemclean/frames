// Drizzle table definitions matching MIGRATIONS in ./db (the SQL is the
// source of truth; keep these in step with it).
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const kids = sqliteTable('kids', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#3b82f6'),
  sort: integer('sort').notNull().default(0),
  active: integer('active').notNull().default(1),
})

export const charts = sqliteTable('charts', {
  id: integer('id').primaryKey(),
  kidId: text('kid_id').notNull(),
  goal: text('goal').notNull(),
  target: integer('target').notNull().default(5),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  closedAt: integer('closed_at'),
})

export const awards = sqliteTable('awards', {
  id: text('id').primaryKey(),
  chartId: integer('chart_id').notNull(),
  at: integer('at').notNull(),
  undoneAt: integer('undone_at'),
})

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  sourceKey: text('source_key').notNull(),
  checksum: text('checksum').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  takenAt: integer('taken_at'),
  contributor: text('contributor'),
  file: text('file').notNull(),
  backdrop: text('backdrop'),
  addedAt: integer('added_at').notNull(),
  missingSince: integer('missing_since'),
})
