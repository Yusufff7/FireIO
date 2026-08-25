import type { Meta } from '../types';
import { getSettingsSync } from '../storage/settings';

// Animaze is catalog-only — verified via its own manifest.json:
// `resources: ["catalog"]`, no `meta` or `stream` resource. Its entries use
// plain IMDB ids (verified: tt28919914 resolves on Cinemeta with full
// description/genres/videos), so once a title is selected, everything
// downstream — Detail, Sources, Player — reuses the existing
// Cinemeta/Torrentio/Comet pipeline unchanged. No new detail-page logic
// needed, just extra Home rows.
const CATALOGS: Array<{ id: string; title: string }> = [
  { id: 'trending-now-anilist', title: 'Trending Anime' },
  { id: 'top-airing-anilist', title: 'Top Airing Anime' },
  { id: 'season-anilist', title: 'This Season' },
  { id: 'popular-anilist', title: 'Popular Anime' },
  { id: 'next-to-watch-anilist', title: 'What to Watch Next' },
  { id: 'upcoming-anilist', title: 'Upcoming Anime' },
  { id: 'top-anilist', title: 'Top Anime — All Time' },
];

export type AnimazeRow = { title: string; data: Meta[] };

// Fetched separately from the main catalog load (see HomeScreen), never
// blocking it — this is a free-tier hosted addon and can have a real cold
// start; rows should pop in whenever they're ready, not hold up Home.
export async function fetchAnimazeRows(): Promise<AnimazeRow[]> {
  const { animazeBase } = getSettingsSync();
  if (!animazeBase) return [];

  const results = await Promise.allSettled(
    CATALOGS.map(async c => {
      const r = await fetch(`${animazeBase}/catalog/series/${c.id}.json`);
      if (!r.ok) throw new Error(`${r.status}`);
      const body = (await r.json()) as { metas?: Meta[] };
      return { title: c.title, data: body.metas ?? [] };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<AnimazeRow> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(row => row.data.length > 0);
}
