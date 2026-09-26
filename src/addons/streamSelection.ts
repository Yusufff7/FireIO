import type { Stream } from '../types';
import { parseReleaseInfo, resolveStream, type SniffedContainer } from './client';

// Not "highest resolution" — 1080p is the real default, with 720p/480p as
// lighter fallbacks.
const RESOLUTION_PRIORITY = ['1080p', '720p', '480p'];

// 2160p saturates the debrid link and stalls far more than the quality gain
// is worth, so it is a genuine last resort.
const LAST_RESORT_RESOLUTIONS = ['2160p'];

function resolutionOf(s: Stream): string {
  return parseReleaseInfo(s).resolution ?? 'other';
}

// One pass of the bucket walk: resolution only. Shared by both passes in
// orderCandidates below.
//
// This used to also sort MP4 before MKV/other within each resolution (MKV
// seeking was broken on this platform, MP4 wasn't) and bucket by a
// scene-tag-guessed audio language (dual/Japanese/English/other) read out of
// the release filename. Both are gone now: MKV seeking is genuinely fixed
// (MkvMseSession's restart-based remux), which removes the reason to rank
// MP4 first, and MKV releases expose their own real embedded audio tracks —
// see PlayerScreen's Audio Track menu — which makes a filename-guessed
// language bucket at the release-picking level redundant at best and wrong
// at worst (the guess was never more than a heuristic on scene-tag text).
function walkBuckets(allStreams: Stream[], used: Set<Stream>): Stream[] {
  const ordered: Stream[] = [];
  const take = (predicate: (s: Stream) => boolean) => {
    for (const s of allStreams) {
      if (used.has(s) || !predicate(s)) continue;
      ordered.push(s);
      used.add(s);
    }
  };

  // 'other' sits between the ranked resolutions and the last-resort ones: a
  // stream RESOLUTION_PRIORITY doesn't recognise still deserves a shot
  // before falling all the way back to 2160p.
  for (const res of RESOLUTION_PRIORITY) take(s => resolutionOf(s) === res);
  take(s => resolutionOf(s) === 'other');
  for (const res of LAST_RESORT_RESOLUTIONS) take(s => resolutionOf(s) === res);

  return ordered;
}

// Every candidate stream, reordered by resolution: 1080p down to 480p, then
// whatever RESOLUTION_PRIORITY doesn't recognise, then 2160p as a genuine
// last resort. `streams()`'s own quality ordering is the final tiebreaker
// within a resolution slot.
//
// `preferred.resolution` is tried FIRST — as narrowly as given — and then
// the walk falls through to the normal full default priority for everything
// else. This is what lets Continue Watching and "next episode" say "try to
// stay at 1080p" without hard-failing when that exact resolution isn't
// available for this episode/release: they get the preference when possible
// and a sane fallback the rest of the time, rather than a dead end. Every
// input stream ends up in the result exactly once.
export function orderCandidates(allStreams: Stream[], preferred?: { resolution?: string }): Stream[] {
  const used = new Set<Stream>();
  const ordered: Stream[] = [];

  if (preferred?.resolution) {
    const preferredPool = allStreams.filter(s => resolutionOf(s) === preferred.resolution);
    ordered.push(...walkBuckets(preferredPool, used));
  }

  // Fallback pass: full default priority over whatever's left. When no
  // preference was given at all, this pass covers everything and the block
  // above is a no-op — same behavior as before preferences existed.
  ordered.push(...walkBuckets(allStreams, used));
  return ordered;
}

export function availableResolutions(allStreams: Stream[]): string[] {
  const present = new Set(allStreams.map(resolutionOf));
  const ranked = [...RESOLUTION_PRIORITY, ...LAST_RESORT_RESOLUTIONS];
  const known = ranked.filter(r => present.has(r));
  // 2160p is still offered here even though the automatic walk avoids it —
  // the menu is an explicit choice, and asking for it on purpose is
  // different from being dropped onto it.
  const unknown = [...present].filter(r => !ranked.includes(r));
  return [...known, ...unknown];
}

export type ResolveAttempt = { label: string; failed: boolean };

// Walks the ordered candidate list, resolving each in turn until one
// succeeds. `onAttempt` fires before each try (failed: false) so the caller
// can show "Trying source: X", and again if that attempt didn't pan out
// (failed: true) so it can show "X failed" before the next one starts.
export async function resolveFirstWorking(
  candidates: Stream[],
  onAttempt: (attempt: ResolveAttempt) => void,
): Promise<{ stream: Stream; finalUrl: string; container?: SniffedContainer } | null> {
  for (const s of candidates) {
    const label = s.behaviorHints?.filename || s.title || s.name || 'Unnamed release';
    onAttempt({ label, failed: false });
    try {
      const { finalUrl, container } = await resolveStream(s);
      if (finalUrl) return { stream: s, finalUrl, container };
    } catch (e) {
      // Reported as a failed attempt below, then the next candidate gets its
      // turn. Logged at WARN (the device throttles INFO) with the reason, so
      // a skipped source can actually be diagnosed afterwards — the label
      // is the release name, never the URL, which carries access tokens.
      const reason = (e as { name?: string })?.name === 'AbortError' ? 'timed out' : String((e as Error)?.message ?? e);
      console.warn(`resolve: skipped "${label.replace(/\s+/g, ' ').slice(0, 120)}" — ${reason.slice(0, 160)}`);
    }
    onAttempt({ label, failed: true });
  }
  return null;
}
