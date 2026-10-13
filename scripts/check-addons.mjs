#!/usr/bin/env node
// Checks the stream addons configured in src/storage/localDefaults.ts the way
// the app's source walk sees them: for one title, lists each addon's streams,
// then makes the same 1 KB range request the app makes before playing a
// source, and reports how long it took and what the bytes actually are.
//
// Useful for telling "an addon or the service behind it is down / slow /
// serving error videos" apart from an app bug. Prints release names, never
// URLs — a configured addon URL usually embeds an API key, and resolved
// stream links often carry access tokens.
//
// Usage (needs Node 18+):
//   node scripts/check-addons.mjs                  # default title
//   node scripts/check-addons.mjs tt0903747:1:1    # a series episode
//   node scripts/check-addons.mjs tt0133093 8      # probe up to 8 streams per addon

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] || 'tt0133093';
const perAddon = Number(process.argv[3] || 4);
const type = id.includes(':') ? 'series' : 'movie';
const TIMEOUT_MS = 30000;

let config;
try {
  config = readFileSync(join(root, 'src/storage/localDefaults.ts'), 'utf8');
} catch {
  console.error('No src/storage/localDefaults.ts — copy localDefaults.example.ts and add your addon URLs first.');
  process.exit(1);
}

// The two lists, by name, so the output can say which set an addon is in.
const listOf = name => {
  const m = config.match(new RegExp(`${name}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  return m ? [...m[1].matchAll(/'(https?:\/\/[^']+)'/g)].map(x => x[1].replace(/\/manifest\.json$/, '').replace(/\/$/, '')) : [];
};
const sets = [
  ['main', listOf('streamAddonUrls')],
  ['backup', listOf('backupStreamAddonUrls')],
];

const hostOf = url => url.match(/^https?:\/\/([^/]+)/)?.[1] ?? '?';

function sniff(bytes) {
  if (bytes.length < 12) return 'no data';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'MKV/WebM';
  if (bytes.toString('latin1', 4, 8) === 'ftyp') return 'MP4';
  if (bytes.toString('latin1', 0, 4) === 'RIFF') return 'AVI';
  if (bytes[0] === 0x47) return 'MPEG-TS';
  return `not media: "${bytes.toString('latin1', 0, 40).replace(/[^\x20-\x7e]/g, '').trim()}"`;
}

async function timed(url, init) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    return { r, ms: () => Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

for (const [setName, bases] of sets) {
  for (const base of bases) {
    console.log(`\n${setName} addon @ ${hostOf(base)}`);
    let streams;
    try {
      const { r, ms } = await timed(`${base}/stream/${type}/${id}.json`);
      streams = (await r.json()).streams ?? [];
      console.log(`  ${streams.length} streams listed in ${ms()}ms`);
    } catch (e) {
      console.log(`  stream list failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
      continue;
    }
    for (const s of streams.slice(0, perAddon)) {
      const name = (s.behaviorHints?.filename || s.title || s.name || 'unnamed').replace(/\s+/g, ' ').slice(0, 80);
      if (!s.url) {
        console.log(`  [no link]  ${name}`);
        continue;
      }
      try {
        const { r, ms } = await timed(s.url, { headers: { Range: 'bytes=0-1023' } });
        const bytes = Buffer.from(await r.arrayBuffer());
        const seekable = r.status === 206 || Boolean(r.headers.get('content-range'));
        console.log(`  ${r.status} ${String(ms()).padStart(6)}ms ${seekable ? 'seekable ' : 'NO RANGES'} ${sniff(bytes).padEnd(10)} ${name}`);
      } catch (e) {
        console.log(`  ${e.name === 'AbortError' ? 'TIMED OUT (30s)' : `failed: ${e.message}`}  ${name}`);
      }
    }
  }
}
