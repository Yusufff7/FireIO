# FireIO

A Stremio-style media client for the **Amazon Fire TV Stick**, built for **Vega OS** — Amazon's React Native–based TV platform.

Browse catalogs, search, resume where you left off, and play streams from any Stremio-compatible addon, with a 10-foot D-pad interface designed for a remote.

The interesting part of this project isn't the UI. It's **making MKV seekable on a platform whose native player rejects Matroska seeks outright** — approached with a native C++ module that remuxes Matroska into fragmented MP4 in real time. That's the bulk of the engineering, and it's written up below.

> **Status: work in progress.** MKV playback and seeking work on device: seeking was redesigned around a single absolute timeline and the file's own seek index, and skips, rewinds and long jumps are smooth on a Fire TV Stick. See [Known limitations](#known-limitations) for what's still rough.

---

## Contents

- [What it does](#what-it-does)
- [The hard problem: MKV seeking](#the-hard-problem-mkv-seeking)
- [A smooth 10-foot UI on a 1 GB stick](#a-smooth-10-foot-ui-on-a-1-gb-stick)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Testing without a device](#testing-without-a-device)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)

---

## What it does

| | |
|---|---|
| **Catalogs & search** | Movie/series browsing backed by Stremio addons, on native TV carousels, with a focus-driven hero that updates as you move the D-pad |
| **Trailers** | Rest on a title and its trailer starts in the hero after ~2 s, Netflix-style; open the title and the same playback carries on full screen |
| **Continue Watching** | Per-episode resume with progress bars; resuming re-resolves a current source rather than pinning to a dead link |
| **Playback** | HEVC/H.264 video; AAC, AC-3, E-AC-3, FLAC, Opus and (where the device decodes it) TrueHD audio |
| **Seeking in MKV** | Real-time remux with an absolute timeline and the file's Cues index — instant within what's buffered, one fetch from the right keyframe outside it |
| **Audio tracks** | Switch between an MKV's embedded audio tracks mid-playback, by language — remembered per show, across episodes and resumes |
| **Subtitles** | External (OpenSubtitles-style addons) *and* embedded MKV tracks (SRT/ASS/SSA), with styling and timing offset — the choice is remembered per show too |
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

### First attempt: seek by restarting

`minimp4` originally wrote fragments with no decode timestamp, so the player built its timeline by just adding up fragment durations — bytes from ten minutes in became "the next second of video". The first design worked around that by treating every seek as a **restart**: tear down the remux sessions and the buffered media, open fresh sessions at the target's byte offset (found by a bracketing byte-offset search), and use MSE's `timestampOffset` to place the new zero-based stream.

It worked, but it was never going to feel good:

- **Every seek threw everything away**, even a 10-second skip into media that was already buffered, and re-downloaded it.
- **Finding the target took several sequential probe downloads**, and when the search didn't converge the seek failed and the scrub bar snapped back.
- **It landed on a Cluster, not a keyframe.** Video can only start at a keyframe — often seconds later — so the picture stalled, or ran seconds ahead of the audio and subtitles.
- **Every track was timed by counting** nominal frame durations, so any error in the file's declared frame rate accumulated into audible drift.

### The redesign: one absolute timeline

- **Every sample carries its real media time.** The remuxer writes an explicit decode time (`tfdt`) on each fragment, taken from the Matroska timestamps. One remux session per track lives for the whole playback; whenever the byte offset it's fed jumps, it re-anchors to the real time of the next sample (and video waits for a keyframe). Media from different parts of the file can therefore sit in the `SourceBuffer`s side by side at their true positions — nothing is torn down to seek.
- **Seeking within what's buffered is instant** — the player just moves. That covers most skips, and every rewind within the last 30 seconds.
- **Seeking elsewhere uses the file's own index.** Most MKVs carry a Cues element mapping keyframe times to byte positions. It's located through the SeekHead, read once in the background with a small byte-level EBML reader, and turns a seek into a single fetch starting exactly on the keyframe at or before the target. Files without Cues fall back to the bracketing search, which interpolates between the nearest probes on either side because bitrate varies too much across a file for one global estimate.
- **Both tracks are locked to the container's timestamps.** Audio is checked on every frame and video at every keyframe (where the true frame rate is also re-measured), so a wrong declared frame rate can't drift lip-sync.
- **The player moves once.** `seek()` resolves only when the target is playable, so the playhead never lands in an empty stretch and gets pulled back. A single fetch loop keeps about a minute buffered ahead, relocates whenever the buffer isn't continuous, and evicts media far from the playhead so memory stays bounded.

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

## A smooth 10-foot UI on a 1 GB stick

The second hard problem was making Home feel like a first-party TV app — instant focus, rows that glide, a hero that never waits for its artwork — on a stick with 1 GB of RAM shared with the OS. Almost none of the jank turned out to be where it looked.

- **Memory was the real cause of "slow artwork".** Catalog posters arrive as 500×750 images — 1.5 MB each once decoded — for tiles drawn at 159×213 pixels, and every row kept dozens of them alive. The device log showed the system trimming the app's image cache under memory pressure, so art that had already loaded had to load again. Every image is now requested at the size it's drawn (posters, episode stills and small backdrops each have their own rule), and the backdrops either side of the focused card are fetched ahead of time.
- **Rows are native carousels.** The FlatList rows were replaced with Amazon's Vega Carousel, which recycles a fixed set of item views and runs its scroll animation natively. The focused card stays anchored at the start of the row and the row slides under it.
- **The page moves as one native transform.** The hero used to collapse by animating its `height`, which can't run on the native driver, so every frame re-laid out the page on the JS thread while a ScrollView ran its own, separately timed scroll animation. Now the hero slides and the rows move with transforms on the same duration and easing, and nothing above the rows ever changes size.
- **A D-pad press re-renders almost nothing.** Every row was memoised, but each one received a freshly created ref callback on every render, which quietly defeated the memo, so all nine rows re-rendered on every press. Per-row callbacks are now created once. Rows also stay mounted: an earlier version swapped far-away rows for placeholders, but that put a carousel mount and 15 image decodes in the middle of every vertical move.
- **Trailers play natively, not in a browser.** A WebView playing YouTube's embed spun up a whole browser renderer per trailer and never reached playback before focus moved on. Instead, the app asks YouTube's player API for the direct H.264/AAC streams and feeds them through the same MediaSource pipeline the main player uses, in byte ranges kept ~20 s ahead of the playhead. Loading starts 0.9 s after a card takes focus, so the trailer is ready to start at the 2-second mark rather than only beginning to load then. A single controller owns the trailer's player, which is how opening a title carries the same playback onto the Detail page full screen, and a shared teardown chain stops it from overlapping the main player on the decoder.
- **Opening a title is instant.** Detail draws straight away from the catalog entry Home already has, while the full record (episodes, cast) fills in. That record has usually been fetched already, once focus rested on the card.

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
│  player/trailer…   Trailer playback shared by Home and   │
│                    Detail, on the same MSE pipeline      │
└───────────────────────────┬──────────────────────────────┘
                            │  Kepler TurboModule bridge
┌───────────────────────────▼──────────────────────────────┐
│  MkvDemuxModule (C++)                                    │
│                                                          │
│  parseInitSegment   Tracks, codecs, languages, duration  │
│  findClusters       Cluster offsets + timecodes          │
│  parseCues          Seek index: keyframe time ──▶ bytes  │
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

- **Docker** — the Vega SDK only runs on Linux, so everything builds inside a container ([`docker/`](docker/README.md) has the image and setup)
- A **Fire TV Stick in developer mode**, reachable on your network
- Optionally **Node.js 18+** on the host, for `scripts/check-addons.mjs`

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

> `localDefaults.ts` is **gitignored**, because a configured addon URL usually embeds a personal API key, and anything in it gets compiled into the JS bundle. Leaving the list empty is valid; the app simply starts unconfigured. It's the one file of yours that isn't in the repository, so keep a copy somewhere private.

To see how your addons are doing — whether they list streams, how fast the links answer, and whether those links are really video — run `node scripts/check-addons.mjs` (optionally with a title such as `tt0903747:1:1`). It prints release names only, never URLs.

### 3. Build and install

Set up the build container once, as described in [docker/README.md](docker/README.md). After that, one command builds the native module and the app, packages them, and installs on the stick:

```bash
docker exec vega bash -lc 'cd /work/StremioVega && scripts/build.sh <build-number> <device-ip>:5555'
```

The device only accepts a build number higher than the one it has, so increase it each time. Leave off the device address to just build; the package lands in `build/package/`.

---

## Testing without a device

The native parsing and remuxing logic has **no Kepler dependency**, which is deliberate: it can be compiled and run against real media files on a normal desktop, with no device deploy in the loop. This was the single biggest productivity win on the project — it turned a ~10-minute verify cycle into seconds.

```bash
scripts/test-native.sh
```

That applies a small CMake patch to libmatroska (it otherwise looks for an *installed* libebml rather than the one alongside it) and builds the tools into `MkvDemuxModule/test/build/`. Each prints its usage when run without arguments.

| Tool | What it checks |
|---|---|
| `manual_probe` | Init-segment parsing: tracks, codecs, languages |
| `remux_probe` | Full remux to a real `.mp4`, verifiable with `ffprobe`/`ffmpeg` |
| `seek_probe` | Cluster scanning from hundreds of arbitrary mid-frame offsets |
| `seek_converge` | Whether the seek search actually converges on a target time |
| `seek_e2e` | End-to-end seek: locate, restart, remux, write a playable file |
| `subs_probe` | Embedded subtitle cue extraction |
| `cues_probe` | Seek-index parsing, and one remux session fed across a jump (checks the absolute timeline) |

Building these under AddressSanitizer is how a memory-safety bug in the upstream EBML library was found — an unsigned subtraction that underflowed into a multi-gigabyte `memcpy` whenever parsing started from an arbitrary byte offset, which is exactly what seeking does.

---

## Project layout

```
FireIO/
├── src/                      React Native app
│   ├── addons/               Stremio addon client + stream selection
│   ├── player/               MSE session and seek logic, trailer playback
│   ├── screens/              Home · Detail · Search · Player
│   └── storage/              Settings, history, preferences
├── MkvDemuxModule/           Native C++ turbo module
│   ├── kepler/turbo-modules/ MkvDemuxCore.cpp — parsing + remuxing
│   ├── test/                 Host-side test harness
│   └── third_party/          libebml · libmatroska (submodules) · minimp4
├── docker/                   Build container (Vega SDK runs on Linux)
└── scripts/                  build.sh · test-native.sh · check-addons.mjs · make-icon.py
```

---

## Known limitations

This is an active work in progress, and the MKV pipeline in particular is not finished. The honest current state:

- **Files without a Cues index seek more slowly.** Without one, a seek outside the buffer needs a few probe downloads to find its position, and may land on the next keyframe rather than the one before the target.
- **Some MKV files don't play at all.** Certain encoder/container combinations, and certain audio-track configurations, fail to start. Each one found so far has had a distinct root cause rather than a single shared one, so this is being worked through case by case.
- **DTS audio isn't remuxed, and TrueHD depends on the device.** TrueHD is remuxed, but whether the platform decodes it (rather than only passing it through over HDMI) varies. A file with no audio track the remux path can play falls back to direct-URL playback, which has sound but doesn't seek.
- **Image-based subtitles (PGS, VobSub) aren't supported** — only text formats. Rendering bitmap subtitles is a separate problem.
- **Embedded subtitle cues only exist for territory that's been fetched.** Cues for every text track are collected from each downloaded window, so switching tracks is instant for everything fetched so far — but after a large jump, the skipped-over region has no cues until playback returns to it.
- **Trailers are previews of about a minute.** YouTube serves only the first ~60 seconds of each stream to clients without a proof-of-origin token, refusing any byte range past that point (a freshly resolved URL doesn't reset it), so a trailer plays its first minute and fades back to the artwork. Trailers also rely on YouTube's player API, which isn't a public interface and could change.
- **B-frame presentation timing is approximate.** The remuxer uses each track's nominal constant frame duration rather than full composition-time offsets, which keeps decode order correct at the cost of exact sub-frame display timing.

---

## License

MIT — see [LICENSE](LICENSE).

This is a personal project and is not affiliated with Stremio, Amazon, or any other company. It ships no content and no addon configuration; you supply your own addon URLs.
