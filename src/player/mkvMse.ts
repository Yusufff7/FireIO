import { MediaSource, type SourceBuffer } from '@amazon-devices/react-native-w3cmedia';
import MkvDemuxModule, {
  type MkvDemuxCluster,
  type MkvDemuxFindClustersResult,
  type MkvDemuxInitResult,
} from '@amazon-devices/mkvdemuxmodule';

// Feeds a remuxed fragmented-MP4 stream into a MediaSource, instead of
// handing an MKV URL straight to the player's `.src` — or, as an earlier
// version of this file did, feeding raw Matroska bytes into an MSE
// SourceBuffer directly.
//
// That raw-Matroska approach played back fine but did NOT fix seeking:
// device testing showed the exact same native failure (`Internal error 0` /
// `MPB Call failed with code: 50004`) through MSE as over a plain
// progressive URL, and a follow-up test proved it wasn't a codec issue
// either (HEVC-in-MP4 seeks correctly on this platform). The failure is
// specific to Matroska container parsing, at a layer MSE's own
// `video/x-matroska` SourceBuffer still has to go through internally —
// wrapping the bytes in MSE never bypassed it.
//
// So this module now remuxes MKV into fragmented MP4 on the fly (via
// MkvDemuxModule's openRemuxSession/remuxChunk, one independent session per
// track — see MkvDemuxCore.h's comment on openRemuxSession for why video
// and audio are two completely separate fMP4 streams, each fed to its own
// SourceBuffer) and feeds THAT to MSE, since MP4 is what's confirmed to
// seek correctly here.
//
// Cues (a time->byte-offset index) still isn't something these files
// reliably have, so seeking into a not-yet-buffered region is handled the
// same way ExoPlayer's MatroskaExtractor falls back when Cues are missing:
// estimate a byte offset proportionally from (targetTime / duration),
// probe it via findClusters (unrelated to remuxing — just Cluster
// boundaries and timecodes, cheap to call speculatively), and refine from
// the Cluster timecode actually found there.

const INIT_FETCH_START = 2 * 1024 * 1024;
const INIT_FETCH_MAX = 32 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const SEEK_PROBE_CHUNK = 2 * 1024 * 1024;
const MAX_SEEK_ESTIMATE_ITERATIONS = 6;
const SEEK_TOLERANCE_SEC = 4;
const BUFFER_AHEAD_TARGET_SEC = 60;
const BUFFER_KEEP_BEHIND_SEC = 30;
const FORWARD_LOOP_INTERVAL_MS = 500;

// Matroska CodecIDs MkvDemuxCore's native remuxer actually knows how to
// remux — kept in sync with MkvDemuxCore.cpp's remuxKindForCodecId(). A
// track outside this set means remux (and therefore this whole MSE path)
// isn't attempted; the caller falls back to direct-URL playback, same as
// today's behavior for any other unsupported case.
function isRemuxableVideoCodecId(codecId: string): boolean {
  return codecId === 'V_MPEG4/ISO/AVC' || codecId === 'V_MPEGH/ISO/HEVC';
}
function isRemuxableAudioCodecId(codecId: string): boolean {
  return codecId === 'A_AAC' || codecId.startsWith('A_AAC/');
}

// MkvDemuxCore's videoCodecFamily()/audioCodecFamily() emit bare MSE codec
// family tags ("hev1", "aac", ...) with no RFC 6381 profile/level suffix.
// The platform's SourceBuffer codec check (MimeTypeRegistry.checkSupportedType,
// read directly from node_modules) does a prefix match for video codecs — a
// bare tag matches fine — but an EXACT match for audio codecs, and its AAC
// table only lists fully-qualified "mp4a.40.x" strings, never bare "aac".
function videoCodecsParam(family: string): string | null {
  return family === 'avc1' || family === 'hev1' ? family : null;
}
function audioCodecsParam(family: string): string | null {
  return family === 'aac' ? 'mp4a.40.2' : null; // AAC-LC — can't tell the exact profile from the CodecID alone; the common case.
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

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of b64) {
    if (c === '=') break;
    const v = table.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes).buffer;
}

// remuxChunk's return layout: 8 bytes little-endian bytesConsumed, then the
// muxed fMP4 bytes for this call — see MkvDemuxCore.h's own comment on it.
function splitRemuxResult(result: ArrayBuffer): { bytesConsumed: number; muxed: ArrayBuffer } {
  const view = new DataView(result);
  const bytesConsumed = Number(view.getBigUint64(0, true));
  return { bytesConsumed, muxed: result.slice(8) };
}

type PlayerLike = { srcObject: unknown };

