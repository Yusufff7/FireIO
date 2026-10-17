import { MediaSource, type SourceBuffer } from '@amazon-devices/react-native-w3cmedia';
import MkvDemuxModule, {
  type MkvDemuxAudioTrack,
  type MkvDemuxCluster,
  type MkvDemuxFindClustersResult,
  type MkvDemuxInitResult,
  type MkvDemuxSubtitleTrack,
} from '@amazon-devices/mkvdemuxmodule';
import { parseCueSegments, type SrtCue } from '../addons/subtitles';
import { bestTrackMatch, type TrackPreference } from '../addons/languages';

// Plays an MKV through MediaSource Extensions by remuxing it to fragmented
// MP4 on the fly, because this platform's native player cannot seek
// Matroska at all (it fails the same way whether handed a URL or raw
// Matroska bytes through MSE — the limitation is in its Matroska parsing,
// not the codecs; HEVC-in-MP4 seeks fine).
//
// How it fits together:
//
//  - MkvDemuxModule keeps ONE remux session per track for the whole
//    playback and stamps every sample with its real media time. Bytes from
//    anywhere in the file can be fed in any order; whenever the byte offset
//    jumps, the session re-anchors (and video waits for a keyframe). So
//    everything appended lands at its true position on a single timeline,
//    and the SourceBuffers can hold several separate stretches of the file
//    at once — no timestampOffset, and nothing torn down to seek.
//
//  - A single fetch loop keeps about a minute buffered ahead of the
//    playhead. It fetches sequentially from a cursor while the data it needs
//    is the continuation of what it last fetched, and otherwise relocates:
//    to the keyframe at or before the time it needs, from the file's Cues
//    index (read once in the background), or — for the minority of files
//    without one — to a Cluster found by a bracketing byte-offset search.
//
//  - seek() moves the playhead straight there when the target is already
//    buffered (most short skips and rewinds: no network at all). Otherwise
//    it relocates, fetches until the target is playable, and only then
//    reports where to land, so the player jumps once, into data it can play.
//
//  - Old data is evicted around the playhead (30s behind, 150s ahead) so the
//    buffers stay bounded however much seeking happens.

const INIT_FETCH_START = 2 * 1024 * 1024;
const INIT_FETCH_MAX = 32 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const SEEK_PROBE_CHUNK = 2 * 1024 * 1024;
const MAX_SEEK_ESTIMATE_ITERATIONS = 6;
const SEEK_TOLERANCE_SEC = 4;
const BUFFER_AHEAD_TARGET_SEC = 60;
const BUFFER_KEEP_BEHIND_SEC = 30;
const BUFFER_KEEP_AHEAD_MAX_SEC = 150;
// Only trim once at least this much is due, so eviction doesn't issue a
// remove() for every half-second of playback.
const EVICT_MIN_SEC = 10;
const LOOP_INTERVAL_MS = 250;
const LOOP_MAX_BACKOFF_MS = 8000;
// The fetch cursor is treated as continuing the buffered range when it
// starts no more than this far past the range's end (a little slack for the
// end of the range being a frame or two short of the next Cluster)...
const CONTIGUOUS_AHEAD_SEC = 2;
// ...or no more than this far before it: right after a relocation the
// cursor sits on a keyframe that can be a whole GOP before the time it was
// relocated for, and re-appending that overlap is harmless.
const CONTIGUOUS_BEHIND_SEC = 30;
// Without a Cues index there's no way to land on a keyframe, so filling a
// buffer onward from a relocation starts this far back to make sure one
// falls before the point being filled — otherwise video would have a gap
// between the end of what's buffered and the next keyframe.
const NO_CUES_KEYFRAME_MARGIN_SEC = 12;
const MAX_CUES_BYTES = 16 * 1024 * 1024;
// A range counts as covering a time within this slack of its edges: the
// first frame of a file typically sits a few tens of ms after zero.
const RANGE_SLACK_SEC = 0.5;

// Matroska CodecIDs MkvDemuxCore's native remuxer actually knows how to
// remux — kept in sync with MkvDemuxCore.cpp's remuxKindForCodecId(). A
// track outside this set means remux (and therefore this whole MSE path)
// isn't attempted; the caller falls back to direct-URL playback, same as
// today's behavior for any other unsupported case.
function isRemuxableVideoCodecId(codecId: string): boolean {
  return codecId === 'V_MPEG4/ISO/AVC' || codecId === 'V_MPEGH/ISO/HEVC';
}
// Candidate RFC 6381 codec strings for each remuxable Matroska audio
// CodecID, in preference order; an empty list means the native remuxer
// can't handle that codec at all. There's more than one per codec because
// isTypeSupported isn't just a table lookup: after the static
// MimeTypeRegistry check (which accepts every string here, case-
// insensitively) it asks the platform decoder-capability query
// (isCodecSupportedByPlatform), whose own spelling rules aren't documented.
// Trying the registry's alternate spelling costs one extra call and means an
// unrecognised spelling can't silently drop a whole track's audio.
function audioCodecCandidates(codecId: string): string[] {
  // AAC-LC: the exact profile can't be told from the CodecID alone, and the
  // registry only lists fully-qualified "mp4a.40.x" strings, never bare "aac".
  if (codecId === 'A_AAC' || codecId.startsWith('A_AAC/')) return ['mp4a.40.2'];
  if (codecId.startsWith('A_AC3')) return ['ac-3', 'mp4a.a5'];
  if (codecId === 'A_EAC3') return ['ec-3', 'mp4a.a6'];
  if (codecId === 'A_FLAC') return ['flac', 'fLaC'];
  if (codecId === 'A_OPUS') return ['opus', 'Opus'];
  // TrueHD's MP4 sample entry — listed by the platform's MP4 audio table.
  // Whether this device can DECODE it (rather than only pass it through
  // over HDMI) is down to the capability query; if it says no, the track is
  // simply unplayable here and prepare() falls back to direct-URL playback.
  if (codecId === 'A_TRUEHD') return ['mlpa'];
  return [];
}

