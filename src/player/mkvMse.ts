import { MediaSource, type SourceBuffer } from '@amazon-devices/react-native-w3cmedia';
import MkvDemuxModule, {
  type MkvDemuxCluster,
  type MkvDemuxFindClustersResult,
  type MkvDemuxInitResult,
} from '@amazon-devices/mkvdemuxmodule';

// Feeds raw Matroska bytes into a MediaSource/SourceBuffer via HTTP Range
// fetches, instead of handing an MKV URL straight to the player's `.src`.
// This exists because this platform's native progressive-URL pipeline can
// play MKV but cannot reliably SEEK it (confirmed via device logs: a valid,
// in-range, actively-playing MKV instantly rejects seekWithRate with
// "Internal error 0" / "MPB Call failed with code: 50004" — a known
// GStreamer matroskademux-over-HTTP limitation). MSE sidesteps that
// entirely: seeking becomes "make sure the SourceBuffer has data covering
// the target time, then write currentTime" — the native pipeline is never
// asked to seek a raw HTTP stream at all, only to play whatever contiguous
// bytes we've already appended.
//
// The MKV files this targets have no Cues element we read (most releases
// either omit it or place it somewhere we don't bother looking), so there's
// no ready-made time->byte-offset index. Seeking into a not-yet-buffered
// region is handled the same way ExoPlayer's MatroskaExtractor falls back
// when Cues are missing/bad: estimate a byte offset proportionally from
// (targetTime / duration), probe it, and refine from the Cluster timecode
// actually found there.

const INIT_FETCH_START = 2 * 1024 * 1024;
const INIT_FETCH_MAX = 32 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const SEEK_PROBE_CHUNK = 2 * 1024 * 1024;
const MAX_SEEK_ESTIMATE_ITERATIONS = 6;
const SEEK_TOLERANCE_SEC = 4;
const BUFFER_AHEAD_TARGET_SEC = 60;
const BUFFER_KEEP_BEHIND_SEC = 30;
const FORWARD_LOOP_INTERVAL_MS = 500;

// MkvDemuxCore's videoCodecFamily()/audioCodecFamily() emit bare MSE codec
// family tags ("hev1", "ac-3", ...) with no RFC 6381 profile/level suffix.
// The platform's SourceBuffer codec check (MimeTypeRegistry.checkSupportedType,
// read directly from node_modules) does a prefix match for video codecs — a
// bare tag matches fine — but an EXACT match for audio codecs, and its AAC
// table only lists fully-qualified "mp4a.40.x" strings, never bare "aac".
// This maps each family to the exact string the `codecs=` parameter needs,
// returning null for a family with no safe mapping — which also covers
// codecs MkvDemuxCore recognizes from the CodecID but that this platform's
// own registry never lists for Matroska audio at all (confirmed by reading
// supportedAudioMatroskaCodecs: no Opus, no DTS).
function videoCodecsParam(family: string): string | null {
  switch (family) {
    case 'avc1':
    case 'hev1':
    case 'vp09':
    case 'vp08':
    case 'av01':
      return family;
    default:
      return null;
  }
}

function audioCodecsParam(family: string): string | null {
  switch (family) {
    case 'aac':
      return 'mp4a.40.2'; // AAC-LC — can't tell the exact profile from the CodecID alone; this is the common case.
    case 'ac-3':
    case 'ec-3':
    case 'flac':
    case 'mp3':
    case 'mp2':
      return family;
    default:
      return null;
  }
}

// Derived rather than referencing the `AbortSignal` type name directly —
// this codebase's ESLint config recognizes `AbortController` as a global
// (it's used as a value everywhere) but not `AbortSignal`, which only ever
// appears in type position and trips `no-undef`.
type AbortSignalLike = InstanceType<typeof AbortController>['signal'];

function parseContentRangeTotal(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const m = /\/(\d+)\s*$/.exec(headerVal);
  return m ? Number(m[1]) : undefined;
}

