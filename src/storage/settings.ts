import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
import { LOCAL_DEFAULTS } from './localDefaults';

// Everything here is user-secret or user-specific — never hardcode real
// values directly in this file, never commit them. The real values live in
// the gitignored ./localDefaults.ts (see localDefaults.example.ts). The
// Settings screen can still override any of this at runtime.
export type Settings = {
  // Stream-source addons, queried in parallel and merged. Deliberately a
  // list rather than named slots: nothing here depends on *which* addons
  // these are, only that they speak the Stremio stream protocol, so adding
  // or removing one is a config change rather than a code change.
  streamAddonUrls: string[];
  // A second set of stream addons to switch to when the primary set's
  // backing service is down — same protocol, just a different pool. Which
  // set is live is `useBackupStreamAddons`, flipped from the player.
  backupStreamAddonUrls: string[];
  useBackupStreamAddons: boolean;
  cinemetaBase: string;
  opensubtitlesBase: string;
  // Catalog-only addon (anime rows sourced from AniList) — no meta/stream
  // resource of its own; its entries are plain IMDB ids that Cinemeta
  // resolves directly, so leave blank to turn its Home rows off entirely.
  animazeBase: string;
};

const KEY = 'stremiovega:settings:v1';

export const DEFAULT_SETTINGS: Settings = {
  streamAddonUrls: LOCAL_DEFAULTS.streamAddonUrls,
  backupStreamAddonUrls: LOCAL_DEFAULTS.backupStreamAddonUrls ?? [],
  useBackupStreamAddons: false,
  cinemetaBase: 'https://v3-cinemeta.strem.io',
  opensubtitlesBase: 'https://opensubtitles-v3.strem.io',
  animazeBase:
    'https://animaze-fohz.onrender.com/{"top-airing-anilist":"on","top-anilist":"on","season-anilist":"on","popular-anilist":"on","next-to-watch-anilist":"on","upcoming-anilist":"on","trending-now-anilist":"on"}',
};

let cache: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

// Addon URLs are defaults-only (never edited in-app), so they always come
// from the current build rather than whatever an older build persisted —
// otherwise a newly added backup list would be shadowed by a stored blob
// that predates it. Only the user's actual choices are taken from storage.
function withBuildDefaults(stored: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    streamAddonUrls: DEFAULT_SETTINGS.streamAddonUrls,
    backupStreamAddonUrls: DEFAULT_SETTINGS.backupStreamAddonUrls,
  };
}

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  let resolved: Settings;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    resolved = raw ? withBuildDefaults(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
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

// Defensive about the array: settings are merged from whatever JSON was
// persisted by a previous version, so a stored blob predating this field
// (or carrying a null) must not throw here.
export function isConfigured(s: Settings): boolean {
  return activeStreamAddonUrls(s).length > 0;
}

// The stream addon set currently in use — the backup set when it's switched
// on and actually has entries, the primary set otherwise.
export function activeStreamAddonUrls(s: Settings): string[] {
  const backup = Array.isArray(s.backupStreamAddonUrls) ? s.backupStreamAddonUrls.filter(Boolean) : [];
  if (s.useBackupStreamAddons && backup.length > 0) return backup;
  return Array.isArray(s.streamAddonUrls) ? s.streamAddonUrls.filter(Boolean) : [];
}

export function hasBackupStreamAddons(s: Settings): boolean {
  return Array.isArray(s.backupStreamAddonUrls) && s.backupStreamAddonUrls.some(Boolean);
}
