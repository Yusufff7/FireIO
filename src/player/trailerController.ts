import { MediaSource, VideoPlayer, type SourceBuffer } from '@amazon-devices/react-native-w3cmedia';
import { resolveTrailer } from '../addons/trailers';
import { pendingTeardown, trackTeardown } from './sharedDecoder';

// One trailer at a time, owned here rather than by a component, so it can
// outlive the screen that started it: a trailer playing in the Home hero
// keeps playing — same player, no restart — when that title is opened, and
// the Detail screen simply shows it full screen (see TrailerSurface).
//
// Playback is native: VideoPlayer + MediaSource, fed from the direct streams
// resolved in addons/trailers.ts. Video and audio are separate fragmented
// MP4 files, each fed into its own SourceBuffer in byte ranges, kept ~20 s
// ahead of playback with what has played dropped, so a trailer never holds
// more than a few MB in the pipeline.

export type TrailerPhase = 'loading' | 'ready' | 'playing' | 'ended';
export type TrailerState = {
  itemId: string;
  ytId: string;
  // Set once the first seconds are buffered — that is what a TrailerSurface
  // waits for before mounting the video view.
  player: VideoPlayer | null;
  phase: TrailerPhase;
};

// The first range is small so the opening second arrives fast; after that,
// bigger ranges mean fewer requests.
const FIRST_CHUNK_BYTES = 384 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const AHEAD_SEC = 20;
const KEEP_BEHIND_SEC = 8;
const START_BUFFER_SEC = 1.2;
// Gives up on a trailer that hasn't started by then.
const START_TIMEOUT_MS = 10000;
// How long a TrailerSurface takes to fade out once a trailer ends, before
// the player is torn down underneath it.
export const TRAILER_FADE_MS = 450;

let state: TrailerState | null = null;
const listeners = new Set<(s: TrailerState | null) => void>();
// Titles whose trailer has played to the end this session, so they go back
// to the still backdrop instead of starting over.
const finished = new Set<string>();
let cancelCurrent: (() => void) | null = null;
// Mounted TrailerSurfaces. play() waits for at least one: starting a media
// session with no attached display is what the OS kills apps for (see
// PlayerScreen).
let surfaces = 0;
const surfaceWaiters = new Set<() => void>();

function publish(next: TrailerState | null) {
  state = next;
  for (const l of listeners) l(state);
}

export function getTrailer(): TrailerState | null {
  return state;
}

