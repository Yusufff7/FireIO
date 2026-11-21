import { useEffect, useRef, useState } from 'react';
import { resolveTrailer } from '../../../src/addons/trailers';

// Trailers for the Home hero and the Detail page, played in the browser's
// own <video> with MediaSource — the same approach as the Fire TV app's
// player/trailerController.ts, from the same direct YouTube streams
// (addons/trailers.ts, shared). Main playback uses AVPlay instead; the two
// never run together (the player stops any trailer before it opens).
//
// One trailer at a time, and one <video> element, owned here. Screens host
// it with <TrailerHost>, which moves that element into their own markup —
// moving a playing element doesn't interrupt it, which is how a trailer
// started on Home carries on full screen when its title is opened.
//
// Video and audio are separate fragmented MP4 files, each fed into its own
// SourceBuffer in byte ranges ~20 s ahead of playback, with what has played
// dropped. YouTube serves only about the first minute of each stream to
// clients like this one (a byte range reaching past it is refused whole),
// so a trailer plays that minute and fades back to the artwork.

type Phase = 'loading' | 'ready' | 'playing' | 'ended';
type State = { itemId: string; ytId: string; phase: Phase } | null;

const FIRST_CHUNK = 384 * 1024;
const CHUNK = 1024 * 1024;
const MIN_CHUNK = 32 * 1024;
const AHEAD_SEC = 20;
const KEEP_BEHIND_SEC = 8;
const START_BUFFER_SEC = 1.2;
const START_TIMEOUT_MS = 10000;
const FADE_MS = 600;

let state: State = null;
let video: HTMLVideoElement | null = null;
let cancelCurrent: (() => void) | null = null;
const finished = new Set<string>();
const listeners = new Set<(s: State) => void>();

function publish(next: State) {
  state = next;
  listeners.forEach(l => l(state));
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function bufferedEnd(sb: SourceBuffer): number {
  try {
    const b = sb.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  } catch {
    return 0;
  }
}

function bufferedStart(sb: SourceBuffer): number {
  try {
    const b = sb.buffered;
    return b.length ? b.start(0) : 0;
  } catch {
    return 0;
  }
}

function update(sb: SourceBuffer, run: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('error', fail);
      reject(new Error('SourceBuffer error'));
    };
    sb.addEventListener('updateend', done);
    sb.addEventListener('error', fail);
    try {
      run();
    } catch (e) {
      sb.removeEventListener('updateend', done);
      sb.removeEventListener('error', fail);
      reject(e);
    }
  });
}

export function stopTrailer(): void {
  cancelCurrent?.();
  cancelCurrent = null;
  if (state) publish(null);
}

