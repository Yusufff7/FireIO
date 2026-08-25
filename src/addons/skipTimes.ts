import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';

// Opening/ending timestamps, so the player can offer "Skip Intro" and roll
// into the next episode at the point the credits actually start rather than
// at a fixed guess.
//
// Why this particular route to the data:
//
// The obvious source, open-anime-timestamps, turns out to be mostly empty —
// measured against the live database: 10321 series keys but only 297 (2.9%)
// carry a single opening timestamp, and it records only a START, no end, so
// there's nothing to skip TO. AniSkip has the same shape of data but is
// actively maintained and returns a real {startTime, endTime} interval,
// which is what a skip button needs.
//
// AniSkip is keyed by MyAnimeList id and Cinemeta only ever gives us an
// IMDB id, so something has to bridge them. The ID-mapping databases that
// cover IMDB (Fribb's anime-lists) are a 7.5MB download to parse on a TV
// stick, and Jikan — the other obvious MAL lookup — answered 504 outright
// when tested, since it depends on MAL itself being up. AniList's GraphQL
// API answers a title search directly with `idMal`, in one small request,
// and was reliable in the same testing. So: title -> AniList -> idMal ->
// AniSkip.
//
// A title that AniList can't find is, for our purposes, not anime — which
// doubles as the genre-independent check the Animation genre alone can't
// give us (it catches Western animation, and misses anime Cinemeta hasn't
// tagged). Nothing here ever guesses: no mapping or no data means no banner,
// never a made-up timestamp.

export type SkipRange = { start: number; end: number };
export type SkipTimes = { op?: SkipRange; ed?: SkipRange };

const MAL_KEY = 'stremiovega:malIds:v1';
const SKIP_KEY = 'stremiovega:skipTimes:v1';

// `null` is a real, cached answer meaning "looked it up, it isn't anime" —
// that's what stops every non-anime episode from re-querying AniList.
let malCache: Record<string, number | null> | null = null;
let skipCache: Record<string, SkipTimes | null> | null = null;

async function loadCache<T>(key: string, current: T | null): Promise<T> {
  if (current) return current;
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function persist(key: string, value: unknown) {
  AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});
}

// AniList indexes each cour as its own entry ("Attack on Titan Season 2" is
// a different id from "Attack on Titan"), which lines up with how Cinemeta
// numbers seasons — verified live: season 1 resolves to idMal 16498 and
// season 2 to 25777. Season 1 is searched bare because that's how the first
// entry is actually titled.
function searchTitleFor(name: string, season: number): string {
  return season > 1 ? `${name} Season ${season}` : name;
}

const ANILIST_QUERY =
  'query($s:String){Media(search:$s,type:ANIME,format_in:[TV,TV_SHORT,ONA]){idMal}}';

async function fetchMalId(name: string, season: number): Promise<number | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { s: searchTitleFor(name, season) } }),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { Media?: { idMal?: number | null } | null } };
    return j.data?.Media?.idMal ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// `episodeLength=0` opts out of AniSkip's duration matching. We often don't
// know the real runtime at lookup time (the element may not have reported a
// duration yet), and a mismatch there would drop otherwise-valid results.
async function fetchSkipTimes(malId: number, episode: number): Promise<SkipTimes | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types[]=op&types[]=ed&episodeLength=0`;
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      found?: boolean;
      results?: Array<{ interval?: { startTime?: number; endTime?: number }; skipType?: string }>;
    };
    if (!j.found || !Array.isArray(j.results)) return null;

    const out: SkipTimes = {};
    for (const entry of j.results) {
      const start = entry.interval?.startTime;
      const end = entry.interval?.endTime;
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) continue;
      if (entry.skipType === 'op') out.op = { start, end };
      else if (entry.skipType === 'ed') out.ed = { start, end };
    }
    return out.op || out.ed ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Resolves the opening/ending intervals for one episode, or null when this
// isn't anime, isn't mapped, or simply has no data. Both lookups are cached
// permanently — including the negative results, which is what keeps this to
// at most one AniList call per series and one AniSkip call per episode.
export async function getSkipTimes(
  seriesId: string,
  seriesName: string,
  season: number,
  episode: number,
): Promise<SkipTimes | null> {
  const malKey = `${seriesId}:${season}`;
  malCache = await loadCache<Record<string, number | null>>(MAL_KEY, malCache);

  let malId: number | null;
  if (malKey in malCache) {
    malId = malCache[malKey];
  } else {
    malId = await fetchMalId(seriesName, season);
    malCache[malKey] = malId;
    persist(MAL_KEY, malCache);
  }
  if (malId === null) return null;

  const skipKey = `${malId}:${episode}`;
  skipCache = await loadCache<Record<string, SkipTimes | null>>(SKIP_KEY, skipCache);
  if (skipKey in skipCache) return skipCache[skipKey];

  const times = await fetchSkipTimes(malId, episode);
  skipCache[skipKey] = times;
  persist(SKIP_KEY, skipCache);
  return times;
}
