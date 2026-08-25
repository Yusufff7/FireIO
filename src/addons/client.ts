import type { Meta, MediaType, Stream } from '../types';
import { getSettingsSync } from '../storage/settings';

const json = async <T>(url: string, ms = 15000): Promise<T> => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
};

export const catalog = (type: MediaType, id: string): Promise<Meta[]> => {
  const { cinemetaBase } = getSettingsSync();
  return json<{ metas: Meta[] }>(`${cinemetaBase}/catalog/${type}/${id}.json`).then(r => r.metas ?? []);
};

export const search = (type: MediaType, q: string): Promise<Meta[]> => {
  const { cinemetaBase } = getSettingsSync();
  return json<{ metas: Meta[] }>(`${cinemetaBase}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`)
    .then(r => r.metas ?? []);
};

export const meta = (type: MediaType, id: string): Promise<Meta | null> => {
  const { cinemetaBase } = getSettingsSync();
  return json<{ meta: Meta }>(`${cinemetaBase}/meta/${type}/${id}.json`)
    .then(r => r.meta ?? null)
    .catch(() => null);
};

// Comet injects non-playable control rows (e.g. "[TB🔄] Comet Sync") that
// trigger an account rescan. They return a plausible-looking video/mp4
// content type, so they must be filtered explicitly — verified live, see
// PLAN.md §5.
const isControlEntry = (s: Stream) =>
  /comet sync/i.test(s.name ?? '') || /comet sync/i.test(s.title ?? '');

// Both addons tag every TorBox result with its cache state right in `name`
// — verified live: Torrentio uses "[TB+]" (cached) vs "[TB download]" (not
// yet on TorBox's servers), Comet uses "[TB⚡]" vs "[TB⬇️]". An uncached one
// still "resolves" (TorBox queues the torrent and serves a real MP4 in the
// meantime — the "still downloading" placeholder players show as an actual
// clip, not an error), so this can't be caught after the fact by checking
// resolveStream's response. It has to be excluded before it's ever offered
// as a candidate.
const isUncachedDebrid = (s: Stream) => /^\[tb[^\]]*(?:download|⬇)/i.test(s.name ?? '');

const RANK = ['2160p', '1080p', '720p', '480p'];
const byQuality = (a: Stream, b: Stream) => {
  const q = (s: Stream) => RANK.findIndex(r => (s.name ?? s.title ?? '').includes(r));
  const [qa, qb] = [q(a), q(b)];
  if (qa !== qb) return (qa < 0 ? 99 : qa) - (qb < 0 ? 99 : qb);
  // Playable-now first: .mp4, then anything with a filename, then unknowns.
  const rank = (s: Stream) => {
    const f = s.behaviorHints?.filename ?? '';
    return /\.mp4$/i.test(f) ? 0 : f ? 1 : 2;
  };
  return rank(a) - rank(b);
};

const MAX_PER_RESOLUTION = 6;
const MAX_TOTAL = 20;

// Resolution bucket a stream falls into, for the per-resolution cap below.
// Same detection RANK already uses, just exposed as a label instead of an
// index.
function resolutionOf(s: Stream): string {
  const text = s.name ?? s.title ?? '';
  return RANK.find(r => text.includes(r)) ?? 'other';
}