export function startTrailer(itemId: string, ytId: string, playAt: number): void {
  if (state && state.itemId === itemId && state.ytId === ytId) return;
  stopTrailer();
  if (finished.has(itemId)) return;

  let cancelled = false;
  const ac = new AbortController();
  const el = document.createElement('video');
  el.setAttribute('playsinline', '');
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  el.src = objectUrl;
  video = el;
  let current: NonNullable<State> = { itemId, ytId, phase: 'loading' };
  const set = (phase: Phase) => {
    if (cancelled) return;
    current = { ...current, phase };
    publish(current);
  };
  publish(current);

  let poll: ReturnType<typeof setInterval> | undefined;
  const teardown = () => {
    cancelled = true;
    ac.abort();
    clearTimeout(timeout);
    if (poll) clearInterval(poll);
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {
      // already released
    }
    el.parentNode?.removeChild(el);
    URL.revokeObjectURL(objectUrl);
    if (video === el) video = null;
  };
  cancelCurrent = teardown;

  const end = (why: string) => {
    if (cancelled) return;
    console.log('[trailer]', ytId, why);
    finished.add(itemId);
    set('ended');
    setTimeout(() => {
      if (cancelCurrent === teardown) stopTrailer();
    }, FADE_MS);
  };
  const timeout = setTimeout(() => {
    if (current.phase !== 'playing') end('did not start in time');
  }, Math.max(0, playAt - Date.now()) + START_TIMEOUT_MS);

  type Feed = { sb: SourceBuffer; url: string; size: number; offset: number; done: boolean };
  const pump = async (f: Feed) => {
    let chunk = FIRST_CHUNK;
    while (!cancelled && f.offset < f.size) {
      const t = el.currentTime;
      if (bufferedEnd(f.sb) - t > AHEAD_SEC) {
        const start = bufferedStart(f.sb);
        if (t - start > KEEP_BEHIND_SEC * 2) await update(f.sb, () => f.sb.remove(start, t - KEEP_BEHIND_SEC)).catch(() => {});
        await sleep(500);
        continue;
      }
      const last = Math.min(f.size, f.offset + chunk) - 1;
      const r = await fetch(`${f.url}&range=${f.offset}-${last}`, { signal: ac.signal });
      if (r.status === 403) {
        // Past the ~1 minute YouTube serves (see above): shrink to get as
        // close as possible, then this stream is complete.
        if (chunk <= MIN_CHUNK) break;
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 4));
        continue;
      }
      if (!r.ok) throw new Error(`range ${r.status}`);
      const buf = await r.arrayBuffer();
      if (cancelled) return;
      await update(f.sb, () => f.sb.appendBuffer(buf));
      f.offset = last + 1;
      chunk = CHUNK;
    }
    f.done = true;
  };

  (async () => {
    const streams = await resolveTrailer(ytId, m => MediaSource.isTypeSupported(m));
    if (cancelled) return;
    if (!streams) return end('no playable streams');
    if (ms.readyState !== 'open') {
      await new Promise<void>(resolve => ms.addEventListener('sourceopen', () => resolve(), { once: true } as never));
    }
    if (cancelled) return;
    const feeds: Feed[] = [{ sb: ms.addSourceBuffer(streams.video.mime), ...streams.video, offset: 0, done: false }];
    if (streams.audio) feeds.push({ sb: ms.addSourceBuffer(streams.audio.mime), ...streams.audio, offset: 0, done: false });
    Promise.all(feeds.map(pump))
      .then(() => {
        if (!cancelled && ms.readyState === 'open') ms.endOfStream();
      })
      .catch(e => end(String(e)));

    while (!cancelled && bufferedEnd(feeds[0].sb) < START_BUFFER_SEC) await sleep(100);
    if (cancelled) return;
    set('ready');
    await sleep(Math.max(0, playAt - Date.now()));
    if (cancelled) return;
    try {
      await el.play();
    } catch {
      // Autoplay with sound refused: play muted rather than not at all.
      el.muted = true;
      await el.play().catch(() => end('could not start'));
    }
    poll = setInterval(() => {
      const t = el.currentTime;
      if (current.phase === 'ready' && t > 0.15) set('playing');
      if (feeds.every(f => f.done)) {
        const lastBuffered = Math.min(...feeds.map(f => bufferedEnd(f.sb)));
        if (lastBuffered > 0 && t >= lastBuffered - 0.5) end('preview finished');
      }
    }, 150);
  })().catch(e => end(String(e)));
}

export function useTrailerState(): State {
  const [s, setS] = useState<State>(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

// Shows the trailer when it belongs to `itemId`, fading in once it's
// actually playing and out when it ends.
export function TrailerHost({
  itemId,
  className,
  style,
  onPlayingChange,
}: {
  itemId: string;
  className: string;
  style?: React.CSSProperties;
  onPlayingChange?: (playing: boolean) => void;
}) {
  const s = useTrailerState();
  const mine = s && s.itemId === itemId ? s : null;
  const playing = mine?.phase === 'playing';
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mine && video && host.current && video.parentNode !== host.current) host.current.appendChild(video);
  });

  const cb = useRef(onPlayingChange);
  cb.current = onPlayingChange;
  useEffect(() => {
    cb.current?.(playing);
  }, [playing]);

  if (!mine) return null;
  return <div ref={host} className={playing ? `${className} shown` : className} style={style} />;
}

export function HeroTrailer({ itemId, height }: { itemId: string; height: number }) {
  return <TrailerHost itemId={itemId} className="hero-trailer" style={{ height }} />;
}
