import type { HistoryEntry, Meta } from '../types';
import { catalog } from './client';
import { getSettingsSync } from '../storage/settings';

// The Home page's discovery rows, all from Cinemeta and all live: nothing
// here is a fixed list, so what's trending, new or top-rated is whatever
// Cinemeta says today. Cinemeta's catalogs:
//
//   top          "Popular" — what people are watching now (trending)
//   year         "New" — released in a given year, most popular first
//   imdbRating   "Featured" — top rated
//
// each optionally narrowed by genre. "New" always uses the current year,
// so the row rolls over on its own on January 1st.

export type DiscoveryRow = { key: string; title: string; load: () => Promise<Meta[]> };

const genreRow = (type: 'movie' | 'series', genre: string, title: string): DiscoveryRow => ({
  key: `${type}:top:${genre}`,
  title,
  load: () => catalog(type, `top/genre=${encodeURIComponent(genre)}`),
});

export function discoveryRows(now: Date = new Date()): DiscoveryRow[] {
  const year = now.getFullYear();
  // Early in January the current year's catalog is nearly empty, so last
  // year's new releases fill in behind it.
  const newIn = async (type: 'movie' | 'series') => {
    const current = await catalog(type, `year/genre=${year}`).catch(() => [] as Meta[]);
    if (current.length >= 15) return current;
    const previous = await catalog(type, `year/genre=${year - 1}`).catch(() => [] as Meta[]);
    const seen = new Set(current.map(m => m.id));
    return [...current, ...previous.filter(m => !seen.has(m.id))];
  };
  return [
    { key: 'series:top', title: 'Trending Shows', load: () => catalog('series', 'top') },
    { key: 'movie:top', title: 'Trending Movies', load: () => catalog('movie', 'top') },
    { key: 'series:new', title: 'New Shows', load: () => newIn('series') },
    { key: 'movie:new', title: 'New Movies', load: () => newIn('movie') },
    { key: 'series:rated', title: 'Top Rated Shows', load: () => catalog('series', 'imdbRating') },
    { key: 'movie:rated', title: 'Top Rated Movies', load: () => catalog('movie', 'imdbRating') },
    genreRow('series', 'Comedy', 'Comedy Shows'),
    genreRow('series', 'Drama', 'Drama Shows'),
    genreRow('series', 'Crime', 'Crime Shows'),
    genreRow('series', 'Sci-Fi', 'Sci-Fi & Fantasy Shows'),
    genreRow('series', 'Reality-TV', 'Reality TV'),
    genreRow('series', 'Documentary', 'Docuseries'),
    genreRow('movie', 'Action', 'Action Movies'),
    genreRow('movie', 'Comedy', 'Comedy Movies'),
    genreRow('movie', 'Thriller', 'Thrillers'),
    genreRow('movie', 'Horror', 'Horror Movies'),
    genreRow('movie', 'Sci-Fi', 'Sci-Fi Movies'),
    genreRow('movie', 'Family', 'Family Movies'),
  ];
}

// How recent an episode has to be to count as "new".
const NEW_EPISODE_DAYS = 30;

// Shows from your history with an episode out in the last month, newest
// first — Cinemeta's "last videos" catalog returns each show with its most
// recent episodes. Each result carries the new episode's label for the card.
export async function newEpisodesOfWatched(history: HistoryEntry[], now: number = Date.now()): Promise<Meta[]> {
  const ids = [...new Set(history.filter(h => h.type === 'series').map(h => h.id))].slice(0, 20);
  if (ids.length === 0) return [];
  const { cinemetaBase } = getSettingsSync();
  const r = await fetch(`${cinemetaBase}/catalog/series/last-videos/lastVideosIds=${ids.join(',')}.json`);
  if (!r.ok) return [];
  const body = (await r.json()) as { metasDetailed?: Meta[] };
  const cutoff = now - NEW_EPISODE_DAYS * 86400000;
  const out: Array<{ meta: Meta; at: number }> = [];
  for (const m of body.metasDetailed ?? []) {
    let latest: { at: number; label: string } | null = null;
    for (const v of m.videos ?? []) {
      const at = Date.parse(v.released ?? v.firstAired ?? '');
      if (!isFinite(at) || at > now || at < cutoff || v.season === 0) continue;
      if (!latest || at > latest.at) latest = { at, label: `S${v.season}E${v.episode}` };
    }
    if (latest) {
      out.push({ meta: { ...m, type: 'series', badge: `New: ${latest.label}` }, at: latest.at });
    }
  }
  return out.sort((a, b) => b.at - a.at).map(x => x.meta);
}
