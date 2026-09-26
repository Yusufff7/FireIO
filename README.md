# FireIO

A Stremio-style media client for the **Amazon Fire TV Stick**, built for **Vega OS** — Amazon's React Native–based TV platform.

Browse catalogs, search, resume where you left off, and play streams from any Stremio-compatible addon, with a 10-foot D-pad interface designed for a remote.

The interesting part of this project isn't the UI. It's **making MKV seekable on a platform whose native player rejects Matroska seeks outright** — approached with a native C++ module that remuxes Matroska into fragmented MP4 in real time. That's the bulk of the engineering, and it's written up below.

> **Status: work in progress.** The remuxing pipeline works and MKV plays, but seeking is not yet reliable and some files still fail to start. See [Known limitations](#known-limitations) for the current state.

---

## Contents

- [What it does](#what-it-does)
- [The hard problem: MKV seeking](#the-hard-problem-mkv-seeking)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Testing without a device](#testing-without-a-device)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)

---

## What it does

| | |
|---|---|
| **Catalogs & search** | Movie/series browsing backed by Stremio addons, with a focus-driven hero that updates as you move the D-pad |
| **Continue Watching** | Per-episode resume with progress bars; resuming re-resolves a current source rather than pinning to a dead link |
| **Playback** | HEVC/H.264 video; AAC, AC-3, E-AC-3, FLAC, Opus and (where the device decodes it) TrueHD audio |
| **Seeking in MKV** | Implemented via real-time remux — partially working, see [limitations](#known-limitations) |
| **Audio tracks** | Switch between an MKV's embedded audio tracks mid-playback, by language |
| **Subtitles** | External (OpenSubtitles-style addons) *and* embedded MKV tracks (SRT/ASS/SSA), with styling and timing offset |
| **Backup sources** | A second set of addons to switch to in one press when the service behind your main set is down |
| **Next episode** | Auto-derived from series metadata, so it works when resuming too |
| **Skip intro/outro** | Chapter-aware skip prompts where timing data is available |

---

## The hard problem: MKV seeking

### The symptom

MKV files played fine but **would not seek**. Every fast-forward was rejected instantly by the platform's native player:

```
seekWithRate  Seek failed. Internal error 0
seek: MPB Call failed with code: 50004
```

This happened on valid, in-range, actively-playing files. The equivalent MP4 seeked without complaint.

### The diagnosis

The failure is specific to **Matroska container parsing**, not to the codec — HEVC-in-MP4 seeks correctly on the same hardware. Wrapping the raw Matroska bytes in MediaSource Extensions didn't help either, because MSE still routes through the same underlying demuxer.

It also isn't fixable from JavaScript. So the only path left was to stop handing the platform Matroska at all.

### The solution

A native C++ turbo module (`MkvDemuxModule`) parses the Matroska container directly with `libebml`/`libmatroska`, and repackages the video and audio elementary streams into **fragmented MP4** using `minimp4` — no transcoding, just re-containerisation. That fMP4 is fed to MSE, which seeks correctly.

Three non-obvious problems fell out of this:

**1. Fragments carry no absolute timestamps.** `minimp4` is built without TFDT support, so each fragment's timestamp is just a session-relative counter. Feeding the decoder bytes from ten minutes in simply makes those frames "the next second of video" — which is why early attempts *looked* healthy in logs (position advanced, buffers grew, no errors) while the picture never moved.

So seeking isn't a seek at all. It's a **restart**: tear down the remux session, open a fresh one positioned at the target's byte offset, and use MSE's `timestampOffset` to declare where on the timeline that new zero-based stream belongs.

**2. There's no index to seek with.** Matroska's Cues element is frequently absent or unusable in real-world files. So the target time is converted to a byte offset the way ExoPlayer's Matroska extractor falls back when Cues are missing: estimate proportionally, probe there for a Cluster, then refine from the timecode actually found.

The refinement uses a **bracketing interpolation search** rather than extrapolating from an average bitrate. Real encodes vary 2–3x between static and busy scenes, so a single global average overshoots badly on large jumps; interpolating between two real bracketing samples self-corrects for local bitrate and converges in a handful of probes.

**3. Decoders can't start mid-GOP.** A session opened at an arbitrary byte offset drops frames until it reaches a real keyframe, because anything before that references frames the decoder never saw.

### Audio

Each audio codec needs its own ISOBMFF sample entry and config box, built from whatever the source actually provides:

| Codec | Config box | Source of truth |
|---|---|---|
| AAC | `esds` | `CodecPrivate` (AudioSpecificConfig) |
| AC-3 | `dac3` | Parsed from the bitstream's sync frame — Matroska leaves `CodecPrivate` empty |
| E-AC-3 | `dec3` | Same, from the E-AC-3 BSI |
| FLAC | `dfLa` | `CodecPrivate`'s STREAMINFO block |
| Opus | `dOps` | `CodecPrivate`'s OpusHead — **byte-swapped**, since OpusHead is little-endian (Ogg heritage) and ISOBMFF is big-endian |
| TrueHD | `dmlp` | Parsed from the first access unit carrying a major sync; durations counted per block, since a block packs a variable number of 1/1200 s access units |

Two subtleties worth flagging, because both produce files that look fine and decode to garbage:

- `dfLa` is a **FullBox**; `dac3`, `dec3` and `dOps` are **plain Boxes**. Getting this wrong inserts four phantom bytes and shifts every field after it.
- Opus always decodes at 48 kHz regardless of the rate the container advertises, so the MP4 timescale is pinned to 48000 for Opus tracks.

One more that only showed up on the device: every fragment needs an explicit decode time (`tfdt`) and per-sample durations. Desktop tools infer both when they're missing, so the remuxed audio checked out perfectly offline — but the Fire TV's MSE stack placed every audio fragment at time 0, leaving a zero-length audio buffer that froze playback on the first frame.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  React Native (TypeScript)                               │
│                                                          │
│  screens/          Home · Detail · Search · Player       │
│  addons/           Stremio addon client, stream ranking, │
│                    subtitles, skip times                 │
│  player/mkvMse.ts  MSE session: fetch windows, feed the  │
│                    remuxer, manage SourceBuffers, seek   │
└───────────────────────────┬──────────────────────────────┘
                            │  Kepler TurboModule bridge
┌───────────────────────────▼──────────────────────────────┐
│  MkvDemuxModule (C++)                                    │
│                                                          │
│  parseInitSegment   Tracks, codecs, languages, duration  │
│  findClusters       Cluster offsets + timecodes (seek)   │
│  remuxChunk         Matroska Blocks ──▶ fragmented MP4   │
│  extractTextCues    Embedded subtitle cues               │
│                                                          │
│  libebml · libmatroska · minimp4                         │
└──────────────────────────────────────────────────────────┘
```

Video and audio are remuxed as **two independent fMP4 streams**, each fed to its own `SourceBuffer`, because their sample timing models differ and coupling them means one stalling track can freeze the other.

---

## Getting started

### Prerequisites

- **Vega SDK** (provides the `vega` CLI, cross-compilers, and the device adaptor)
- **Node.js 20+**
- A Fire TV device in developer mode, or the Vega Virtual Device

### 1. Clone with submodules

`libebml` and `libmatroska` are pinned submodules — a plain `git clone` will leave you with an unbuildable native module.

```bash
git clone --recursive https://github.com/Yusufff7/FireIO.git
cd FireIO
```

Already cloned without `--recursive`? Run `git submodule update --init --recursive`.

### 2. Configure your addons

The app ships with no addon URLs baked in. Create your local config from the template:

```bash
cp src/storage/localDefaults.example.ts src/storage/localDefaults.ts
```

Then add your own Stremio-protocol addon URLs:

```ts
export const LOCAL_DEFAULTS = {
  streamAddonUrls: [
    'https://<addon-host>/<config>',
    // ...as many as you like; they're queried in parallel and merged
  ] as string[],
  // Optional: a fallback set the player can switch to (see below).
  backupStreamAddonUrls: [
    'https://<backup-addon-host>/<config>',
  ] as string[],
};
```

Optionally, add a second set under `backupStreamAddonUrls`. When it's non-empty, the player offers a **Use backup sources** switch — on the "trying sources" screen, the no-source error screen, and in the player menu — for when the service behind your main addons is down. The choice is remembered until you switch back.

Nothing in the app depends on *which* addons these are — only that they speak the Stremio stream protocol — so adding or removing one is a config change, not a code change.

> `localDefaults.ts` is **gitignored**, because a configured addon URL usually embeds a personal API key, and anything in it gets compiled into the JS bundle. Leaving the list empty is valid; the app simply starts unconfigured.

### 3. Build and install

```bash
npm install
npm run build                      # builds the JS bundle + native module
vega run-app <path-to-.vpkg> com.yusuf.stremiovega.main --deviceId <device>
```

---

## Testing without a device

The native parsing and remuxing logic has **no Kepler dependency**, which is deliberate: it can be compiled and run against real media files on a normal desktop, with no device deploy in the loop. This was the single biggest productivity win on the project — it turned a ~10-minute verify cycle into seconds.

```bash
cd MkvDemuxModule
# libmatroska looks for an *installed* libebml, which doesn't exist in an
# in-tree build — this makes it use the one built alongside it instead.
git apply patches/libmatroska-in-tree-ebml.patch

cd test && cmake -B build && cmake --build build
```

| Tool | What it checks |
|---|---|
| `manual_probe` | Init-segment parsing: tracks, codecs, languages |
| `remux_probe` | Full remux to a real `.mp4`, verifiable with `ffprobe`/`ffmpeg` |
| `seek_probe` | Cluster scanning from hundreds of arbitrary mid-frame offsets |
| `seek_converge` | Whether the seek search actually converges on a target time |
| `seek_e2e` | End-to-end seek: locate, restart, remux, write a playable file |
| `subs_probe` | Embedded subtitle cue extraction |

Building these under AddressSanitizer is how a memory-safety bug in the upstream EBML library was found — an unsigned subtraction that underflowed into a multi-gigabyte `memcpy` whenever parsing started from an arbitrary byte offset, which is exactly what seeking does.

---

## Project layout

```
FireIO/
├── src/                      React Native app
│   ├── addons/               Stremio addon client + stream selection
│   ├── player/mkvMse.ts      MSE session and seek logic
│   ├── screens/              Home · Detail · Search · Player
│   └── storage/              Settings, history, preferences
└── MkvDemuxModule/           Native C++ turbo module
    ├── kepler/turbo-modules/ MkvDemuxCore.cpp — parsing + remuxing
    ├── test/                 Host-side test harness
    └── third_party/          libebml · libmatroska (submodules) · minimp4
```

---

## Known limitations

This is an active work in progress, and the MKV pipeline in particular is not finished. The honest current state:

- **Seeking in MKV is still unreliable.** The remux-and-restart approach described above works, but not consistently — large jumps in particular can leave playback stalled. The failures traced so far have been in the MSE layer rather than the remuxer (stale coded-frame-processor state surviving a buffer reset, and the fetch loop treating a single bad window as terminal), and fixes for those have landed, but it is not yet dependable.
- **Some MKV files don't play at all.** Certain encoder/container combinations, and certain audio-track configurations, fail to start. Each one found so far has had a distinct root cause rather than a single shared one, so this is being worked through case by case.
- **DTS audio isn't remuxed, and TrueHD depends on the device.** TrueHD is remuxed, but whether the platform decodes it (rather than only passing it through over HDMI) varies. A file with no audio track the remux path can play falls back to direct-URL playback, which has sound but doesn't seek.
- **Image-based subtitles (PGS, VobSub) aren't supported** — only text formats. Rendering bitmap subtitles is a separate problem.
- **Embedded subtitle cues only exist for territory that's been fetched.** Cues for every text track are collected from each downloaded window, so switching tracks is instant for everything fetched so far — but after a large jump, the skipped-over region has no cues until playback returns to it.
- **B-frame presentation timing is approximate.** The remuxer uses each track's nominal constant frame duration rather than full composition-time offsets, which keeps decode order correct at the cost of exact sub-frame display timing.
- **Variable-frame-size audio streams could drift.** Packet duration is read from the first frame and held constant — correct for essentially every real encoder, but not guaranteed by the specs.

---

## License

MIT — see [LICENSE](LICENSE).

This is a personal project and is not affiliated with Stremio, Amazon, or any other company. It ships no content and no addon configuration; you supply your own addon URLs.