async function fetchRange(
  url: string,
  start: number,
  end: number,
  signal: AbortSignalLike,
): Promise<{ buf: ArrayBuffer; total?: number }> {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (!r.ok) throw new Error(`range fetch failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  return { buf, total: parseContentRangeTotal(r.headers.get('content-range')) };
}

type PlayerLike = { srcObject: unknown };

export class MkvMseSession {
  private readonly url: string;
  private readonly abort = new AbortController();
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private appendQueue: Promise<void> = Promise.resolve();

  private fileSize: number | undefined;
  private initSegmentEnd = 0;
  private timestampScale = 1000000;
  private durationSeconds = 0;
  // Every complete Cluster we've ever found, in discovery order — used both
  // to answer "do we already know a byte offset near this timestamp" for a
  // rewind/re-seek, and to refine a proportional estimate for a seek into
  // territory we haven't scanned yet. Small enough for a whole episode
  // (dozens to low hundreds of entries) that a linear scan is fine.
  private clusters: MkvDemuxCluster[] = [];
  // Where the sequential forward-playback loop fetches next. A forward seek
  // that lands ahead of this moves it up; a rewind never moves it back, so
  // the forward loop doesn't re-walk territory it's already passed.
  private nextFetchOffset = 0;
  private lastTrimAt = 0;

  private forwardLoopHandle: ReturnType<typeof setTimeout> | undefined;
  private getCurrentTime: () => number = () => 0;
  private seekInProgress = false;
  private disposed = false;

  constructor(url: string) {
    this.url = url;
  }

  get duration(): number {
    return this.durationSeconds;
  }

  // Fetches and parses the init segment, checks whether this platform's MSE
  // can actually play the codecs involved, and — only if so — attaches a
  // MediaSource to `player`, opens a SourceBuffer, and appends the init
  // segment plus a first data chunk so there's something to play
  // immediately. Returns false (after fully cleaning up) if MSE playback
  // isn't viable for this file; the caller should fall back to its existing
  // direct-URL `.src` path in that case.
  async prepare(player: PlayerLike, getCurrentTime: () => number): Promise<boolean> {
    try {
      const initFetch = await this.fetchInitSegment();
      if (!initFetch) return false;
      const { result, raw } = initFetch;

      const videoParam = videoCodecsParam(result.videoCodec);
      if (!videoParam) return false; // no usable video track — nothing to play regardless of audio
      const audioParam = result.audioCodec ? audioCodecsParam(result.audioCodec) : null;
      const codecsList = [videoParam, audioParam].filter((c): c is string => !!c).join(',');
      const mimeType = `video/x-matroska; codecs="${codecsList}"`;
      if (!MediaSource.isTypeSupported(mimeType)) return false;

      this.initSegmentEnd = result.initSegmentEnd;
      this.timestampScale = result.timestampScale;
      this.durationSeconds = result.durationSeconds;
      this.nextFetchOffset = result.initSegmentEnd;
      this.getCurrentTime = getCurrentTime;

      const ms = new MediaSource();
      this.mediaSource = ms;
      const opened = new Promise<void>(resolve => {
        const onOpen = () => {
          ms.removeEventListener('sourceopen', onOpen);
          resolve();
        };
        ms.addEventListener('sourceopen', onOpen);
      });
      // Assigning srcObject is what triggers the sourceopen handshake —
      // constructing the MediaSource alone does nothing.
      player.srcObject = ms;
      await opened;
      if (this.disposed) return false;

      this.sourceBuffer = ms.addSourceBuffer(mimeType);
      if (this.durationSeconds > 0) {
        try {
          ms.duration = this.durationSeconds;
        } catch {
          // Some implementations reject a duration write before the first
          // append; harmless either way; the sourceBuffer's own buffered
          // ranges are what actually drive playback and seeking.
        }
      }

      await this.enqueueAppend(raw.slice(0, this.initSegmentEnd));
      await this.fetchAndAppendNext();
      if (this.disposed) return false;

      this.startForwardLoop();
      return true;
    } catch (e) {
      console.warn('MkvMseSession: prepare failed, falling back to direct URL —', e);
      this.dispose();
      return false;
    }
  }

  // Makes sure the SourceBuffer has data covering `targetSeconds` (or gets
  // as close as a bounded search can manage) before the caller writes
  // `player.currentTime = targetSeconds`. Deliberately does NOT touch
  // currentTime itself — every seek in this screen funnels through one bare
  // write, established the hard way after pause/play-wrapped and
  // readiness-gated seeks both broke playback; this keeps that contract
  // intact for the MSE path too.
  async prepareForSeek(targetSeconds: number): Promise<void> {
    if (this.disposed || !this.sourceBuffer) return;
    if (this.isBuffered(targetSeconds)) return;

    this.seekInProgress = true;
    try {
      const known = this.findNearestKnownCluster(targetSeconds);
      if (known) {
        await this.fetchAndAppendWindow(known.offset, CHUNK_SIZE);
        return;
      }

      if (this.durationSeconds <= 0 || this.fileSize === undefined) return;
      let estOffset = this.estimateByteOffset(targetSeconds);
      for (let i = 0; i < MAX_SEEK_ESTIMATE_ITERATIONS; i++) {
        const probe = await this.probeAt(estOffset);
        if (!probe) break;
        const diff = targetSeconds - probe.timecodeSec;
        if (Math.abs(diff) < SEEK_TOLERANCE_SEC) {
          await this.fetchAndAppendWindow(probe.offset, CHUNK_SIZE);
          return;
        }
        const bytesPerSec = (this.fileSize - this.initSegmentEnd) / this.durationSeconds;
        estOffset = Math.max(
          this.initSegmentEnd,
          Math.min(this.fileSize - 1, estOffset + diff * bytesPerSec),
        );
      }
      // Ran out of iterations or hit a probe with nothing in it (e.g. right
      // at EOF) — leave it. The forward loop will eventually reach real
      // data and the write below just waits/stalls briefly instead of
      // landing instantly, which is still strictly better than the native
      // pipeline's outright seek failure on this platform.
    } finally {
      this.seekInProgress = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    if (this.forwardLoopHandle !== undefined) clearTimeout(this.forwardLoopHandle);
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      // Already closed/errored — nothing to clean up.
    }
  }

  // ---- init segment ----

  private async fetchInitSegment(): Promise<{ result: MkvDemuxInitResult; raw: ArrayBuffer } | undefined> {
    let fetchSize = INIT_FETCH_START;
    while (fetchSize <= INIT_FETCH_MAX) {
      const { buf, total } = await fetchRange(this.url, 0, fetchSize - 1, this.abort.signal);
      if (total !== undefined) this.fileSize = total;
      const result: MkvDemuxInitResult = JSON.parse(MkvDemuxModule.parseInitSegment(buf));
      if (result.ok) return { result, raw: buf };
      // A server that ignores Range (or a genuinely tiny file) returns fewer
      // bytes than asked for — growing the window further would just
      // refetch the same bytes and loop forever.
      if (buf.byteLength < fetchSize) return undefined;
      fetchSize *= 4;
    }
    return undefined;
  }

  // ---- appending ----

  private enqueueAppend(buf: ArrayBuffer): Promise<void> {
    this.appendQueue = this.appendQueue.then(() => this.appendAndWait(buf));
    return this.appendQueue;
  }

  private appendAndWait(buf: ArrayBuffer): Promise<void> {
    const sb = this.sourceBuffer;
    if (!sb || this.disposed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
      };
      const onUpdateEnd = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('SourceBuffer append error'));
      };
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', onError);
      try {
        sb.appendBuffer(buf);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  // Fetches [offset, offset+size), finds every complete Cluster in it, and
  // appends bytes only up through the end of the LAST complete one — a
  // trailing partial cluster is simply left for the next fetch to pick up
  // fresh, rather than stitching leftover bytes across calls. Advances
  // `nextFetchOffset` only forward, so a rewind's fetch never rewinds the
  // sequential playback cursor.
  private async fetchAndAppendWindow(offset: number, size: number): Promise<MkvDemuxCluster[]> {
    const end = this.fileSize !== undefined ? Math.min(offset + size, this.fileSize) - 1 : offset + size - 1;
    if (end < offset) return [];
    const { buf, total } = await fetchRange(this.url, offset, end, this.abort.signal);
    if (total !== undefined) this.fileSize = total;
    if (buf.byteLength === 0) return [];
    const parsed: MkvDemuxFindClustersResult = JSON.parse(MkvDemuxModule.findClusters(buf, offset));
    if (parsed.clusters.length === 0) return [];
    const last = parsed.clusters[parsed.clusters.length - 1];
    const appendEnd = last.offset + last.size - offset;
    await this.enqueueAppend(buf.slice(0, appendEnd));
    this.clusters.push(...parsed.clusters);
    const newCursor = last.offset + last.size;
    if (newCursor > this.nextFetchOffset) this.nextFetchOffset = newCursor;
    return parsed.clusters;
  }

  private async fetchAndAppendNext(): Promise<'appended' | 'eof' | 'stalled'> {
    const startOffset = this.nextFetchOffset;
    if (this.fileSize !== undefined && startOffset >= this.fileSize) return 'eof';
    let clusters = await this.fetchAndAppendWindow(startOffset, CHUNK_SIZE);
    if (clusters.length === 0) {
      // An unusually large single Cluster can exceed the normal chunk size
      // — retry once with a much bigger window before giving up, rather
      // than silently skipping data.
      clusters = await this.fetchAndAppendWindow(startOffset, CHUNK_SIZE * 6);
    }
    if (clusters.length > 0) return 'appended';
    return this.fileSize !== undefined && startOffset + CHUNK_SIZE * 6 >= this.fileSize ? 'eof' : 'stalled';
  }

  // ---- forward playback loop ----

  private startForwardLoop(): void {
    const tick = async () => {
      if (this.disposed) return;
      if (!this.seekInProgress) {
        try {
          const cur = this.getCurrentTime();
          if (this.bufferedAheadOf(cur) < BUFFER_AHEAD_TARGET_SEC) {
            const outcome = await this.fetchAndAppendNext();
            if (outcome === 'eof') {
              try {
                this.mediaSource?.endOfStream();
              } catch {
                // Already ended/closed.
              }
              return;
            }
            if (outcome === 'stalled') {
              console.warn('MkvMseSession: could not find the next Cluster, stopping forward buffering');
              return;
            }
          }
          this.trimBehind(cur);
        } catch (e) {
          console.warn('MkvMseSession: forward loop error —', e);
        }
      }
      if (!this.disposed) this.forwardLoopHandle = setTimeout(tick, FORWARD_LOOP_INTERVAL_MS);
    };
    this.forwardLoopHandle = setTimeout(tick, FORWARD_LOOP_INTERVAL_MS);
  }

  private bufferedAheadOf(cur: number): number {
    const b = this.sourceBuffer?.buffered;
    if (!b) return 0;
    for (let i = 0; i < b.length; i++) {
      if (cur >= b.start(i) && cur <= b.end(i)) return b.end(i) - cur;
    }
    return 0;
  }

  private trimBehind(cur: number): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const cutoff = cur - BUFFER_KEEP_BEHIND_SEC;
    if (cutoff <= this.lastTrimAt + 10) return; // avoid spamming remove() for tiny increments
    try {
      sb.remove(0, cutoff);
      this.lastTrimAt = cutoff;
    } catch {
      // Not fatal — the buffer just holds more than intended.
    }
  }

  // ---- seeking ----

  private toSeconds(timecode: number): number {
    return (timecode * this.timestampScale) / 1e9;
  }

  private isBuffered(t: number): boolean {
    const b = this.sourceBuffer?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) && t <= b.end(i)) return true;
    }
    return false;
  }

  private findNearestKnownCluster(targetSeconds: number): { offset: number } | undefined {
    let best: { offset: number; sec: number } | undefined;
    for (const c of this.clusters) {
      const sec = this.toSeconds(c.timecode);
      if (sec <= targetSeconds && (!best || sec > best.sec)) best = { offset: c.offset, sec };
    }
    return best;
  }

  private estimateByteOffset(targetSeconds: number): number {
    if (this.fileSize === undefined) return this.nextFetchOffset;
    const span = this.fileSize - this.initSegmentEnd;
    const frac = Math.max(0, Math.min(1, targetSeconds / this.durationSeconds));
    return Math.round(this.initSegmentEnd + frac * span);
  }

  private async probeAt(offset: number): Promise<{ offset: number; timecodeSec: number } | undefined> {
    const clamped = Math.max(this.initSegmentEnd, Math.floor(offset));
    const end = this.fileSize !== undefined ? Math.min(clamped + SEEK_PROBE_CHUNK, this.fileSize) - 1 : clamped + SEEK_PROBE_CHUNK - 1;
    const { buf, total } = await fetchRange(this.url, clamped, end, this.abort.signal);
    if (total !== undefined) this.fileSize = total;
    if (buf.byteLength === 0) return undefined;
    const parsed: MkvDemuxFindClustersResult = JSON.parse(MkvDemuxModule.findClusters(buf, clamped));
    if (parsed.clusters.length === 0) return undefined;
    this.clusters.push(...parsed.clusters);
    const first = parsed.clusters[0];
    return { offset: first.offset, timecodeSec: this.toSeconds(first.timecode) };
  }
}
