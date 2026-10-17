import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
import { canonicalLang, type TrackPreference } from '../addons/languages';

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
const SUB_PREF_KEY = 'stremiovega:subtitlePrefs:v2';
const AUDIO_PREF_KEY = 'stremiovega:audioPrefs:v1';

// A remembered subtitle choice: which language and track, and whether it was
// one of the file's own (embedded) tracks or an OpenSubtitles download — the
// same kind is preferred when it's re-applied. `null` means "turned off".
export type SubtitlePreference = TrackPreference & { source?: 'embedded' | 'external' };

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 26, background: 'outline' };

let styleCache: SubtitleStyle | null = null;
let delayCache: Record<string, number> | null = null;
let subPrefCache: Record<string, SubtitlePreference | null> | null = null;
let audioPrefCache: Record<string, TrackPreference> | null = null;
const styleListeners = new Set<(s: SubtitleStyle) => void>();

export async function loadSubtitlePrefs(): Promise<void> {
  try {
    const [rawStyle, rawDelays, rawLangs, rawSubPrefs, rawAudioPrefs] = await Promise.all([
      AsyncStorage.getItem(STYLE_KEY),
      AsyncStorage.getItem(DELAY_KEY),
      AsyncStorage.getItem(LANG_KEY),
      AsyncStorage.getItem(SUB_PREF_KEY),
      AsyncStorage.getItem(AUDIO_PREF_KEY),
    ]);
    styleCache = rawStyle ? { ...DEFAULT_SUBTITLE_STYLE, ...JSON.parse(rawStyle) } : { ...DEFAULT_SUBTITLE_STYLE };
    delayCache = rawDelays ? JSON.parse(rawDelays) : {};
    subPrefCache = rawSubPrefs ? JSON.parse(rawSubPrefs) : {};
    audioPrefCache = rawAudioPrefs ? JSON.parse(rawAudioPrefs) : {};
    // Carry over choices saved before track-level preferences existed (just
    // a language code per show), for shows without a newer entry.
    const legacy: Record<string, string | null> = rawLangs ? JSON.parse(rawLangs) : {};
    for (const [show, lang] of Object.entries(legacy)) {
      if (show in subPrefCache!) continue;
      subPrefCache![show] = lang === null ? null : { lang: canonicalLang(lang) };
    }
  } catch {
    styleCache = { ...DEFAULT_SUBTITLE_STYLE };
    delayCache = {};
    subPrefCache = {};
    audioPrefCache = {};
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

// The subtitle track last chosen for this show, so resuming — or starting
// the next episode — brings the same subtitles back instead of playing with
// none. Per show rather than per episode: it's a preference about the show,
// and the episode ids change underneath it. `null` is a real, remembered
// value meaning "I turned them off"; undefined means nothing's remembered.
export function getSubtitlePrefSync(id: string): SubtitlePreference | null | undefined {
  const map = subPrefCache ?? {};
  const key = showKey(id);
  return key in map ? map[key] : undefined;
}

export async function saveSubtitlePref(id: string, pref: SubtitlePreference | null): Promise<void> {
  const map = subPrefCache ?? {};
  map[showKey(id)] = pref;
  subPrefCache = map;
  await AsyncStorage.setItem(SUB_PREF_KEY, JSON.stringify(map)).catch(() => {});
}

// The audio track (language, plus name for same-language tracks such as a
// commentary) last chosen for this show, applied when an episode loads.
export function getAudioPrefSync(id: string): TrackPreference | undefined {
  return (audioPrefCache ?? {})[showKey(id)];
}

export async function saveAudioPref(id: string, pref: TrackPreference): Promise<void> {
  const map = audioPrefCache ?? {};
  map[showKey(id)] = pref;
  audioPrefCache = map;
  await AsyncStorage.setItem(AUDIO_PREF_KEY, JSON.stringify(map)).catch(() => {});
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
