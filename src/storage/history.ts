import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
import type { HistoryEntry } from '../types';

const KEY = 'stremiovega:history:v1';
const MAX_ENTRIES = 20;

let cache: HistoryEntry[] | null = null;
const listeners = new Set<(h: HistoryEntry[]) => void>();

export async function loadHistory(): Promise<HistoryEntry[]> {
  if (cache) return cache;
  let resolved: HistoryEntry[];
  try {
    const raw = await AsyncStorage.getItem(KEY);
    resolved = raw ? JSON.parse(raw) : [];
  } catch {
    resolved = [];
  }
  cache = resolved;
  return resolved;
}

export function getHistorySync(): HistoryEntry[] {
  return cache ?? [];
}

// Called when playback actually starts (not just when the Player screen
// mounts) — moves the item to the front if it's already there, so
// re-watching something bumps it rather than duplicating it.
export async function recordWatched(item: Omit<HistoryEntry, 'watchedAt'>): Promise<HistoryEntry[]> {
  const current = cache ?? (await loadHistory());
  const withoutItem = current.filter(h => h.id !== item.id);
  const next = [{ ...item, watchedAt: Date.now() }, ...withoutItem].slice(0, MAX_ENTRIES);
  cache = next;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach(l => l(next));
  return next;
}

// Treated as "finished" past this fraction — resuming 30s from the end is
// worse than starting the next thing, and the card shouldn't sit at 99%.
const WATCHED_THRESHOLD = 0.95;
// Below this there's nothing meaningful to resume to.
const MIN_RESUME_SEC = 20;

// Called periodically during playback. Updates the entry in place — no
// reordering, because bumping the row every few seconds while you watch
// would make the Continue Watching order jump around under you.
export async function saveProgress(
  seriesId: string,
  episodeId: string,
  positionSec: number,
  durationSec: number,
): Promise<void> {
  const current = cache ?? (await loadHistory());
  const idx = current.findIndex(h => h.id === seriesId);
  if (idx < 0) return;
  const entry = current[idx];
  // Only track the episode this entry actually points at; an older episode
  // playing in the background shouldn't overwrite the newer bookmark.
  if (entry.episodeId && entry.episodeId !== episodeId) return;
  const next = [...current];
  next[idx] = { ...entry, positionSec, durationSec };
  cache = next;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach(l => l(next));
}

// Where playback should start for this entry, or 0 to start from the top.
export function resumePositionFor(entry: HistoryEntry): number {
  const { positionSec, durationSec } = entry;
  if (!positionSec || positionSec < MIN_RESUME_SEC) return 0;
  if (durationSec && positionSec > durationSec * WATCHED_THRESHOLD) return 0;
  return positionSec;
}

// 0..1 for the card's progress bar, or 0 when there's nothing to show.
export function progressFractionFor(entry: HistoryEntry): number {
  const { positionSec, durationSec } = entry;
  if (!positionSec || !durationSec || durationSec <= 0) return 0;
  return Math.max(0, Math.min(1, positionSec / durationSec));
}

// Removes one entry (long-press on its Continue Watching card). Keyed on the
// same `id` the card was built from — the series id for episodes, so removing
// it clears the whole show rather than one episode.
export async function removeWatched(id: string): Promise<HistoryEntry[]> {
  const current = cache ?? (await loadHistory());
  const next = current.filter(h => h.id !== id);
  cache = next;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach(l => l(next));
  return next;
}

export function subscribeHistory(fn: (h: HistoryEntry[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
