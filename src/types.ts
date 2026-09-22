export type MediaType = 'movie' | 'series';

export type Meta = {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  year?: string | number;
  imdbRating?: string | number;
  runtime?: string;
  genres?: string[];
  cast?: string[];
  director?: string[];
  // Cinemeta returns rich per-episode metadata here for series — verified
  // live against tt0903747: every episode carries a name, an overview, a
  // w780 still frame, an IMDB rating and an air date. `title` is not one of
  // the fields it sends (the episode name is under `name`); it's kept as an
  // optional alias so older stored entries don't break.
  videos?: Episode[];
};

export type Episode = {
  id: string;
  season: number;
  episode: number;
  name?: string;
  title?: string;
  overview?: string;
  description?: string;
  thumbnail?: string;
  rating?: string | number;
  released?: string;
  firstAired?: string;
};

export type Stream = {
  url?: string;
  infoHash?: string;
  title?: string;
  name?: string;
  behaviorHints?: {
    filename?: string;
    videoSize?: number;
    bingeGroup?: string;
    notWebReady?: boolean;
  };
  _source?: string;
};

export type Subtitle = {
  id: string;
  url: string;
  lang: string;
  SubEncoding?: string;
  // OpenSubtitles ships several files per language and these are what tell
  // them apart — for anime especially, one "eng" entry is a dub script and
  // another is subs for the Japanese audio. Verified present on the live
  // addon response.
  subtitleFileName?: string;
  movieReleaseName?: string;
};

// Root stack param list — every screen and the params it needs.
export type RootStackParamList = {
  Home: undefined;
  Search: undefined;
  Detail: { id: string; type: MediaType };
  // PlayerScreen always resolves its own stream: it fetches every source
  // for `id`/`type`, buckets by language/resolution, and walks candidates in
  // priority order (or `preferredLanguage`/`preferredResolution`, with
  // normal fallback if that combination isn't available) until one actually
  // plays, showing progress as it goes. Every entry path in this app —
  // fresh play, Continue Watching resume, next episode — goes through that
  // same walk, so no caller ever passes a pre-resolved URL.
  Player: {
    title: string;
    id: string;
    type: MediaType;
    isAnime?: boolean;
    // Tried first, with normal fallback through the rest of the priority
    // order if unavailable or every candidate fails — what Continue
    // Watching and "next episode" pass so playback stays roughly the same
    // quality without needing the exact same release to still exist.
    // Deliberately NOT an exact source/release match — provider caches and
    // indexer results shift day to day, so pinning to one specific stream
    // just meant "resume" broke the moment that one disappeared.
    //
    // No language equivalent: MKV releases now expose their own embedded
    // audio tracks (see PlayerScreen's Audio Track menu, backed by
    // MkvMseSession), which is real per-file language selection instead of
    // a scene-tag guess at the release-picking level — so language is no
    // longer a dimension streamSelection.ts orders or remembers by.
    preferredResolution?: string;
    poster?: string;
    background?: string;
    releaseLabel?: string; // e.g. "1080p · HEVC · MKV", parsed from the filename
    nextEpisode?: { id: string; title: string };
    episodeThumbnail?: string;
    episodeLabel?: string;
  };
};

// Persisted "continue watching" entry — deliberately Meta-shaped so it can
// feed straight into PosterRow/Hero without a mapping step. For series it
// also remembers which episode was playing, so the card can show that
// episode's still and label instead of the series poster.
export type HistoryEntry = Meta & {
  watchedAt: number;
  episodeThumbnail?: string;
  episodeLabel?: string;
  // `id` is the SERIES id (so the card can navigate to a resolvable Detail
  // page); this is the full `tt…:season:episode` id needed to resume the
  // exact episode and to look up its sources.
  episodeId?: string;
  // What Continue Watching hands Player as its preferred resolution when
  // resuming. Not an exact release pin: resuming re-walks the current
  // source list with this as a preference and the normal fallback behind
  // it, so a resume still works even if the exact release that was playing
  // is no longer available.
  lastResolution?: string;
  // Needed to resume correctly: without this, a resume for an anime title
  // has no way to know the Japanese-default heuristic should apply.
  isAnime?: boolean;
  // Playback position for `episodeId`, in seconds, so the card can draw a
  // progress bar and the player can pick up where it left off.
  positionSec?: number;
  durationSec?: number;
};
