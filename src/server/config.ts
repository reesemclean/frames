// Settings, all from the environment. Defaults suit `npm run dev` on a laptop.
import path from 'node:path'

const env = process.env
const root = process.cwd()

function dir(name: string, fallback: string): string {
  return path.resolve(env[name] || fallback)
}

export const settings = {
  tz: env.FRAMES_TZ || 'America/Phoenix',
  latitude: Number(env.FRAMES_LATITUDE || '33.45'),
  longitude: Number(env.FRAMES_LONGITUDE || '-112.07'),

  dashboardsDir: dir('FRAMES_DASHBOARDS_DIR', path.join(root, 'dashboards')),
  // SQLite lives here: stars, kids/goals, the photo index.
  dataDir: dir('FRAMES_DATA_DIR', path.join(root, '.local', 'data')),
  // Resized photos, backdrops, last-good source snapshots. Regenerable.
  cacheDir: dir('FRAMES_CACHE_DIR', path.join(root, '.local', 'cache')),

  // Photos: an iCloud Shared Album token (the part after `#` in its link)
  // and/or a folder. Either may be empty.
  sharedAlbumToken: env.FRAMES_SHARED_ALBUM_TOKEN || '',
  photosDir: env.FRAMES_PHOTOS_DIR || '',

  // Calendar over iCloud CalDAV. CALENDAR_NAMES is comma-separated display
  // names; empty means every event calendar on the account.
  caldavUrl: env.CALDAV_URL || 'https://caldav.icloud.com',
  icloudUsername: env.ICLOUD_USERNAME || '',
  icloudAppPassword: env.ICLOUD_APP_PASSWORD || '',
  calendarNames: (env.CALENDAR_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean),

  // JSON list of {id?, name, color?, goal, target?}; read only while the kids
  // table is empty (see server/stars.ts).
  starsSeed: env.FRAMES_STARS_SEED || '',
}

export type Settings = typeof settings
