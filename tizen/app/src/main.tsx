// Library features Chrome 56 (the TV's engine) lacks: Promise.allSettled,
// Array#flat/flatMap, Object.fromEntries, String#padStart, and so on. Syntax
// is handled separately, by esbuild's chrome56 target.
import 'core-js/stable';
// AbortController arrived in Chrome 66. The shared code uses it for request
// timeouts; this adds it, and makes fetch honour its signal.
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch';
import './styles.css';

import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerMediaKeys } from './platform/keys';
import { loadSettings } from '../../../src/storage/settings';
import { loadSubtitlePrefs } from '../../../src/storage/subtitlePrefs';
import { loadSourcePrefs } from '../../../src/storage/sourcePrefs';
import { loadHistory } from '../../../src/storage/history';

registerMediaKeys();

// The *Sync getters the screens use read caches these fill.
Promise.all([loadSettings(), loadSubtitlePrefs(), loadSourcePrefs(), loadHistory()])
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById('root')!).render(<App />);
  });
