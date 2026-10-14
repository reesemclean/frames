# Keep the Node version in step with .mise.toml.

# --- Build: vite build (client + Nitro server), gated by scripts/check-dist.mjs ---
FROM node:24.21-slim AS build
WORKDIR /app
# Dependencies first, so a code-only change reuses this layer. Installing on
# linux is what puts linux binaries for sharp (@img/sharp-linux-*) in
# node_modules for Nitro to trace. --ignore-scripts: better-sqlite3 ships
# prebuilt binaries, but `npm ci` doesn't see its `gypfile: false` in the
# lockfile and tries `node-gyp rebuild` (no Python here); nothing else needs
# its install script.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# --- Runtime: only .output. Nitro bundles the server and traces its native
# dependencies (better-sqlite3, sharp) into .output/server/node_modules. ---
FROM node:24.21-slim
WORKDIR /app
COPY --from=build /app/.output ./.output
COPY dashboards/example.html /dashboards/example.html

# Fail the image build, not the first request, if a native module wasn't
# traced or has no binary for this platform. sharp is checked only once the
# server code imports it.
RUN cd .output/server && node --input-type=module -e " \
  import fs from 'node:fs'; \
  const { default: Database } = await import('better-sqlite3'); \
  new Database(':memory:').prepare('SELECT 1').get(); \
  const code = fs.readdirSync('.', { recursive: true }).filter((f) => /\.m?js$/.test(f) && !f.startsWith('node_modules')); \
  if (code.some((f) => /[\"']sharp[\"']/.test(fs.readFileSync(f, 'utf8')))) { \
    const { default: sharp } = await import('sharp'); \
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer(); \
    console.log('sharp ok, libvips', sharp.versions.vips); \
  } \
  console.log('native modules ok'); \
"

# The base image's `node` user is uid 1000, matching compose's
# `user: "1000:1000"`. Nothing at runtime needs a home directory and the app
# is world-readable, so any uid works as long as it can write /data and
# /cache (normally volumes).
RUN mkdir -p /data /cache \
 && chown 1000:1000 /data /cache \
 && chmod -R a+rX /app /dashboards

ENV NODE_ENV=production \
    PORT=3000 \
    FRAMES_DATA_DIR=/data \
    FRAMES_CACHE_DIR=/cache \
    FRAMES_DASHBOARDS_DIR=/dashboards

USER 1000:1000
EXPOSE 3000
VOLUME ["/data", "/cache"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# One process: the source cache and the SQLite connection assume it.
CMD ["node", ".output/server/index.mjs"]