// Memoized: each isTypeSupported call is a synchronous native capability
// query, and the Audio menu asks about every track on every render.
const supportedAudioMimeCache = new Map<string, string | null>();
function supportedAudioMime(codecId: string): string | null {
  const cached = supportedAudioMimeCache.get(codecId);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (const codec of audioCodecCandidates(codecId)) {
    const mime = `audio/mp4; codecs="${codec}"`;
    if (MediaSource.isTypeSupported(mime)) {
      found = mime;
      break;
    }
  }
  supportedAudioMimeCache.set(codecId, found);
  return found;
}

// ASS/SSA Block payloads are "ReadOrder,Layer,Style,Name,MarginL,MarginR,
// MarginV,Effect,Text" — keep the Text field (everything after the 8th
// comma, since Text itself may contain commas), drop {override} blocks, and
// turn \N / \n breaks into real newlines. Mirrors MkvDemuxCore.cpp's
// extractAssDialogueText; done here because cues for every track now come
// back from one native call as raw payloads (see extractEmbeddedCues).
function assDialogueText(payload: string): string {
  let i = 0;
  let commas = 0;
  for (; i < payload.length && commas < 8; i++) {
    if (payload[i] === ',') commas++;
  }
  const text = commas === 8 ? payload.slice(i) : payload;
  return text.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n');
}

function describeRanges(sb: SourceBuffer | null): string {
  if (!sb) return '-';
  try {
    const b = sb.buffered;
    const parts: string[] = [];
    for (let i = 0; i < b.length; i++) parts.push(`${b.start(i).toFixed(1)}-${b.end(i).toFixed(1)}`);
    return parts.length ? parts.join(',') : 'empty';
  } catch {
    return '?';
  }
}