// id is `tt0133093` (movie) or `tt0903747:1:1` (series episode)
export async function streams(type: MediaType, id: string): Promise<Stream[]> {
  const { torrentioBase, cometBase } = getSettingsSync();
  const bases = [torrentioBase, cometBase].filter(Boolean);
  if (bases.length === 0) return [];

  const results = await Promise.allSettled(
    bases.map(base =>
      json<{ streams: Stream[] }>(`${base}/stream/${type}/${id}.json`, 30000)
        .then(r => (r.streams ?? []).map(s => ({ ...s, _source: safeHost(base) }))),
    ),
  );

  const all = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set<string>();
  const deduped = all
    .filter(s => s.url?.startsWith('https://'))
    .filter(s => !isControlEntry(s))
    .filter(s => !isUncachedDebrid(s))
    .filter(s => {
      const k = s.behaviorHints?.filename ?? s.url!;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort(byQuality);

  // Cap per resolution first (so 1080p releases can't crowd out every 2160p
  // option), then cap the combined total. Comet alone returned 1666 raw
  // results for one title in testing — this needs to stay small either way.
  const perResolution = new Map<string, Stream[]>();
  for (const s of deduped) {
    const bucket = resolutionOf(s);
    const list = perResolution.get(bucket) ?? [];
    if (list.length < MAX_PER_RESOLUTION) {
      list.push(s);
      perResolution.set(bucket, list);
    }
  }
  const capped = [...RANK, 'other'].flatMap(r => perResolution.get(r) ?? []);
  return capped.slice(0, MAX_TOTAL);
}

function safeHost(url: string): string {
  // Avoid relying on the URL polyfill's typings (inconsistent across RN
  // versions) — a plain regex is just as reliable here.
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : url;
}

// Throws unless the opening bytes carry a recognised container signature.
//
// Deliberately a whitelist, not a blacklist of error strings: a debrid
// service can word its failures however it likes ("failed to split torrent",
// a JSON blob, an HTML page, a bare "error"), and guessing at those phrases
// would always be one new message behind. What every WORKING source has in
// common is a container magic number in its first bytes, so that is what
// gets checked.
async function assertMediaContainer(r: { arrayBuffer: () => Promise<ArrayBuffer> }): Promise<void> {
  let head: Uint8Array;
  try {
    head = new Uint8Array(await r.arrayBuffer());
  } catch {
    // Can't read the body — don't reject on that alone, since a failure to
    // buffer here says nothing about whether the source is playable.
    return;
  }
  if (head.length < 12) throw new Error('source returned no data');

  const ascii = (start: number, text: string) => {
    for (let i = 0; i < text.length; i++) if (head[start + i] !== text.charCodeAt(i)) return false;
    return true;
  };

  const isMatroska = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3; // MKV/WebM EBML
  const isMp4 = ascii(4, 'ftyp'); // MP4/MOV/M4V
  const isRiff = ascii(0, 'RIFF'); // AVI
  const isMpegTs = head[0] === 0x47; // MPEG-TS sync byte
  const isMpegPs = head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01; // MPEG-PS/ES
  const isFlv = ascii(0, 'FLV');
  const isOgg = ascii(0, 'OggS');

  if (isMatroska || isMp4 || isRiff || isMpegTs || isMpegPs || isFlv || isOgg) return;

  // Not a container. Surface a little of what came back instead, so the
  // "trying source" progress line says something useful.
  let hint = '';
  try {
    hint = String.fromCharCode(...head.slice(0, 80)).replace(/[^\x20-\x7e]/g, '').trim();
  } catch {
    /* best effort only */
  }
  throw new Error(hint ? `source is not playable: ${hint}` : 'source is not a media container');
}

// Resolve at play time, not list time — TorBox's requestdl links open for a
// limited window, so a URL resolved while browsing can be stale by playback.
//
// A 2xx alone is NOT enough to call a source good, which is what the old
// version assumed. Two failure modes got through it and both looked like
// bugs elsewhere in the app:
//
//  1. No range support. Seeking a progressive URL is implemented as a byte
//     range request, so a server that ignores `Range` gives you a stream
//     that plays start-to-finish but where every scrub silently does
//     nothing — the scrub bar moves, the video doesn't.
//  2. Not actually video. An expired/queued debrid link answers 200 with an
//     HTML or JSON error body. The player accepts the URL, shows a frame or
//     two, then dies a few seconds in with a decode error.
//
// Both are cheap to detect here, and detecting them here is what lets the
// candidate walk treat them as "this source failed, try the next" instead of
// stranding playback on a source that was never going to work.
// A source that hasn't answered within this long is treated as a failure and
// the walk moves on. Kept deliberately short: a debrid link that is healthy
// responds to a range request almost immediately, so a slow one is nearly
// always a link that is still being prepared server-side — and waiting on it
// just leaves the user staring at "Trying source…".
const RESOLVE_TIMEOUT_MS = 10000;

export async function resolveStream(s: Stream): Promise<{ finalUrl: string; contentType?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RESOLVE_TIMEOUT_MS);
  try {
    // A small range request doubles as the probe: the response tells us the
    // final redirected URL, the content type, whether ranges work (206 +
    // Content-Range, or an explicit Accept-Ranges), AND — from the opening
    // bytes — whether this is genuinely a media container.
    const r = await fetch(s.url!, { method: 'GET', headers: { Range: 'bytes=0-1023' }, signal: ac.signal });
    if (!r.ok) throw new Error(`source returned ${r.status}`);

    const contentType = r.headers.get('content-type') ?? undefined;
    // Debrid services answer with text/html or application/json when a link
    // is expired, rate-limited, or still queueing.
    if (contentType && /^(text|application\/(json|xml))/i.test(contentType)) {
      throw new Error(`source is not video (${contentType})`);
    }

    const seekable = r.status === 206 || Boolean(r.headers.get('content-range')) || /bytes/i.test(r.headers.get('accept-ranges') ?? '');
    if (!seekable) throw new Error('source does not support seeking');

    // Headers alone can't be trusted. TorBox serves plain-text failures like
    // "failed to split torrent" for links it can't actually deliver, and
    // they don't reliably arrive with a text content-type — so the player
    // accepted the URL and died seconds into playback instead of the walk
    // moving on. The container signature settles it regardless of what the
    // headers claim, and the bytes are already in hand.
    await assertMediaContainer(r);

    return { finalUrl: r.url, contentType };
  } finally {
    clearTimeout(t);
  }
}

// Confirmed on real hardware: HEVC and MKV both play fine (the earlier VD
// rejection was a Virtual Device decoder gap, not a real platform limit).
// Only explicit HLS playlists need the MSE path.
export type PlaybackPath = 'url' | 'mse';

export function pickPlaybackPath(_s: Stream, finalUrl: string): PlaybackPath {
  if (/\.m3u8(\?|$)/i.test(finalUrl)) return 'mse';
  return 'url';
}

// Parsed from the release filename/title only — no fabricated fields.
// Language deliberately omitted: filename-based language detection is
// unreliable enough that showing a wrong one is worse than showing none.
export type ReleaseInfo = {
  resolution?: string;
  codec?: string;
  container?: string;
  hdr: boolean;
};

export function parseReleaseInfo(s: Stream): ReleaseInfo {
  const text = `${s.behaviorHints?.filename ?? ''} ${s.name ?? ''} ${s.title ?? ''}`;

  const resMatch = text.match(/2160p|1080p|720p|480p|4k/i);
  const resolution = resMatch ? (resMatch[0].toLowerCase() === '4k' ? '2160p' : resMatch[0].toLowerCase()) : undefined;

  let codec: string | undefined;
  if (/hevc|x265|h\.?265/i.test(text)) codec = 'HEVC';
  else if (/avc|x264|h\.?264/i.test(text)) codec = 'AVC';
  else if (/av1/i.test(text)) codec = 'AV1';

  const filename = s.behaviorHints?.filename ?? '';
  let container: string | undefined;
  if (/\.mkv$/i.test(filename)) container = 'MKV';
  else if (/\.mp4$/i.test(filename)) container = 'MP4';
  else if (/\.avi$/i.test(filename)) container = 'AVI';

  const hdr = /hdr10\+|hdr10|\bhdr\b|dolby\s?vision|\bdv\b/i.test(text);

  return { resolution, codec, container, hdr };
}

export function releaseLabel(info: ReleaseInfo): string {
  return [info.resolution, info.codec, info.container].filter(Boolean).join(' · ');
}
