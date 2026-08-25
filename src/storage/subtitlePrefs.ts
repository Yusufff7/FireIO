import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';

// Two deliberately separate concerns, persisted under separate keys:
//
//   style — how subtitles LOOK. One global setting, because a size/background
//           you picked once is a readability preference about your TV and how
//           far you sit from it, not about the show.
//   delay — how far subtitles are SHIFTED in time. Per-show, because it
//           compensates for a particular release's muxing, and the next
//           episode of the same show is almost always the same release.
//
// Keyed by series id (`tt0903747`), not episode id (`tt0903747:1:2`), which
// is what makes the delay carry over to the next episode automatically.

export type SubtitleBackground = 'box' | 'outline' | 'none';

export type SubtitleStyle = {
  size: number; // rendered font size in px
  background: SubtitleBackground;
};

export const SUBTITLE_SIZES: Array<{ label: string; value: number }> = [
  { label: 'Small', value: 20 },
  { label: 'Medium', value: 26 },
  { label: 'Large', value: 32 },
  { label: 'Extra Large', value: 40 },
];

export const SUBTITLE_BACKGROUNDS: Array<{ label: string; value: SubtitleBackground }> = [
  { label: 'Box', value: 'box' },
  { label: 'Outline', value: 'outline' },
  { label: 'None', value: 'none' },
];

export const DELAY_STEP = 0.25;

const STYLE_KEY = 'stremiovega:subtitleStyle:v1';
const DELAY_KEY = 'stremiovega:subtitleDelays:v1';
const LANG_KEY = 'stremiovega:subtitleLangs:v1';

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 26, background: 'outline' };

let styleCache: SubtitleStyle | null = null;
let delayCache: Record<string, number> | null = null;
let langCache: Record<string, string | null> | null = null;
const styleListeners = new Set<(s: SubtitleStyle) => void>();

export async function loadSubtitlePrefs(): Promise<void> {
  try {
    const [rawStyle, rawDelays, rawLangs] = await Promise.all([
      AsyncStorage.getItem(STYLE_KEY),
      AsyncStorage.getItem(DELAY_KEY),
      AsyncStorage.getItem(LANG_KEY),
    ]);
    styleCache = rawStyle ? { ...DEFAULT_SUBTITLE_STYLE, ...JSON.parse(rawStyle) } : { ...DEFAULT_SUBTITLE_STYLE };
    delayCache = rawDelays ? JSON.parse(rawDelays) : {};
    langCache = rawLangs ? JSON.parse(rawLangs) : {};
  } catch {
    styleCache = { ...DEFAULT_SUBTITLE_STYLE };
    delayCache = {};
    langCache = {};
  }
}

export function getSubtitleStyleSync(): SubtitleStyle {
  return styleCache ?? DEFAULT_SUBTITLE_STYLE;
}

export async function saveSubtitleStyle(next: Partial<SubtitleStyle>): Promise<SubtitleStyle> {
  const merged = { ...(styleCache ?? DEFAULT_SUBTITLE_STYLE), ...next };
  styleCache = merged;
  styleListeners.forEach(l => l(merged));
  await AsyncStorage.setItem(STYLE_KEY, JSON.stringify(merged)).catch(() => {});
  return merged;
}

export function subscribeSubtitleStyle(fn: (s: SubtitleStyle) => void): () => void {
  styleListeners.add(fn);
  return () => styleListeners.delete(fn);
}

// Strips the `:season:episode` suffix so every episode of a series shares one
// delay — that's the whole point of storing it per show rather than per file.
export function showKey(id: string): string {
  return id.split(':')[0];
}

export function getSubtitleDelaySync(id: string): number {
  return delayCache?.[showKey(id)] ?? 0;
}

// Which subtitle language was last chosen for this show, so resuming — or
// starting the next episode — brings subtitles back automatically instead of
// silently playing with none. Stored per show rather than per episode: it's
// a preference about the show, and the episode ids change underneath it.
// `null` is a real, remembered value meaning "I turned them off".
export function getSubtitleLangSync(id: string): string | null | undefined {
  const map = langCache ?? {};
  const key = showKey(id);
  return key in map ? map[key] : undefined;
}

export async function saveSubtitleLang(id: string, lang: string | null): Promise<void> {
  const map = langCache ?? {};
  map[showKey(id)] = lang;
  langCache = map;
  await AsyncStorage.setItem(LANG_KEY, JSON.stringify(map)).catch(() => {});
}

export async function saveSubtitleDelay(id: string, seconds: number): Promise<void> {
  const map = delayCache ?? {};
  const key = showKey(id);
  // Don't persist a no-op — keeps the map from accumulating an entry for
  // every title the user ever opened the subtitle menu on.
  if (seconds === 0) delete map[key];
  else map[key] = seconds;
  delayCache = map;
  await AsyncStorage.setItem(DELAY_KEY, JSON.stringify(map)).catch(() => {});
}
