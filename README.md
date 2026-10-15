# frames

Family wall dashboards for the PF1007L photo frames. One service serves every
dashboard at `/<slug>`, fetches all the data (weather, iCloud calendar, a
shared photo album, the kids' star charts) on a schedule, and hands the
frames plain JSON from its own `/api/...`. Each frame's kiosk app opens one
URL full screen and runs for weeks without anyone touching it.

It's a [TanStack Start](https://tanstack.com/start) app (React 19, TanStack
Router and Query) built by Vite and served by Nitro as a single Node process,
with SQLite through drizzle + better-sqlite3. Pages render on the server and
hydrate on the frame.

## Dashboards

A dashboard is one file in the dashboards folder: `dashboards/kitchen.html`
is served at `/kitchen`. Adding one needs no code change. `/` lists them; an
unknown slug is a 404. Slugs are lowercase letters, digits and `-`.

The file is an HTML fragment with three parts: options JSON, a layout, and
widgets ([`dashboards/example.html`](dashboards/example.html) is a complete
one).

```html
<script type="application/json" id="dashboard-options">
{
  "night":  { "from": "21:30", "to": "06:00" },
  "photos": {
    "idleSec": 120, "dashboardEverySec": 600, "dashboardForSec": 60,
    "layout": "auto", "intervalSec": 15
  },
  "reloadAt": "03:00"
}
</script>
<style>
  .dash { height: 100%; display: grid; gap: 16px;
          grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 220px 1fr 1fr;
          grid-template-areas: "clock weather weather" "cal photos photos" "cal stars stars"; }
</style>
<div class="dash">
  <section data-widget="clock"    style="grid-area: clock"></section>
  <section data-widget="weather"  style="grid-area: weather" data-show="current,hourly"></section>
  <section data-widget="calendar" style="grid-area: cal" data-days="1"></section>
  <section data-widget="photos"   style="grid-area: photos"></section>
  <section data-widget="stars"    style="grid-area: stars"></section>
</div>
```

- **Options** (all optional; these are the defaults):
  - `night.from` / `night.to`: night hours, `HH:MM`, may wrap midnight.
  - `photos.dashboardEverySec` / `photos.dashboardForSec`: the slideshow
    stops on the dashboard every so often, for this long.
  - `photos.idleSec`: after a tap, seconds without another before the
    slideshow comes back.
  - `photos.layout`, `photos.intervalSec`: the full-screen slideshow (values
    as for the photos widget below; no captions, since the clock and weather
    strip own the bottom of the screen).
  - `reloadAt`: the daily page reload that clears slow leaks.
- **Layout** is plain CSS. The page is a fixed 1280×800 stage; a widget fills
  whatever cell it's placed in, so a grid with `height: 100%` is the usual
  shape. Nothing scrolls.
- **Widgets** are any element with `data-widget`. Every other `data-*`
  attribute is an option for it (camelCased, as `dataset` does). The same
  widget can appear more than once with different options. Scripts in the
  file are ignored; dashboard files are trusted (they live in git).

| Widget | Options |
| --- | --- |
| `clock` | `data-seconds="true"` shows seconds. `data-size="auto\|s\|m\|l"`, default `auto` (scales to the cell). |
| `weather` | `data-show`: comma list of `current`, `hourly`, `daily`. |
| `calendar` | `data-days`: how many days from today (1 = today only, up to 7). `data-title`: heading text. |
| `photos` | `data-layout="auto\|cover\|pair\|collage\|polaroid"`. `data-interval`: seconds per photo. `data-captions="false"` hides the date captions. Tap the left or right third for the previous or next photo; hold 2 s for the full-screen slideshow. |
| `stars` | none. Shows every active kid's current chart; a parent gives a star on the frame (a quick tap doesn't), with undo right after. At the target the chart shows done until a parent starts the next one. Kids and goals are managed at `/admin`. |

Every time shown and every schedule decision uses the household's zone
(`FRAMES_TZ`), not the frame's own clock zone (the frames run
America/New_York). The server sends zone-local date keys and minutes since
midnight, never instants, and renders in the same zone.

## Modes

| Mode | When |
| --- | --- |
| `photos` | full-screen slideshow, the home screen outside night hours; a tap shows `day` |
| `day` | the dashboard: after a tap until `idleSec` without one, and for `dashboardForSec` every `dashboardEverySec`. Also whenever there are no photos yet. |
| `night` | black screen with a dim clock, during night hours when idle; the slideshow at the end of them |
| `nightdash` | a tap at night shows the dashboard dimmed; back to `night` after 20 s idle |