// MkvDemuxCore's videoCodecFamily() emits bare MSE codec family tags
// ("hev1", "avc1") with no RFC 6381 profile/level suffix. The platform's
// SourceBuffer codec check (MimeTypeRegistry.checkSupportedType, read
// directly from node_modules) does a prefix match for video codecs, so a
// bare tag matches fine. Audio is an EXACT match instead, hence
// audioCodecCandidates above working from the CodecID.
function videoCodecsParam(family: string): string | null {
  return family === 'avc1' || family === 'hev1' ? family : null;
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
type Range = { start: number; end: number };
type Position = { offset: number; sec: number };

function rangesOf(sb: SourceBuffer | null): Range[] {
  if (!sb) return [];
  try {
    const b = sb.buffered;
    const out: Range[] = [];
    for (let i = 0; i < b.length; i++) out.push({ start: b.start(i), end: b.end(i) });
    return out;
  } catch {
    return [];
  }
}

function intersectRanges(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out;
}

function rangeContaining(t: number, ranges: Range[]): Range | undefined {
  return ranges.find(r => t >= r.start - RANGE_SLACK_SEC && t <= r.end + RANGE_SLACK_SEC);
}

// Total byte size (header included) of the EBML element starting at
// bytes[0], or undefined if the header isn't complete or isn't valid.
function ebmlElementSize(bytes: Uint8Array): number | undefined {
  const vintLength = (b: number) => {
    for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1;
    return 0;
  };
  const idLen = vintLength(bytes[0] ?? 0);
  if (idLen === 0 || idLen > 4 || bytes.length < idLen + 1) return undefined;
  const sizeLen = vintLength(bytes[idLen]);
  if (sizeLen === 0 || bytes.length < idLen + sizeLen) return undefined;
  let size = bytes[idLen] & (0xff >> sizeLen);
  for (let i = 1; i < sizeLen; i++) size = size * 256 + bytes[idLen + i];
  return idLen + sizeLen + size;
}

export class MkvMseSession {
  private readonly url: string;
  // Aborts everything for good — owned by dispose().
  private readonly abort = new AbortController();
  // Aborts only the in-flight fetches for the current position; replaced on
  // every relocation, so a slow response for a spot the user has left can't
  // land after the fact.
  private fetchAbort = new AbortController();
  private mediaSource: MediaSource | null = null;
  private videoSourceBuffer: SourceBuffer | null = null;
  private audioSourceBuffer: SourceBuffer | null = null;
  // Every operation on a SourceBuffer (append, remove) goes through its own
  // queue: MSE rejects a new operation while the previous one is updating.
  private videoQueue: Promise<void> = Promise.resolve();
  private audioQueue: Promise<void> = Promise.resolve();

  private videoSessionId = -1;
  private audioSessionId = -1; // -1 whenever audio isn't remuxed
  private activeAudioTrackNumber: number | undefined;
  // Which audio track the audio session plays — the file's default track if
  // this platform can decode it, otherwise the first one it can.
  private audioTrack: MkvDemuxAudioTrack | undefined;

  // Embedded (in-MKV) subtitles. There's no SourceBuffer for these: cues for
  // every text track are harvested from each fetched window (one native
  // pass per window, see extractEmbeddedCues) so that switching tracks is
  // instant for everything fetched so far.
  private activeSubtitleTrack: number | undefined;
  private subtitleTrackIsAss = new Map<number, boolean>();
  // Bitmask of text subtitle track numbers (bit N = track N), passed to
  // native negated — see MkvDemuxModule.cpp's extractTextCues. Built with
  // arithmetic rather than bitwise ops, which truncate to 32 bits in JS.
  private subtitleTrackMask = 0;
  private cuesByTrack = new Map<number, SrtCue[]>();
  private cueKeysByTrack = new Map<number, Set<string>>();

  private initResult: MkvDemuxInitResult | null = null;
  private audioMime: string | null = null;
  private fileSize: number | undefined;
  private initSegmentEnd = 0;
  private timestampScale = 1000000;
  private durationSeconds = 0;

  // The Cues index: keyframe times and the byte offsets of the Clusters that
  // start with them, sorted by time. Empty until loaded (or if the file has
  // none), in which case relocation falls back to `clusters`.
  private keyframes: Position[] = [];
  // Every complete Cluster seen in any fetched window or probe, by offset.
  private clusters = new Map<number, MkvDemuxCluster>();

  // Where the next sequential fetch starts, and the media time its data
  // begins at. Null until relocated somewhere.
  private cursor: Position | null = null;
  // Set by a relocation: the next append is not a continuation of the last
  // one, so each SourceBuffer's parser state is reset first (see appendWindow).
  private discontinuity = false;
  private reachedEof = false;

  private loopHandle: ReturnType<typeof setTimeout> | undefined;
  private loopBusy = false;
  private consecutiveStalls = 0;
  private getCurrentTime: () => number = () => 0;
  // While true the fetch loop stands aside: seek() and switchAudioTrack()
  // own the cursor until they finish.
  private exclusive = false;
  // Bumped by every seek()/switchAudioTrack(), so an overlapping newer call
  // makes an older one abandon its remaining work.
  private generation = 0;
  private disposed = false;
  private lastDiagnosticsAt = 0;
  private evicting = { video: false, audio: false };
  // Where the playhead is about to be. Between seek() resolving and the
  // player's currentTime actually moving, currentTime still reports the OLD
  // position — and judged from there, the media just fetched for the target
  // looks far away, so eviction would delete it and the fetch loop would
  // refill around the wrong spot. The loop uses this instead until the
  // player catches up (or it expires).
  private pendingPosition: { sec: number; until: number } | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get duration(): number {
    return this.durationSeconds;
  }

  // Fetches and parses the init segment, checks this platform's MSE can play
  // the resulting MP4 codecs, attaches a MediaSource to `player`, and buffers
  // the first window. Returns false (after cleaning up) when MSE playback
  // isn't viable for this file; the caller then falls back to direct-URL
  // playback.
  //
  // `preferredAudio` is the show's remembered audio choice (language and
  // track name); it wins over the file's default track when it's playable.
  async prepare(player: PlayerLike, getCurrentTime: () => number, preferredAudio?: TrackPreference): Promise<boolean> {
    try {
      const result = await this.fetchInitSegment();
      if (!result) return false;

      if (!isRemuxableVideoCodecId(result.videoCodecId) || result.videoDefaultDurationNs <= 0) return false;
      const videoParam = videoCodecsParam(result.videoCodec);
      if (!videoParam) return false;
      const videoMime = `video/mp4; codecs="${videoParam}"`;
      if (!MediaSource.isTypeSupported(videoMime)) return false;

      // A file WITH audio but no track this path can play (TrueHD/DTS-only
      // releases, most commonly) goes to direct-URL playback instead: the
      // platform's own Matroska pipeline plays those codecs with sound, it
      // just can't seek — and silent-but-seekable proved the worse trade on
      // device. A file with no audio tracks at all still plays here.
      const audioPick = this.pickAudioTrack(result, preferredAudio);
      if (!audioPick && (result.audioTracks?.length || result.audioCodecId)) {
        console.warn('MkvMseSession: no playable audio track, falling back to direct URL for sound');
        return false;
      }
      this.audioTrack = audioPick?.track;
      this.audioMime = audioPick?.mime ?? null;
      console.warn(
        `MkvMseSession: video ${result.videoCodecId} as ${videoMime}; audio ${
          audioPick ? `track ${audioPick.track.trackNumber} ${audioPick.track.codecId} as ${this.audioMime}` : 'NONE'
        }; cues ${result.cuesPosition >= 0 ? 'present' : 'absent'}`,
      );

      this.initResult = result;
      this.initSegmentEnd = result.initSegmentEnd;
      this.timestampScale = result.timestampScale;
      this.durationSeconds = result.durationSeconds;
      this.getCurrentTime = getCurrentTime;
      this.initSubtitleTracks();
      if (!this.openSessions()) return false;

      const ms = new MediaSource();
      this.mediaSource = ms;
      const opened = new Promise<void>(resolve => {
        const onOpen = () => {
          ms.removeEventListener('sourceopen', onOpen);
          resolve();
        };
        ms.addEventListener('sourceopen', onOpen);
      });
      // Assigning srcObject is what triggers the sourceopen handshake.
      player.srcObject = ms;
      await opened;
      if (this.disposed) return false;

      this.videoSourceBuffer = ms.addSourceBuffer(videoMime);
      if (this.audioMime) this.audioSourceBuffer = ms.addSourceBuffer(this.audioMime);
      if (this.durationSeconds > 0) {
        try {
          ms.duration = this.durationSeconds;
        } catch {
          // Some implementations reject a duration write before the first
          // append; the buffered ranges are what drive playback anyway.
        }
      }

      this.cursor = { offset: this.initSegmentEnd, sec: 0 };
      await this.fetchWindow();
      if (this.disposed) return false;

      this.loadCues(); // background — playback doesn't wait on it
      this.scheduleLoop(LOOP_INTERVAL_MS);
      return true;
    } catch (e) {
      console.warn('MkvMseSession: prepare failed, falling back to direct URL —', e);
      this.dispose();
      return false;
    }
  }

  // Moves playback to `target` (seconds). Returns the position the caller
  // should set currentTime to — `target` itself when it's playable there,
  // otherwise where playback can actually start nearby — or null if the
  // position couldn't be reached at all (the caller should leave currentTime
  // alone).
  async seek(target: number): Promise<number | null> {
    if (this.disposed || !this.videoSourceBuffer) return null;
    const myGeneration = ++this.generation;
    const stale = () => this.generation !== myGeneration || this.disposed;

    // Already buffered: nothing to fetch, the player seeks within what it
    // has. This is most short skips and every rewind within the last 30s.
    const playable = rangeContaining(target, this.playableRanges());
    if (playable && playable.end - target >= 0.5) {
      this.expectPosition(target);
      this.scheduleLoop(0);
      return target;
    }

    this.exclusive = true;
    try {
      this.fetchAbort.abort();
      this.fetchAbort = new AbortController();
      const landing = this.keyframeAtOrBefore(target) ?? (await this.findLandingOffset(target, stale));
      if (!landing || stale()) return null;
      this.relocateTo(landing);

      // Fetch until the target is playable. The landing keyframe can be up
      // to a GOP before the target, so this is usually one or two windows.
      for (let i = 0; i < 8; i++) {
        const outcome = await this.fetchWindow();
        if (stale()) return null;
        if (outcome !== 'appended') break;
        const r = rangeContaining(target, this.playableRanges());
        if (r && r.end - target >= 1) return this.expectPosition(target);
        // Without Cues the landing Cluster may not hold a keyframe before
        // the target, in which case video starts at the next one — after it.
        const after = this.playableRanges().find(x => x.start > target && x.start - target < 20 && x.end - x.start >= 1);
        if (after) return this.expectPosition(after.start);
      }
      const r = rangeContaining(target, this.playableRanges());
      return r ? this.expectPosition(target) : null;
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') console.warn('MkvMseSession: seek failed —', e);
      return null;
    } finally {
      if (!stale()) {
        this.exclusive = false;
        this.scheduleLoop(0);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.fetchAbort.abort();
    if (this.loopHandle !== undefined) clearTimeout(this.loopHandle);
    for (const id of [this.videoSessionId, this.audioSessionId]) {
      if (id >= 0) MkvDemuxModule.closeRemuxSession(id);
    }
    this.videoSessionId = -1;
    this.audioSessionId = -1;
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      // Already closed/errored.
    }
  }

  // ---- tracks ----------------------------------------------------------------

  private openSessions(): boolean {
    const result = this.initResult;
    if (!result) return false;
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
    const audio = this.audioTrack;
    if (this.audioMime && audio) {
      this.audioSessionId = this.openAudioSession(audio);
      this.activeAudioTrackNumber = this.audioSessionId >= 0 ? audio.trackNumber : undefined;
      if (this.audioSessionId < 0) console.warn(`MkvMseSession: native refused audio track ${audio.trackNumber}`);
    }
    return true;
  }

  private openAudioSession(track: MkvDemuxAudioTrack): number {
    return MkvDemuxModule.openRemuxSession(
      track.codecId,
      base64ToArrayBuffer(track.codecPrivateB64),
      track.trackNumber,
      track.sampleRate,
      track.channels,
      this.timestampScale,
      0,
    );
  }

  // The file's default audio track when this platform can decode it,
  // otherwise the first track it can — a dual-audio release whose default
  // track is in an unsupported codec still plays with sound, in its other
  // language. Falls back to the init result's primary fields for a file
  // whose audioTracks list is somehow empty.
  private pickAudioTrack(
    result: MkvDemuxInitResult,
    preferred?: TrackPreference,
  ): { track: MkvDemuxAudioTrack; mime: string } | undefined {
    const tracks: MkvDemuxAudioTrack[] = result.audioTracks?.length
      ? result.audioTracks
      : result.audioCodecId
      ? [
          {
            trackNumber: result.audioTrackNumber,
            codecId: result.audioCodecId,
            codec: result.audioCodec,
            sampleRate: result.audioSampleRate,
            channels: result.audioChannels,
            language: 'und',
            name: '',
            codecPrivateB64: result.audioCodecPrivateB64,
            isDefault: true,
          },
        ]
      : [];
    const playable = tracks.filter(t => supportedAudioMime(t.codecId) !== null);
    const remembered = preferred ? bestTrackMatch(preferred, playable, t => ({ code: t.language, name: t.name })) : undefined;
    const primary = remembered ?? tracks.find(t => t.trackNumber === result.audioTrackNumber);
    const ordered = primary ? [primary, ...tracks.filter(t => t !== primary)] : tracks;
    for (const track of ordered) {
      const mime = supportedAudioMime(track.codecId);
      if (mime) return { track, mime };
      console.warn(`MkvMseSession: audio track ${track.trackNumber} (${track.codecId}, ${track.language}) not playable here`);
    }
    return undefined;
  }

  // Every audio track this platform can actually play, for the Audio menu —
  // so every entry there works when picked.
  getAudioTracks(): MkvDemuxAudioTrack[] {
    return (this.initResult?.audioTracks ?? []).filter(t => supportedAudioMime(t.codecId) !== null);
  }

  getActiveAudioTrackNumber(): number | undefined {
    return this.activeAudioTrackNumber;
  }

  // Switches the embedded audio track in place. Video is untouched: the new
  // track gets its own remux session, its old audio is dropped from just
  // before the playhead onward, and the new audio is filled in from the
  // keyframe at or before the playhead up to the end of what video has
  // buffered. Anything left uncovered is picked up by the fetch loop, which
  // relocates whenever the buffer isn't continuous.
  //
  // A codec change (e.g. AAC <-> AC-3, common for dual-audio releases) needs
  // a new SourceBuffer: one is bound to a single codec for its lifetime.
  async switchAudioTrack(trackNumber: number): Promise<boolean> {
    if (this.disposed || !this.initResult || !this.mediaSource) return false;
    const track = this.initResult.audioTracks.find(t => t.trackNumber === trackNumber);
    if (!track || trackNumber === this.activeAudioTrackNumber) return false;
    const newMime = supportedAudioMime(track.codecId);
    if (!newMime) return false;

    const myGeneration = ++this.generation;
    const stale = () => this.generation !== myGeneration || this.disposed;
    this.exclusive = true;
    try {
      this.fetchAbort.abort();
      this.fetchAbort = new AbortController();
      const cur = this.playhead();
      const from = this.keyframeAtOrBefore(cur) ?? this.knownClusterAtOrBefore(cur) ?? (await this.findLandingOffset(cur, stale));
      if (!from || stale()) return false;

      if (this.audioSessionId >= 0) MkvDemuxModule.closeRemuxSession(this.audioSessionId);
      this.audioSessionId = -1;
      if (newMime !== this.audioMime && this.audioSourceBuffer) {
        try {
          this.mediaSource.removeSourceBuffer(this.audioSourceBuffer);
        } catch {
          // Best-effort — a detached buffer isn't worth failing the switch over.
        }
        this.audioSourceBuffer = null;
        this.audioQueue = Promise.resolve();
      }
      this.audioMime = newMime;
      this.audioSessionId = this.openAudioSession(track);
      if (this.audioSessionId < 0) return false;
      if (!this.audioSourceBuffer) {
        try {
          this.audioSourceBuffer = this.mediaSource.addSourceBuffer(newMime);
        } catch (e) {
          console.warn('MkvMseSession: could not add an audio SourceBuffer mid-playback —', e);
          return false;
        }
      }
      this.audioTrack = track;
      this.activeAudioTrackNumber = trackNumber;

      const sb = this.audioSourceBuffer;
      this.resetParser(sb);
      await this.enqueueRemove(sb, 'audio', Math.max(0, cur - 0.5), this.removeEnd());
      if (stale()) return false;

      const videoEnd = rangeContaining(cur, rangesOf(this.videoSourceBuffer))?.end ?? cur;
      const fillTo = Math.min(videoEnd, cur + BUFFER_AHEAD_TARGET_SEC);
      let offset = from.offset;
      for (let i = 0; i < 60; i++) {
        const audioEnd = rangeContaining(cur, rangesOf(sb))?.end ?? 0;
        if (audioEnd >= fillTo - 0.5) break;
        const end = Math.min(offset + CHUNK_SIZE, this.fileSize ?? Number.MAX_SAFE_INTEGER) - 1;
        if (end < offset) break;
        const { buf } = await this.fetchBytes(offset, end);
        if (stale()) return false;
        if (buf.byteLength === 0) break;
        const result = splitRemuxResult(MkvDemuxModule.remuxChunk(this.audioSessionId, buf, offset));
        if (result.muxed.byteLength > 0) await this.enqueueAppend(sb, 'audio', result.muxed).catch(() => undefined);
        if (stale()) return false;
        if (result.bytesConsumed === 0) break;
        offset += result.bytesConsumed;
      }
      return true;
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') console.warn('MkvMseSession: audio switch failed —', e);
      return false;
    } finally {
      if (!stale()) {
        this.exclusive = false;
        this.scheduleLoop(0);
      }
    }
  }

  // Every text subtitle track in the file (S_TEXT/UTF8, S_TEXT/ASS,
  // S_TEXT/SSA). Image-based tracks (PGS, VobSub) aren't listed.
  getSubtitleTracks(): MkvDemuxSubtitleTrack[] {
    return (this.initResult?.subtitleTracks ?? []).filter(
      t => t.codecId === 'S_TEXT/UTF8' || t.codecId === 'S_TEXT/ASS' || t.codecId === 'S_TEXT/SSA',
    );
  }

  // Picks which embedded track getEmbeddedSubtitleCues returns (null turns
  // embedded subtitles off). `_isAss` is kept for API compatibility; each
  // track's format is known from the init segment.
  selectEmbeddedSubtitleTrack(trackNumber: number | null, _isAss: boolean): void {
    this.activeSubtitleTrack = trackNumber ?? undefined;
  }

  // Live, growing list — read it fresh on each overlay tick.
  getEmbeddedSubtitleCues(): SrtCue[] {
    if (this.activeSubtitleTrack === undefined) return [];
    return this.cuesByTrack.get(this.activeSubtitleTrack) ?? [];
  }

  private initSubtitleTracks(): void {
    this.subtitleTrackIsAss = new Map();
    this.subtitleTrackMask = 0;
    for (const t of this.getSubtitleTracks()) {
      if (t.trackNumber < 1 || t.trackNumber > 52) continue;
      this.subtitleTrackIsAss.set(t.trackNumber, t.codecId !== 'S_TEXT/UTF8');
      this.subtitleTrackMask += 2 ** t.trackNumber;
    }
  }

  private extractEmbeddedCues(input: ArrayBuffer): void {
    if (this.subtitleTrackMask <= 0) return;
    const parsed: { cues?: { track: number; startTicks: number; durationTicks: number; text: string }[] } =
      JSON.parse(MkvDemuxModule.extractTextCues(input, -this.subtitleTrackMask, false));
    if (!parsed.cues?.length) return;
    const touched = new Set<number>();
    for (const c of parsed.cues) {
      const isAss = this.subtitleTrackIsAss.get(c.track);
      if (isAss === undefined) continue;
      const text = isAss ? assDialogueText(c.text) : c.text;
      if (!text.trim()) continue;
      const start = this.toSeconds(c.startTicks);
      const end = start + this.toSeconds(c.durationTicks);
      const key = `${start}|${text}`;
      let keys = this.cueKeysByTrack.get(c.track);
      if (!keys) this.cueKeysByTrack.set(c.track, (keys = new Set()));
      if (keys.has(key)) continue;
      keys.add(key);
      let cues = this.cuesByTrack.get(c.track);
      if (!cues) this.cuesByTrack.set(c.track, (cues = []));
      cues.push({ start, end, text, segments: parseCueSegments(text) });
      touched.add(c.track);
    }
    // Kept sorted for the overlay's binary search; windows can arrive out of
    // order now that seeking fetches from anywhere.
    for (const track of touched) this.cuesByTrack.get(track)!.sort((a, b) => a.start - b.start);
  }

  // ---- fetch loop --------------------------------------------------------------

  private expectPosition(sec: number): number {
    this.pendingPosition = { sec, until: Date.now() + 10000 };
    return sec;
  }

  // The playhead position the loop should work from — see pendingPosition.
  private playhead(): number {
    const actual = this.getCurrentTime();
    const p = this.pendingPosition;
    if (!p) return actual;
    if (Date.now() > p.until || Math.abs(actual - p.sec) < 2) {
      this.pendingPosition = null;
      return actual;
    }
    return p.sec;
  }

  private scheduleLoop(delay: number): void {
    if (this.disposed) return;
    if (this.loopHandle !== undefined) clearTimeout(this.loopHandle);
    this.loopHandle = setTimeout(() => this.loopTick(), delay);
  }

  private async loopTick(): Promise<void> {
    this.loopHandle = undefined;
    if (this.disposed) return;
    if (this.exclusive || this.loopBusy) {
      this.scheduleLoop(LOOP_INTERVAL_MS);
      return;
    }
    this.loopBusy = true;
    let delay = LOOP_INTERVAL_MS;
    try {
      const cur = this.playhead();
      this.logDiagnostics(cur);
      this.evict(cur);
      const outcome = await this.fillStep(cur);
      if (outcome === 'appended') {
        this.consecutiveStalls = 0;
        delay = 0; // keep going until the target is reached
      } else if (outcome === 'stalled') {
        this.consecutiveStalls++;
        delay = Math.min(LOOP_INTERVAL_MS * 2 ** Math.min(this.consecutiveStalls, 5), LOOP_MAX_BACKOFF_MS);
      } else {
        this.consecutiveStalls = 0;
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') console.warn('MkvMseSession: fetch loop error —', e);
    } finally {
      this.loopBusy = false;
    }
    // A seek that started mid-tick owns the cursor now and reschedules the
    // loop itself when it's done.
    if (!this.exclusive) this.scheduleLoop(delay);
  }

  // One step of keeping the buffer ahead of the playhead.
  private async fillStep(cur: number): Promise<'idle' | 'appended' | 'eof' | 'stalled'> {
    const current = rangeContaining(cur, rangesOf(this.videoSourceBuffer));
    if (current && current.end - cur >= BUFFER_AHEAD_TARGET_SEC) return 'idle';
    const need = current ? current.end : cur;
    if (this.durationSeconds > 0 && need >= this.durationSeconds - 0.25) {
      this.markEndOfStream(cur);
      return 'eof';
    }

    const c = this.cursor;
    const continuous = c !== null && c.sec <= need + CONTIGUOUS_AHEAD_SEC && c.sec >= need - CONTIGUOUS_BEHIND_SEC;
    if (!continuous) {
      // Filling onward from the end of a buffered range needs data that
      // starts at a keyframe at or before that end, or video would have a
      // gap up to the next keyframe.
      const landing =
        this.keyframeAtOrBefore(need) ??
        this.knownClusterAtOrBefore(current ? need - NO_CUES_KEYFRAME_MARGIN_SEC : need) ??
        (await this.findLandingOffset(current ? Math.max(0, need - NO_CUES_KEYFRAME_MARGIN_SEC) : need, () => this.exclusive));
      if (this.exclusive) return 'idle';
      if (!landing) return 'stalled';
      this.relocateTo(landing);
    }
    return this.fetchWindow();
  }

  private relocateTo(p: Position): void {
    this.cursor = { offset: p.offset, sec: p.sec };
    this.discontinuity = true;
    this.reachedEof = false;
  }

  private markEndOfStream(cur: number): void {
    // Only once playback is actually near the end: an ended MediaSource has
    // to be reopened before anything else can be appended, and seeking back
    // from the last few seconds is far rarer than from anywhere else.
    if (this.reachedEof || this.durationSeconds - cur > 15) return;
    this.reachedEof = true;
    try {
      if (this.mediaSource?.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      // Already ended/closed.
    }
  }

  // Fetches one window at the cursor and feeds it to every consumer: video
  // and audio remux sessions, the Cluster index, and subtitle extraction.
  // Advances the cursor past the complete Clusters consumed.
  private async fetchWindow(): Promise<'appended' | 'eof' | 'stalled'> {
    const c = this.cursor;
    if (!c) return 'stalled';
    if (this.fileSize !== undefined && c.offset >= this.fileSize) return 'eof';
    let consumed = await this.appendWindow(c, CHUNK_SIZE);
    // An unusually large Cluster can exceed the normal window — retry once
    // with a much bigger one rather than stalling on it.
    if (consumed === 0) consumed = await this.appendWindow(c, CHUNK_SIZE * 6);
    if (consumed > 0) return 'appended';
    return this.fileSize !== undefined && c.offset + CHUNK_SIZE * 6 >= this.fileSize ? 'eof' : 'stalled';
  }

  private async appendWindow(at: Position, size: number): Promise<number> {
    const end = Math.min(at.offset + size, this.fileSize ?? Number.MAX_SAFE_INTEGER) - 1;
    if (end < at.offset) return 0;
    const { buf } = await this.fetchBytes(at.offset, end);
    if (buf.byteLength === 0) return 0;

    // Each native call gets its own copy: the bridge may detach an
    // ArrayBuffer argument, and this one feeds four consumers.
    const audioInput = this.audioSessionId >= 0 && this.audioSourceBuffer ? buf.slice(0) : undefined;
    const clustersInput = buf.slice(0);
    const subtitleInput = this.subtitleTrackMask > 0 ? buf.slice(0) : undefined;

    if (this.discontinuity) {
      // Not a continuation of the last append: reset each SourceBuffer's
      // parser state (abort() clears its "last decode timestamp"), or the
      // platform treats earlier timestamps as time running backwards and
      // stalls. Buffered data is kept — only the parser is reset.
      this.discontinuity = false;
      this.resetParser(this.videoSourceBuffer);
      this.resetParser(this.audioSourceBuffer);
    }

    const video = splitRemuxResult(MkvDemuxModule.remuxChunk(this.videoSessionId, buf, at.offset));
    const appends: Promise<void>[] = [];
    if (video.muxed.byteLength > 0 && this.videoSourceBuffer) {
      appends.push(this.enqueueAppend(this.videoSourceBuffer, 'video', video.muxed));
    }
    // Audio never decides how far the window got (video does): a window
    // with no complete audio Blocks just means nothing for audio this time.
    if (audioInput && this.audioSourceBuffer) {
      const audio = splitRemuxResult(MkvDemuxModule.remuxChunk(this.audioSessionId, audioInput, at.offset));
      if (audio.muxed.byteLength > 0) {
        appends.push(this.enqueueAppend(this.audioSourceBuffer, 'audio', audio.muxed).catch(() => undefined));
      }
    }

    const consumed = video.bytesConsumed;
    let lastClusterSec: number | undefined;
    if (consumed > 0) {
      const parsed: MkvDemuxFindClustersResult = JSON.parse(MkvDemuxModule.findClusters(clustersInput, at.offset));
      for (const cl of parsed.clusters) {
        if (cl.offset + cl.size > at.offset + consumed) continue;
        this.clusters.set(cl.offset, cl);
        lastClusterSec = this.toSeconds(cl.timecode);
      }
    }
    if (subtitleInput) {
      // Subtitles are a nice-to-have; a failure here must never stall playback.
      try {
        this.extractEmbeddedCues(subtitleInput);
      } catch (e) {
        console.warn('MkvMseSession: embedded subtitle extraction failed —', e);
      }
    }
    await Promise.all(appends);
    if (consumed === 0) return 0;

    // Advance the cursor. The media time its data starts at is the end of
    // the video range this window extended.
    // Capped a little past the window's last Cluster: when the window
    // re-covered already-buffered media the range runs on well beyond it,
    // and the cursor must describe where ITS data ends.
    const extended = lastClusterSec !== undefined ? rangeContaining(lastClusterSec, rangesOf(this.videoSourceBuffer)) : undefined;
    if (this.cursor === at) {
      const sec =
        lastClusterSec === undefined ? at.sec : extended ? Math.min(extended.end, lastClusterSec + 10) : lastClusterSec;
      this.cursor = { offset: at.offset + consumed, sec };
    }
    return consumed;
  }

  private async fetchBytes(start: number, end: number): Promise<{ buf: ArrayBuffer }> {
    const { buf, total } = await fetchRange(this.url, start, end, this.fetchAbort.signal);
    if (total !== undefined) this.fileSize = total;
    return { buf };
  }

  // ---- SourceBuffer operations -------------------------------------------------

  private enqueue(which: 'video' | 'audio', op: () => Promise<void>): Promise<void> {
    const prior = which === 'video' ? this.videoQueue : this.audioQueue;
    // Chained whether the previous op succeeded or not, so one failure can't
    // poison every later operation on that buffer.
    const next = prior.catch(() => undefined).then(op);
    if (which === 'video') this.videoQueue = next;
    else this.audioQueue = next;
    return next;
  }

  private enqueueAppend(sb: SourceBuffer, which: 'video' | 'audio', buf: ArrayBuffer): Promise<void> {
    return this.enqueue(which, () => this.runUpdate(sb, () => sb.appendBuffer(buf)));
  }

  private enqueueRemove(sb: SourceBuffer, which: 'video' | 'audio', start: number, end: number): Promise<void> {
    if (end <= start) return Promise.resolve();
    return this.enqueue(which, () => this.runUpdate(sb, () => sb.remove(start, end)));
  }

  // Runs one append/remove and resolves when the buffer reports it done.
  private runUpdate(sb: SourceBuffer, start: () => void): Promise<void> {
    if (this.disposed) return Promise.resolve();
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
        this.reopenIfEnded();
        start();
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  // An ended MediaSource (after endOfStream near the end of the file) must be
  // reopened before its buffers accept anything. Writing timestampOffset is
  // the one operation spec'd to do that without touching any data; it's 0
  // throughout, since every sample already carries its real time.
  private reopenIfEnded(): void {
    if (this.mediaSource?.readyState !== 'ended') return;
    for (const sb of [this.videoSourceBuffer, this.audioSourceBuffer]) {
      try {
        if (sb && !sb.updating) sb.timestampOffset = 0;
      } catch {
        // Not reopenable from here; the append will report it.
      }
    }
    this.reachedEof = false;
  }

  // Queued like any other operation, so it lands after appends already
  // waiting (old-position data) and before the new position's appends —
  // the ordering that keeps the parser from ever seeing time run backwards.
  private resetParser(sb: SourceBuffer | null): void {
    if (!sb) return;
    const which = sb === this.videoSourceBuffer ? 'video' : 'audio';
    this.enqueue(which, async () => {
      this.reopenIfEnded();
      try {
        sb.abort();
      } catch {
        // Throws only when the MediaSource isn't open — nothing to reset.
      }
    }).catch(() => undefined);
  }

  private removeEnd(): number {
    return this.durationSeconds > 0 ? this.durationSeconds + 1 : Number.MAX_SAFE_INTEGER;
  }

  // Drops buffered media far from the playhead: more than 30s behind it, or
  // more than 150s ahead of it (old stretches left behind by seeking).
  private evict(cur: number): void {
    const lo = cur - BUFFER_KEEP_BEHIND_SEC;
    const hi = cur + BUFFER_KEEP_AHEAD_MAX_SEC;
    for (const [sb, which] of [
      [this.videoSourceBuffer, 'video'],
      [this.audioSourceBuffer, 'audio'],
    ] as const) {
      if (!sb || this.evicting[which]) continue;
      const removals: Range[] = [];
      for (const r of rangesOf(sb)) {
        if (r.start < lo && Math.min(r.end, lo) - r.start >= EVICT_MIN_SEC) removals.push({ start: r.start, end: Math.min(r.end, lo) });
        if (r.end > hi && r.end - Math.max(r.start, hi) >= EVICT_MIN_SEC) removals.push({ start: Math.max(r.start, hi), end: r.end });
      }
      if (removals.length === 0) continue;
      this.evicting[which] = true;
      Promise.all(removals.map(r => this.enqueueRemove(sb, which, r.start, r.end).catch(() => undefined))).then(() => {
        this.evicting[which] = false;
      });
    }
  }

  // Ranges where both video and (if present) audio are buffered.
  private playableRanges(): Range[] {
    const video = rangesOf(this.videoSourceBuffer);
    return this.audioSourceBuffer ? intersectRanges(video, rangesOf(this.audioSourceBuffer)) : video;
  }

  // ---- locating positions ------------------------------------------------------

  private toSeconds(timecode: number): number {
    return (timecode * this.timestampScale) / 1e9;
  }

  private keyframeAtOrBefore(t: number): Position | undefined {
    const k = this.keyframes;
    if (k.length === 0 || k[0].sec > t + RANGE_SLACK_SEC) return undefined;
    let lo = 0;
    let hi = k.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (k[mid].sec <= t) lo = mid;
      else hi = mid - 1;
    }
    return k[lo];
  }

  // The nearest known Cluster at or before `t`, if one is close enough to be
  // useful (within the seek tolerance); further back means it's just the
  // last thing downloaded, not a landing point for `t`.
  private knownClusterAtOrBefore(t: number): Position | undefined {
    let best: Position | undefined;
    for (const c of this.clusters.values()) {
      const sec = this.toSeconds(c.timecode);
      if (sec <= t && (!best || sec > best.sec)) best = { offset: c.offset, sec };
    }
    return best && t - best.sec <= SEEK_TOLERANCE_SEC ? best : undefined;
  }

  // Reads the Cues index in the background: a few KB to read the element's
  // size, then the element itself. Until it arrives (or for a file without
  // one) relocation uses the Cluster index and byte-offset search instead.
  private async loadCues(): Promise<void> {
    const init = this.initResult;
    if (!init || init.cuesPosition < 0) return;
    const at = init.segmentDataStart + init.cuesPosition;
    try {
      const head = await fetchRange(this.url, at, at + 65535, this.abort.signal);
      const total = ebmlElementSize(new Uint8Array(head.buf));
      if (total === undefined || total > MAX_CUES_BYTES) return;
      const body = total <= head.buf.byteLength ? head : await fetchRange(this.url, at, at + total - 1, this.abort.signal);
      if (this.disposed) return;
      const parsed: { points?: [number, number, number][] } = JSON.parse(MkvDemuxModule.parseCues(body.buf));
      const points = (parsed.points ?? [])
        .filter(([, track]) => track === init.videoTrackNumber)
        .map(([time, , cluster]) => ({ sec: this.toSeconds(time), offset: init.segmentDataStart + cluster }))
        .sort((a, b) => a.sec - b.sec);
      this.keyframes = points;
      console.warn(`MkvMseSession: seek index loaded, ${points.length} keyframes`);
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') console.warn('MkvMseSession: could not load seek index —', e);
    }
  }

  // Byte-offset search for files without a Cues index: estimate from the
  // target's share of the duration, probe for a Cluster there, and narrow
  // in by interpolating between the closest probes on either side (bitrate
  // varies too much across a file for one global estimate to land well).
  private async findLandingOffset(target: number, stale: () => boolean): Promise<Position | undefined> {
    const known = this.knownClusterAtOrBefore(target);
    if (known) return known;
    if (!(this.durationSeconds > 0) || this.fileSize === undefined) return undefined;
    let lowOffset = this.initSegmentEnd;
    let lowSec = 0;
    let highOffset = this.fileSize;
    let highSec = this.durationSeconds;
    const span = this.fileSize - this.initSegmentEnd;
    let estOffset = Math.round(this.initSegmentEnd + Math.max(0, Math.min(1, target / this.durationSeconds)) * span);
    for (let i = 0; i < MAX_SEEK_ESTIMATE_ITERATIONS; i++) {
      let probe = await this.probeAt(estOffset);
      if (stale()) return undefined;
      if (!probe) {
        probe = await this.probeAt(estOffset, SEEK_PROBE_CHUNK * 6);
        if (stale() || !probe) return undefined;
      }
      if (Math.abs(target - probe.sec) < SEEK_TOLERANCE_SEC && probe.sec <= target + 0.5) return probe;
      if (probe.sec <= target) {
        lowOffset = probe.offset;
        lowSec = probe.sec;
      } else {
        highOffset = probe.offset;
        highSec = probe.sec;
      }
      estOffset =
        highSec > lowSec ? Math.round(lowOffset + ((target - lowSec) * (highOffset - lowOffset)) / (highSec - lowSec)) : lowOffset;
      estOffset = Math.max(this.initSegmentEnd, Math.min(this.fileSize - 1, estOffset));
    }
    // Didn't converge within tolerance: the closest probe at or before the
    // target is still a valid place to start.
    return lowSec > 0 ? { offset: lowOffset, sec: lowSec } : undefined;
  }

  private async probeAt(offset: number, size: number = SEEK_PROBE_CHUNK): Promise<Position | undefined> {
    const start = Math.max(this.initSegmentEnd, Math.floor(offset));
    const end = Math.min(start + size, this.fileSize ?? Number.MAX_SAFE_INTEGER) - 1;
    const { buf } = await this.fetchBytes(start, end);
    if (buf.byteLength === 0) return undefined;
    const parsed: MkvDemuxFindClustersResult = JSON.parse(MkvDemuxModule.findClusters(buf, start));
    if (parsed.clusters.length === 0) return undefined;
    for (const cl of parsed.clusters) this.clusters.set(cl.offset, cl);
    const first = parsed.clusters[0];
    return { offset: first.offset, sec: this.toSeconds(first.timecode) };
  }

  // ---- init segment --------------------------------------------------------------

  private async fetchInitSegment(): Promise<MkvDemuxInitResult | undefined> {
    let fetchSize = INIT_FETCH_START;
    while (fetchSize <= INIT_FETCH_MAX) {
      const { buf, total } = await fetchRange(this.url, 0, fetchSize - 1, this.abort.signal);
      if (total !== undefined) this.fileSize = total;
      // Read before handing `buf` to native, which may detach it.
      const fetchedLength = buf.byteLength;
      const result: MkvDemuxInitResult = JSON.parse(MkvDemuxModule.parseInitSegment(buf));
      if (result.ok) return result;
      // A server that ignores Range (or a tiny file) returns fewer bytes than
      // asked for — growing the window would just refetch the same bytes.
      if (fetchedLength < fetchSize) return undefined;
      fetchSize *= 4;
    }
    return undefined;
  }

  // ---- diagnostics -----------------------------------------------------------------

  // One line every 5s at WARN level: the device throttles an app's INFO
  // logging during playback, WARN survives it.
  private logDiagnostics(cur: number): void {
    const now = Date.now();
    if (now - this.lastDiagnosticsAt < 5000) return;
    this.lastDiagnosticsAt = now;
    console.warn(
      `MkvMseSession: t=${cur.toFixed(1)} ms=${this.mediaSource?.readyState} video=[${describeRanges(
        this.videoSourceBuffer,
      )}] audio=[${describeRanges(this.audioSourceBuffer)}] cursor=${this.cursor?.offset ?? '-'}@${
        this.cursor?.sec.toFixed(1) ?? '-'
      } keyframes=${this.keyframes.length} stalls=${this.consecutiveStalls}`,
    );
  }
}
