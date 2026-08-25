import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
import { LOCAL_DEFAULTS } from './localDefaults';

// Everything here is user-secret or user-specific — never hardcode real
// values directly in this file, never commit them. The real values live in
// the gitignored ./localDefaults.ts (see localDefaults.example.ts). The
// Settings screen can still override any of this at runtime.
export type Settings = {
  torrentioBase: string;
  cometBase: string;
  cinemetaBase: string;
  opensubtitlesBase: string;
  // Catalog-only addon (anime rows sourced from AniList) — no meta/stream
  // resource of its own; its entries are plain IMDB ids that Cinemeta
  // resolves directly, so leave blank to turn its Home rows off entirely.
  animazeBase: string;
};

const KEY = 'stremiovega:settings:v1';

export const DEFAULT_SETTINGS: Settings = {
  torrentioBase: LOCAL_DEFAULTS.torrentioBase,
  cometBase: LOCAL_DEFAULTS.cometBase,
  cinemetaBase: 'https://v3-cinemeta.strem.io',
  opensubtitlesBase: 'https://opensubtitles-v3.strem.io',
  animazeBase:
    'https://animaze-fohz.onrender.com/{"top-airing-anilist":"on","top-anilist":"on","season-anilist":"on","popular-anilist":"on","next-to-watch-anilist":"on","upcoming-anilist":"on","trending-now-anilist":"on"}',
};

let cache: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  let resolved: Settings;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    resolved = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    resolved = { ...DEFAULT_SETTINGS };
  }
  cache = resolved;
  return resolved;
}

export function getSettingsSync(): Settings {
  return cache ?? DEFAULT_SETTINGS;
}

export async function saveSettings(next: Partial<Settings>): Promise<Settings> {
  const merged = { ...(cache ?? DEFAULT_SETTINGS), ...next };
  cache = merged;
  await AsyncStorage.setItem(KEY, JSON.stringify(merged));
  listeners.forEach(l => l(merged));
  return merged;
}

export function subscribeSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isConfigured(s: Settings): boolean {
  return Boolean(s.torrentioBase || s.cometBase);
}
