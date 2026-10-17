import type { Meta } from '../types';

// Direct trailer streams for a YouTube id, for the Home hero.
//
// Cinemeta only ever gives a YouTube id. The first version played that
// through YouTube's embed page in a WebView, which never once reached
// playback on the stick: each WebView spun up a whole browser renderer
// process, the system answered with memory-pressure trims, and nothing was
// on screen before focus moved on. Instead, ask YouTube's player API for
// the streams themselves and play them through the same native
// MediaSource pipeline the main player uses.
//
// The request identifies as YouTube's iOS app: that client is answered
// with plain, unsigned stream URLs (no signature cipher to undo), which is
// why it's the one tools like yt-dlp rely on. Its adaptive formats are
// standard fragmented MP4 — H.264 video and AAC audio as separate files —
// exactly what MediaSource takes. Verified against a live trailer: 720p
// video (avc1.4D401F, ~1.1 Mbps) and 128k AAC, both fetchable in byte ranges.

export type TrailerStreams = {
  video: { url: string; mime: string; size: number };
  audio?: { url: string; mime: string; size: number };
  durationSec: number;
};

export function trailerIdFor(item: Meta): string | undefined {
  const fromStreams = item.trailerStreams?.find(t => t.ytId)?.ytId;
  if (fromStreams) return fromStreams;
  return item.trailers?.find(t => t.source && (!t.type || t.type === 'Trailer'))?.source;
}

const CLIENT_VERSION = '20.10.4';
const CLIENT = {
  clientName: 'IOS',
  clientVersion: CLIENT_VERSION,
  deviceMake: 'Apple',
  deviceModel: 'iPhone16,2',
  osName: 'iPhone',
  osVersion: '18.3.2.22D82',
  hl: 'en',
  gl: 'US',
};
const USER_AGENT = `com.google.ios.youtube/${CLIENT_VERSION} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`;

type Format = {
  itag?: number;
  url?: string;
  mimeType?: string;
  height?: number;
  bitrate?: number;
  contentLength?: string;
};

// Stream URLs stay valid for about six hours; reuse them well inside that.
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<TrailerStreams | null> }>();

// 720p at most: the hero is a band across the top of the screen, and the
// higher rungs cost bandwidth and decoder time for no visible gain there.
const MAX_HEIGHT = 720;

async function fetchStreams(ytId: string, isSupported: (mime: string) => boolean): Promise<TrailerStreams | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': CLIENT_VERSION,
      },
      body: JSON.stringify({ videoId: ytId, context: { client: CLIENT }, contentCheckOk: true, racyCheckOk: true }),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      playabilityStatus?: { status?: string };
      videoDetails?: { lengthSeconds?: string };
      streamingData?: { adaptiveFormats?: Format[] };
    };
    if (j.playabilityStatus?.status !== 'OK') return null;
    const formats = (j.streamingData?.adaptiveFormats ?? []).filter(f => f.url && f.mimeType && Number(f.contentLength) > 0);

    const video = formats
      .filter(f => f.mimeType!.startsWith('video/mp4') && /avc1/.test(f.mimeType!) && (f.height ?? 0) <= MAX_HEIGHT)
      .filter(f => isSupported(f.mimeType!))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    if (!video) return null;
    const audio = formats
      .filter(f => f.mimeType!.startsWith('audio/mp4') && /mp4a/.test(f.mimeType!))
      .filter(f => isSupported(f.mimeType!))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

    return {
      video: { url: video.url!, mime: video.mimeType!, size: Number(video.contentLength) },
      audio: audio ? { url: audio.url!, mime: audio.mimeType!, size: Number(audio.contentLength) } : undefined,
      durationSec: Number(j.videoDetails?.lengthSeconds) || 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveTrailer(ytId: string, isSupported: (mime: string) => boolean): Promise<TrailerStreams | null> {
  const hit = cache.get(ytId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = fetchStreams(ytId, isSupported);
  cache.set(ytId, { at: Date.now(), value });
  // A failed lookup isn't remembered — the next rest on that title retries.
  value.then(v => {
    if (!v) cache.delete(ytId);
  });
  return value;
}
