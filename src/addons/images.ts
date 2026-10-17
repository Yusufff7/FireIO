// Picks image sizes to match how big they're actually drawn.
//
// The stick has 1 GB of RAM, and a decoded image costs width x height x 4
// bytes no matter how small it's drawn. Cinemeta's default poster is the
// metahub "medium" size, a 500x750 WebP (1.5 MB decoded), shown in a
// 106x142 tile — about 159x213 real pixels on this screen. With every row
// holding a dozen or more of those, the system was trimming the app's image
// cache under memory pressure (visible in the device log), so artwork that
// had already loaded had to load again, which is part of why the hero and
// rows felt slow. "small" is 300x450 (0.54 MB) and still sharper than the
// tile.

const METAHUB = /^(https?:\/\/images\.metahub\.space\/(?:poster|background|logo)\/)(?:small|medium|large)(\/.*)$/;
// AniList's CDN serves covers at extraLarge / large / medium.
const ANILIST_COVER = /^(https?:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/anime\/cover\/)(?:extraLarge|large|medium)(\/.*)$/;

function withMetahubSize(url: string, size: 'small' | 'medium'): string {
  const m = METAHUB.exec(url);
  return m ? `${m[1]}${size}${m[2]}` : url;
}

// For poster tiles in rows and search results.
export function posterThumb(url: string | undefined): string | undefined {
  if (!url) return url;
  const a = ANILIST_COVER.exec(url);
  if (a) return `${a[1]}medium${a[2]}`;
  return withMetahubSize(url, 'small');
}

// Episode stills: Cinemeta links metahub's w780 (780x439, 1.4 MB decoded),
// which redirects to TMDB, where every w-size exists. Tiles draw them at
// 150-260dp wide.
const EPISODE_STILL = /^(https?:\/\/episodes\.metahub\.space\/.+\/)w\d+(\.jpg)$/;

export function stillThumb(url: string | undefined, size: 'w300' | 'w342' = 'w300'): string | undefined {
  if (!url) return url;
  const m = EPISODE_STILL.exec(url);
  return m ? `${m[1]}${size}${m[2]}` : url;
}

// For backdrops drawn small (the 150-wide Continue Watching tile): 480x270
// instead of 1280x720 — a seventh of the memory.
export function backdropThumb(url: string | undefined): string | undefined {
  return url ? withMetahubSize(url, 'small') : url;
}
