// Gate the built output on what the frame (WebView 106) can't run. The
// bundler rewrites syntax for chrome106 but adds no polyfills and doesn't
// touch CSS features, so this checks dist/, not the source.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p); else files.push(p);
  }
})(process.argv[2] || 'dist');

const css = [
  [/#[0-9a-fA-F]{4}(?![0-9a-fA-F])/, '4-digit hex colour'],
  [/#[0-9a-fA-F]{8}(?![0-9a-fA-F])/, '8-digit hex colour'],
  [/oklch\(|oklab\(|color-mix\(/, 'modern colour function'],
  [/:has\(/, ':has()'],
  [/\d(dvh|svh|lvh)\b/, 'dynamic viewport unit'],
  [/backdrop-filter|filter:\s*blur|blur\(/, 'blur (too heavy for the frame GPU)'],
  [/@container|@starting-style|text-wrap:\s*balance/, 'CSS newer than Chrome 106'],
];
const js = [
  [/\.(toSorted|toReversed|toSpliced|groupBy|withResolvers|fromAsync)\(/, 'JS API newer than Chrome 106'],
  [/Object\.groupBy|Map\.groupBy|Promise\.withResolvers|Array\.fromAsync/, 'JS API newer than Chrome 106'],
  [/\balert\(|\bconfirm\(|\bprompt\(/, 'alert/confirm/prompt (no-ops on the kiosk)'],
];
const all = [
  // Strings, not loads: React's error-decoder links and SVG namespaces.
  [/https?:\/\/(?!www\.w3\.org\/|react\.dev\/errors)[a-z0-9.-]+\.[a-z]{2,}/i, 'external URL (self-host everything)'],
];

let bad = 0;
for (const f of files) {
  if (!/\.(css|js|html)$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  const rules = [...all, ...(f.endsWith('.css') ? css : []), ...(f.endsWith('.js') ? js : [])];
  for (const [re, what] of rules) {
    const m = text.match(re);
    if (m) {
      bad++;
      const i = m.index;
      console.error(`${f}: ${what}: …${text.slice(Math.max(0, i - 40), i + 40)}…`);
    }
  }
}
const jsBytes = files.filter((f) => f.endsWith('.js')).reduce((n, f) => n + statSync(f).size, 0);
const jsGzip = files.filter((f) => f.endsWith('.js')).reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
console.log(`dist: ${files.length} files, JS ${(jsBytes / 1024).toFixed(1)} KB (${(jsGzip / 1024).toFixed(1)} KB gzip)`);
// React + Router + Query is ~370 KB raw / ~120 KB gzip; the frame's budget
// is "the low hundreds of KB".
if (jsBytes > 450 * 1024) { console.error('JS bundle over 450 KB'); bad++; }
if (bad) { console.error(`${bad} frame-compatibility problem(s)`); process.exit(1); }
