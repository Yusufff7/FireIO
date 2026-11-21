// Bundles the Tizen app into build/ — the folder that gets signed into a .wgt.
//
// The target is Chrome 56: that's the web engine in a 2018 (Tizen 4.0)
// Samsung TV. esbuild lowers newer syntax (optional chaining, object spread,
// class fields) to it, and core-js fills in the library features it lacks
// (Promise.allSettled, Array#flat, String#padStart, ...). It has no ES module
// support, so the bundle is a single classic script.
//
// The addon, stream, history and preference code is imported straight from
// the Fire TV app (../../src). Its only platform dependency is React Native's
// AsyncStorage, which is pointed at a localStorage-backed stand-in here.

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'build');
const watch = process.argv.includes('--watch');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['config.xml', 'index.html', 'icon.png']) copyFileSync(join(here, f), join(out, f));

const options = {
  entryPoints: [join(here, 'src/main.tsx')],
  bundle: true,
  outfile: join(out, 'app.js'),
  format: 'iife',
  target: ['chrome56'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
  legalComments: 'none',
  alias: {
    '@amazon-devices/react-native-async-storage__async-storage': join(here, 'src/platform/asyncStorage.ts'),
  },
  // Shared code under ../../src resolves its imports from this app's
  // node_modules, never the Fire TV app's (which holds React 19 / RN).
  nodePaths: [join(here, 'node_modules')],
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  loader: { '.css': 'css' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