Previews on a computer: `?at=22:15` pins the clock to that time (zone-local),
and `?mode=day|photos|night|nightdash` forces a mode until the next touch
(`?mode=day` is the one to use while editing a layout).
On a keyboard, `p` / `n` / `d` switch to photos / night / day. The page scales
the 1280×800 stage to fit a desktop window.

## Configuration

All from the environment (see [`src/server/config.ts`](src/server/config.ts)).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `FRAMES_TZ` | `America/Phoenix` | the household's zone |
| `FRAMES_LATITUDE`, `FRAMES_LONGITUDE` | Phoenix | weather location (Open-Meteo, no key) |
| `ICLOUD_USERNAME`, `ICLOUD_APP_PASSWORD` | | iCloud CalDAV; use an app-specific password |
| `CALENDAR_NAMES` | all calendars | comma-separated calendar display names |
| `CALDAV_URL` | `https://caldav.icloud.com` | |
| `FRAMES_SHARED_ALBUM_TOKEN` | | iCloud Shared Album: the part after `#` in its public link |
| `FRAMES_PHOTOS_DIR` | | a folder of photos, instead of or alongside the album |
| `FRAMES_STARS_SEED` | | JSON list of `{id?, name, color?, goal, target?}`; read only while there are no kids yet |
| `FRAMES_DATA_DIR` | `/data` in the image | SQLite (stars, photo index). Back this up. |
| `FRAMES_CACHE_DIR` | `/cache` in the image | resized photos, last-good source snapshots; regenerable |
| `FRAMES_DASHBOARDS_DIR` | `/dashboards` in the image | dashboard files |

Outside the image the path defaults are `dashboards/` and `.local/{data,cache}`
in the checkout.

## Local development

Needs [mise](https://mise.jdx.dev) (pins Node in `.mise.toml`).

```sh
mise install
npm ci --ignore-scripts   # better-sqlite3 ships prebuilt binaries; skip its source build
npm run dev               # http://localhost:3000/example
npm test                  # vitest
npm run typecheck
npm run build             # client + server into .output/, then check-dist
npm run smoke             # starts the built server and probes it end to end
npm start                 # the built server
```

To see it as the frame does, use a 1280×800 window at device pixel ratio 1
with the CPU throttled 6× in DevTools, and watch the console for hydration
warnings.

Every source (weather, calendar, photos) is fetched on a schedule by the
server, never per request, and keeps its last good value (also on disk, for
restarts during an outage). A failed refresh retries with backoff and the
endpoint marks the data `stale`. Writes (`POST`, `DELETE`…) are refused with
403 when their `Origin`/`Referer` names another host (`src/start.ts`).

## What the frame can run

The PF1007L runs Android System WebView 106 and always will: 1280×800, DPR 1,
touch, a slow ARM CPU and about 1 GB of RAM. So:

- No `oklch()`/`oklab()`/`color-mix()`, CSS nesting, `:has()`, `dvh`/`svh`,
  `@container`, 4- or 8-digit hex colours (use `rgba()`), or blur. No JS API
  newer than Chrome 106 (`toSorted`, `Object.groupBy`, `Promise.withResolvers`…);
  the bundler targets `chrome106` but doesn't polyfill.
- No `alert`/`confirm`/`prompt`, no external links, nothing loaded from
  outside the service (fonts are bundled).
- No scrolling, no big or continuous animations, and re-render only what
  changes (widgets subscribe to the minute, not the second).
- Retry with backoff, keep the last good data and mark it stale; never show a
  permanent error after one failure.

`npm run build` runs [`scripts/check-dist.mjs`](scripts/check-dist.mjs),
which fails the build on any of the above that shows up in
`.output/public`, and on client JS over 450 KB. Pages are served
`no-cache` and assets have hashed, immutable names, so a deploy shows up at
the next daily reload.

## Deploy

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) typechecks,
tests, builds and smoke-tests every push and pull request. On `main` it
pushes `ghcr.io/reesemclean/frames:dev` and `:sha-<short>` (linux/amd64). The
homelab's `frames` stack follows `:dev`;
[`compose.example.yaml`](compose.example.yaml) shows the shape: one container
on port 3000, `/data` and `/cache` writable, the dashboards folder and an
optional photos folder mounted read-only. Mounting `/dashboards` replaces the
image's built-in `example.html`.

The image holds only Nitro's `.output` (the server bundle plus the native
modules it traced) on `node:24-slim`. It runs as uid 1000 and also under
compose `user: "1000:1000"`, as one process (the cache and SQLite assume
it). Its health check is `GET /healthz`.