export function subscribeTrailer(fn: (s: TrailerState | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function trailerFinished(itemId: string): boolean {
  return finished.has(itemId);
}

export function surfaceMounted(): () => void {
  surfaces++;
  for (const w of surfaceWaiters) w();
  surfaceWaiters.clear();
  return () => {
    surfaces--;
  };
}

function whenSurface(): Promise<void> {
  if (surfaces > 0) return Promise.resolve();
  return new Promise(resolve => surfaceWaiters.add(resolve));
}

export function stopTrailer(): void {
  cancelCurrent?.();
  cancelCurrent = null;
  if (state) publish(null);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function bufferedEnd(sb: SourceBuffer): number {
  try {
    const b = sb.buffered;
    return b.length > 0 ? b.end(b.length - 1) : 0;
  } catch {
    return 0;
  }
}

function bufferedStart(sb: SourceBuffer): number {
  try {
    const b = sb.buffered;
    return b.length > 0 ? b.start(0) : 0;
  } catch {
    return 0;
  }
}

function runUpdate(sb: SourceBuffer, start: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      sb.removeEventListener('updateend', onEnd);
      sb.removeEventListener('error', onError);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('SourceBuffer update error'));
    };
    sb.addEventListener('updateend', onEnd);
    sb.addEventListener('error', onError);
    try {
      start();
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

// `done`: nothing more will be appended — the end of the file, or the end of
// what YouTube will serve (see pump).
type Feed = { sb: SourceBuffer; url: string; size: number; offset: number; done: boolean };

const MIN_CHUNK_BYTES = 32 * 1024;

// Starts (or keeps) the trailer for `itemId`. Buffering begins immediately;
// play() waits until `playAt` (a Date.now() timestamp), so a caller can
// start loading early and still have the trailer appear at a fixed moment.
export function startTrailer(itemId: string, ytId: string, playAt: number): void {
  if (state && state.itemId === itemId && state.ytId === ytId) return;
  stopTrailer();
  if (finished.has(itemId)) return;

  let cancelled = false;
  let initPromise: Promise<void> | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  const ac = new AbortController();
  const p = new VideoPlayer();
  let current: TrailerState = { itemId, ytId, player: null, phase: 'loading' };
  const update = (patch: Partial<TrailerState>) => {
    if (cancelled) return;
    current = { ...current, ...patch };
    publish(current);
  };
  publish(current);

  const teardown = () => {
    cancelled = true;
    ac.abort();
    clearTimeout(timeout);
    if (poll) clearInterval(poll);
    if (initPromise) {
      trackTeardown(
        initPromise.then(
          () => {
            try {
              p.pause();
            } catch {
              // Never started.
            }
            return p.deinitialize();
          },
          () => undefined,
        ),
      );
    }
  };
  cancelCurrent = teardown;

  // Ended or failed: let surfaces fade out, then release the player.
  const end = (why: string) => {
    if (cancelled) return;
    console.log('[trailer]', ytId, why);
    finished.add(itemId);
    update({ phase: 'ended' });
    setTimeout(() => {
      if (cancelCurrent === teardown) stopTrailer();
    }, TRAILER_FADE_MS);
  };

  const timeout = setTimeout(() => {
    if (current.phase !== 'playing') end('did not start in time');
  }, Math.max(0, playAt - Date.now()) + START_TIMEOUT_MS);

  const now = () => {
    const t = (p as unknown as { currentTime?: number }).currentTime;
    return typeof t === 'number' ? t : 0;
  };

  // YouTube only serves roughly the first minute of each stream to clients
  // without a proof-of-origin token — measured: every client tried gets
  // 403 for any byte range reaching past ~60 s of media (5.25 MB into a
  // 720p video, ~1 MB into its audio), and a freshly resolved URL doesn't
  // reset it. A range crossing that line is refused whole, so on a 403 the
  // request shrinks until it fits, and once even a small one is refused
  // that stream is complete: the trailer plays its first minute — a
  // preview, the same length Netflix's are — and then fades back to the
  // artwork.
  const pump = async (feed: Feed) => {
    let chunk = FIRST_CHUNK_BYTES;
    while (!cancelled && feed.offset < feed.size) {
      const t = now();
      if (bufferedEnd(feed.sb) - t > AHEAD_SEC) {
        const start = bufferedStart(feed.sb);
        if (t - start > KEEP_BEHIND_SEC * 2) {
          await runUpdate(feed.sb, () => feed.sb.remove(start, t - KEEP_BEHIND_SEC)).catch(() => undefined);
        }
        await sleep(500);
        continue;
      }
      const end = Math.min(feed.size, feed.offset + chunk) - 1;
      const r = await fetch(`${feed.url}&range=${feed.offset}-${end}`, { signal: ac.signal });
      if (r.status === 403) {
        if (chunk <= MIN_CHUNK_BYTES) break;
        chunk = Math.max(MIN_CHUNK_BYTES, Math.floor(chunk / 4));
        continue;
      }
      if (!r.ok) throw new Error(`range ${r.status}`);
      const buf = await r.arrayBuffer();
      if (cancelled) return;
      await runUpdate(feed.sb, () => feed.sb.appendBuffer(buf));
      feed.offset = end + 1;
      chunk = CHUNK_BYTES;
    }
    feed.done = true;
  };

  (async () => {
    // Both of these overlap the previous trailer's teardown.
    const [streams] = await Promise.all([
      resolveTrailer(ytId, m => MediaSource.isTypeSupported(m)),
      pendingTeardown(),
    ]);
    if (cancelled) return;
    if (!streams) return end('no playable streams');

    initPromise = p.initialize();
    await initPromise;
    if (cancelled) return;

    const ms = new MediaSource();
    const opened = new Promise<void>(resolve => {
      const onOpen = () => {
        ms.removeEventListener('sourceopen', onOpen);
        resolve();
      };
      ms.addEventListener('sourceopen', onOpen);
    });
    (p as unknown as { srcObject: MediaSource }).srcObject = ms;
    await opened;
    if (cancelled) return;

    const feeds: Feed[] = [{ sb: ms.addSourceBuffer(streams.video.mime), ...streams.video, offset: 0, done: false }];
    if (streams.audio) {
      feeds.push({ sb: ms.addSourceBuffer(streams.audio.mime), ...streams.audio, offset: 0, done: false });
    }
    if (streams.durationSec > 0) {
      try {
        ms.duration = streams.durationSec;
      } catch {
        // Some implementations reject a duration before the first append.
      }
    }

    Promise.all(feeds.map(pump))
      .then(() => {
        if (!cancelled && ms.readyState === 'open') ms.endOfStream();
      })
      .catch(e => end(String(e)));

    while (!cancelled && bufferedEnd(feeds[0].sb) < START_BUFFER_SEC) await sleep(100);
    if (cancelled) return;

    update({ player: p, phase: 'ready' });
    await Promise.all([whenSurface(), sleep(Math.max(0, playAt - Date.now()))]);
    // One frame for the surface to attach before play() reaches native.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (cancelled) return;
    await p.play();

    poll = setInterval(() => {
      const t = now();
      if (current.phase === 'ready' && t > 0.15) update({ phase: 'playing' });
      // The end of what's been buffered once nothing more is coming — the
      // end of the file, or of the ~1 minute YouTube serves.
      if (feeds.every(f => f.done)) {
        const last = Math.min(...feeds.map(f => bufferedEnd(f.sb)));
        if (last > 0 && t >= last - 0.5) end('preview finished');
      }
    }, 150);
  })().catch(e => end(String(e)));
}
