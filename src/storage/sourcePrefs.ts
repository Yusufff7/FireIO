import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
import { parseReleaseInfo } from '../addons/client';
import type { Stream } from '../types';

// The source you last watched each show (or movie) from, so the next
// episode, a different episode, or a resume tries that same source first —
// and the subtitle/audio choices remembered alongside it (subtitlePrefs.ts)
// line up with the release they were picked on.
//
// "The same source" means different things depending on the episode:
//
//   same episode   — the exact file: same filename, or the same torrent
//                    and file.
//   other episode  — the same release run. Stremio addons mark the streams
//                    of one release pack across a season with a shared
//                    `bingeGroup`, which is the best signal there is. When an
//                    addon doesn't send one, the release group named in the
//                    filename ("[SubsPlease] …", "… -NTb.mkv") plus the
//                    resolution and the addon it came from stand in for it.
//
// Keyed by series id (`tt0903747`), like the other per-show preferences.

export type SourcePreference = {
  episodeId: string;
  filename?: string;
  infoHash?: string;
  bingeGroup?: string;
  releaseGroup?: string;
  resolution?: string;
  addon?: string;
};

const KEY = 'stremiovega:sourcePrefs:v1';
let cache: Record<string, SourcePreference> | null = null;

export async function loadSourcePrefs(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
}

export function getSourcePrefSync(seriesId: string): SourcePreference | undefined {
  return cache?.[seriesId];
}

function filenameOf(s: Stream): string | undefined {
  return s.behaviorHints?.filename ?? s.title?.split('\n')[0] ?? undefined;
}

// "[SubsPlease] Show - 01 (1080p) [ABCD1234].mkv" -> "subsplease";
// "Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv" -> "ntb".
export function releaseGroupOf(s: Stream): string | undefined {
  const name = filenameOf(s);
  if (!name) return undefined;
  const leading = /^\s*\[([^\]]{2,40})\]/.exec(name);
  if (leading) return leading[1].trim().toLowerCase();
  const trailing = /-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?(?:\.[A-Za-z0-9]{2,4})?\s*$/.exec(name);
  return trailing ? trailing[1].toLowerCase() : undefined;
}

export function describeSource(s: Stream, episodeId: string): SourcePreference {
  return {
    episodeId,
    filename: filenameOf(s),
    infoHash: s.infoHash,
    bingeGroup: s.behaviorHints?.bingeGroup,
    releaseGroup: releaseGroupOf(s),
    resolution: parseReleaseInfo(s).resolution,
    addon: s._source,
  };
}

export async function saveSourcePref(seriesId: string, pref: SourcePreference): Promise<void> {
  cache = { ...(cache ?? {}), [seriesId]: pref };
  await AsyncStorage.setItem(KEY, JSON.stringify(cache));
}

// How well `s` matches the remembered source for the episode being played;
// 0 means it isn't that source. Higher wins.
export function sourceMatchScore(s: Stream, pref: SourcePreference, episodeId: string): number {
  const sameEpisode = pref.episodeId === episodeId;
  if (sameEpisode) {
    const file = filenameOf(s);
    if (pref.filename && file === pref.filename) return 100;
    if (pref.infoHash && s.infoHash === pref.infoHash) return 90;
  }
  const sameAddon = !pref.addon || pref.addon === s._source;
  if (pref.bingeGroup && s.behaviorHints?.bingeGroup === pref.bingeGroup) return sameAddon ? 80 : 70;
  const group = releaseGroupOf(s);
  if (pref.releaseGroup && group === pref.releaseGroup) {
    const sameRes = pref.resolution !== undefined && parseReleaseInfo(s).resolution === pref.resolution;
    return (sameRes ? 40 : 30) + (sameAddon ? 5 : 0);
  }
  return 0;
}