export class MkvMseSession {
  private readonly url: string;
  private readonly abort = new AbortController();
  private mediaSource: MediaSource | null = null;
  private videoSourceBuffer: SourceBuffer | null = null;
  private audioSourceBuffer: SourceBuffer | null = null;
  private videoAppendQueue: Promise<void> = Promise.resolve();
  private audioAppendQueue: Promise<void> = Promise.resolve();

  private videoSessionId = -1;
  private audioSessionId = -1; // -1 whenever audio isn't remuxed (unsupported codec, or dropped after an isTypeSupported failure)

  private fileSize: number | undefined;
  private initSegmentEnd = 0;
  private timestampScale = 1000000;
  private durationSeconds = 0;
  // Every complete Cluster we've ever found via findClusters, in discovery
  // order — used both to answer "do we already know a byte offset near
  // this timestamp" for a rewind/re-seek, and to refine a proportional
  // estimate for a seek into territory we haven't scanned yet. Purely a
  // timing index; unrelated to which bytes have actually been remuxed and
  // appended. Small enough for a whole episode (dozens to low hundreds of
  // entries) that a linear scan is fine.
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

  // Fetches and parses the init segment, opens a remux session per usable
  // track, checks whether this platform's MSE can actually play the
  // resulting MP4 codecs, and — only if so — attaches a MediaSource to
  // `player`, opens one SourceBuffer per track, and appends the first data
  // chunk so there's something to play immediately. Returns false (after
  // fully cleaning up) if MSE playback isn't viable for this file; the
  // caller should fall back to its existing direct-URL `.src` path in that
  // case.
  async prepare(player: PlayerLike, getCurrentTime: () => number): Promise<boolean> {
    try {
      const initFetch = await this.fetchInitSegment();
      if (!initFetch) return false;
      const { result } = initFetch;

      if (!isRemuxableVideoCodecId(result.videoCodecId) || result.videoDefaultDurationNs <= 0) return false;
      const videoParam = videoCodecsParam(result.videoCodec);
      if (!videoParam) return false;

      this.videoSessionId = MkvDemuxModule.openRemuxSession(
        result.videoCodecId,
        base64ToArrayBuffer(result.videoCodecPrivateB64),
        result.videoTrackNumber,
        result.videoWidth,
        result.videoHeight,
        result.timestampScale,
        result.videoDefaultDurationNs,
      );
      if (this.videoSessionId < 0) return false;

      const videoMime = `video/mp4; codecs="${videoParam}"`;
      if (!MediaSource.isTypeSupported(videoMime)) {
        this.closeSessions();
        return false;
      }

      let audioMime: string | null = null;
      if (isRemuxableAudioCodecId(result.audioCodecId)) {
        const audioParam = audioCodecsParam(result.audioCodec);
        if (audioParam) {
          const candidateMime = `audio/mp4; codecs="${audioParam}"`;
          if (MediaSource.isTypeSupported(candidateMime)) {
            this.audioSessionId = MkvDemuxModule.openRemuxSession(
              result.audioCodecId,
              base64ToArrayBuffer(result.audioCodecPrivateB64),
              result.audioTrackNumber,
              result.audioSampleRate,
              result.audioChannels,
              result.timestampScale,
              0,
            );
            if (this.audioSessionId >= 0) audioMime = candidateMime;
          }
        }
      }
      // No usable audio is a real outcome, not a failure — video-only
      // playback (silent) still beats falling all the way back to
      // direct-URL, since that's where the unfixable seek failure lives.

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

      this.videoSourceBuffer = ms.addSourceBuffer(videoMime);
      if (audioMime) this.audioSourceBuffer = ms.addSourceBuffer(audioMime);
      if (this.durationSeconds > 0) {
        try {
          ms.duration = this.durationSeconds;
        } catch {
          // Some implementations reject a duration write before the first
          // append; harmless either way; each SourceBuffer's own buffered
          // ranges are what actually drive playback and seeking.
        }
      }

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

  // Makes sure the video SourceBuffer has data covering `targetSeconds` (or
  // gets as close as a bounded search can manage) before the caller writes
  // `player.currentTime = targetSeconds`. Deliberately does NOT touch
  // currentTime itself — every seek in this screen funnels through one bare
  // write, established the hard way after pause/play-wrapped and
  // readiness-gated seeks both broke playback; this keeps that contract
  // intact for the MSE path too.
  async prepareForSeek(targetSeconds: number): Promise<void> {
    if (this.disposed || !this.videoSourceBuffer) return;
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
    this.closeSessions();
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      // Already closed/errored — nothing to clean up.
    }
  }

  private closeSessions(): void {
    if (this.videoSessionId >= 0) {
      MkvDemuxModule.closeRemuxSession(this.videoSessionId);
      this.videoSessionId = -1;
    }
    if (this.audioSessionId >= 0) {
      MkvDemuxModule.closeRemuxSession(this.audioSessionId);
      this.audioSessionId = -1;
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

  private enqueueAppend(sb: SourceBuffer, queueField: 'video' | 'audio', buf: ArrayBuffer): Promise<void> {
    const prior = queueField === 'video' ? this.videoAppendQueue : this.audioAppendQueue;
    const next = prior.then(() => this.appendAndWait(sb, buf));
    if (queueField === 'video') this.videoAppendQueue = next;
    else this.audioAppendQueue = next;
    return next;
  }

  private appendAndWait(sb: SourceBuffer, buf: ArrayBuffer): Promise<void> {
    if (this.disposed || buf.byteLength === 0) return Promise.resolve();
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

  // Fetches [offset, offset+size) ONCE and feeds the same bytes through
  // both the video and (if present) audio remux sessions — each session
  // independently finds its own track's Blocks within whatever complete
  // Clusters are in this window and mux them into fMP4, reported back via
  // remuxChunk's bytesConsumed. The window's true "fully processed" point
  // is the MINIMUM of the two sessions' progress (whichever session found
  // fewer complete Blocks defines how far this fetch can safely be
  // considered consumed) — advances `nextFetchOffset` only forward, so a
  // rewind's fetch never rewinds the sequential playback cursor.
  private async fetchAndAppendWindow(offset: number, size: number): Promise<boolean> {
    const end = this.fileSize !== undefined ? Math.min(offset + size, this.fileSize) - 1 : offset + size - 1;
    if (end < offset) return false;
    const { buf, total } = await fetchRange(this.url, offset, end, this.abort.signal);
    if (total !== undefined) this.fileSize = total;
    if (buf.byteLength === 0) return false;

    const videoResult = splitRemuxResult(MkvDemuxModule.remuxChunk(this.videoSessionId, buf, offset));
    let consumed = videoResult.bytesConsumed;
    if (videoResult.muxed.byteLength > 0 && this.videoSourceBuffer) {
      await this.enqueueAppend(this.videoSourceBuffer, 'video', videoResult.muxed);
    }

    if (this.audioSessionId >= 0 && this.audioSourceBuffer) {
      const audioResult = splitRemuxResult(MkvDemuxModule.remuxChunk(this.audioSessionId, buf, offset));
      consumed = Math.min(consumed, audioResult.bytesConsumed);
      if (audioResult.muxed.byteLength > 0) {
        await this.enqueueAppend(this.audioSourceBuffer, 'audio', audioResult.muxed);
      }
    }

    if (consumed === 0) return false;

    // findClusters is unrelated to remuxing but cheap (no frame-level
    // parsing, just Cluster boundaries) — calling it on the same bytes
    // keeps the seek-timing index warm as a side effect of normal forward
    // playback, not just during an explicit seek probe.
    const parsed: MkvDemuxFindClustersResult = JSON.parse(MkvDemuxModule.findClusters(buf, offset));
    this.clusters.push(...parsed.clusters.filter(c => c.offset + c.size <= offset + consumed));

    const newCursor = offset + consumed;
    if (newCursor > this.nextFetchOffset) this.nextFetchOffset = newCursor;
    return true;
  }

  private async fetchAndAppendNext(): Promise<'appended' | 'eof' | 'stalled'> {
    const startOffset = this.nextFetchOffset;
    if (this.fileSize !== undefined && startOffset >= this.fileSize) return 'eof';
    let appended = await this.fetchAndAppendWindow(startOffset, CHUNK_SIZE);
    if (!appended) {
      // An unusually large single Cluster can exceed the normal chunk size
      // — retry once with a much bigger window before giving up, rather
      // than silently skipping data.
      appended = await this.fetchAndAppendWindow(startOffset, CHUNK_SIZE * 6);
    }
    if (appended) return 'appended';
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
    const b = this.videoSourceBuffer?.buffered;
    if (!b) return 0;
    for (let i = 0; i < b.length; i++) {
      if (cur >= b.start(i) && cur <= b.end(i)) return b.end(i) - cur;
    }
    return 0;
  }

  private trimBehind(cur: number): void {
    const cutoff = cur - BUFFER_KEEP_BEHIND_SEC;
    if (cutoff <= this.lastTrimAt + 10) return; // avoid spamming remove() for tiny increments
    for (const sb of [this.videoSourceBuffer, this.audioSourceBuffer]) {
      if (!sb || sb.updating) continue;
      try {
        sb.remove(0, cutoff);
      } catch {
        // Not fatal — the buffer just holds more than intended.
      }
    }
    this.lastTrimAt = cutoff;
  }

  // ---- seeking ----

  private toSeconds(timecode: number): number {
    return (timecode * this.timestampScale) / 1e9;
  }

  private isBuffered(t: number): boolean {
    const b = this.videoSourceBuffer?.buffered;
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
