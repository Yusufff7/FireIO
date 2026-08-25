import type { Stream } from '../types';
import { parseReleaseInfo, resolveStream } from './client';

// There's no structured "audio language" field on a stream — scene-tag text
// in the filename/title is the only signal, the same way parseReleaseInfo
// reads resolution/codec/HDR off it. 'dual' also covers multi- and tri-audio
// releases: for selection purposes they're all "more than one track, pick
// whichever the player defaults to" — same situation, same bucket.
export type AudioLanguage = 'dual' | 'jpn' | 'eng' | 'other';

export const LANGUAGE_LABELS: Record<AudioLanguage, string> = {
  dual: 'Dual Audio',
  jpn: 'Japanese',
  eng: 'English',
  other: 'Default',
};

// Not "highest resolution" — 1080p is the real default, with 720p/480p as
// lighter fallbacks.
const RESOLUTION_PRIORITY = ['1080p', '720p', '480p'];

// 2160p saturates the debrid link and stalls far more than the quality gain
// is worth, so it is a genuine last resort — and it has to be last GLOBALLY,
// not last-within-each-language-bucket. Listing it at the tail of the
// resolution order wasn't enough: the walk goes language-first, so a title
// whose preferred-language releases happened to be 2160p-only started on
// 2160p anyway while perfectly good 1080p releases sat in the next language
// bucket. Anime movies hit this constantly, since dual-audio releases of
// those are so often 4K-only. Holding these back until every language has
// been tried at a sane resolution is what actually keeps 2160p last.
const LAST_RESORT_RESOLUTIONS = ['2160p'];

const DUAL_RE = /\bdual[\s._-]?audio\b|\bmulti[\s._-]?audio\b|\btri[\s._-]?audio\b|\bmulti[\s._-]?dub(bed)?\b/i;
const ENG_DUB_RE = /\benglish[\s._-]?(audio|dub(bed)?)\b|\beng(lish)?[\s._-]?dub(bed)?\b|\b100%[\s._-]?english\b/i;

function releaseText(s: Stream): string {
  return `${s.behaviorHints?.filename ?? ''} ${s.name ?? ''} ${s.title ?? ''}`;
}

// Best-effort, same spirit as parseReleaseInfo: read what the release group
// actually wrote rather than guess. `isAnime` is what lets an untagged
// release mean something — by scene convention, an anime rip with neither a
// Dual nor an explicit English-dub tag is a subbed release (Japanese audio,
// English subs), so lack of a tag there is itself the signal. That
// convention doesn't hold for non-anime: an untagged Western release is just
// English, so absence of a tag means nothing distinct to call out.
export function detectAudioLanguage(stream: Stream, isAnime: boolean): AudioLanguage {
  const text = releaseText(stream);
  if (DUAL_RE.test(text)) return 'dual';
  if (ENG_DUB_RE.test(text)) return 'eng';
  return isAnime ? 'jpn' : 'other';
}

function resolutionOf(s: Stream): string {
  return parseReleaseInfo(s).resolution ?? 'other';
}

// MP4 seeks reliably on this platform; MKV does not, regardless of pipeline
// state or readiness — confirmed on real hardware across many releases and
// several device-log traces, right down to the native seek call rejecting
// instantly (`Internal error 0`) on a valid, in-range, actively-PLAYING MKV
// while the equivalent MP4 succeeds. This is a known class of limitation for
// matroskademux over HTTP (seeking depends on a Cues index many "remuxed"
// releases build poorly or place awkwardly), not something fixable from JS.
// So: MP4 goes first within every bucket, MKV/other still fully reachable
// as a fallback — still watchable, just without a working scrub bar.
function isMp4(s: Stream): boolean {
  return parseReleaseInfo(s).container === 'MP4';
}

function languagePriorityFor(isAnime: boolean): AudioLanguage[] {
  // Non-anime content has nothing meaningful in the jpn/dual buckets —
  // they're kept at the tail rather than dropped so a stray dual-audio
  // foreign release is still reachable instead of invisible.
  return isAnime ? ['dual', 'jpn', 'eng', 'other'] : ['other', 'eng', 'dual', 'jpn'];
}

// One pass of the bucket walk: resolution first, MP4 before MKV/other
// within each resolution, language within THAT. Shared by both passes in
// orderCandidates below.
//
// Container outranks language here — deliberately, and only after checking
// what that actually costs. For a real anime title (Jujutsu Kaisen S1E1,
// checked live against Torrentio/Comet's cached results): dual-audio releases
// were 39/39 MKV, English-dub releases were 3/3 MKV, and the only 3 MP4s that
// existed anywhere were sitting in the untagged/Japanese bucket. Since dual
// used to be tried first and always found a playable MKV, the walk never
// even reached those MP4s. And a dual-audio release doesn't actually buy
// anything on this platform — AudioTrackList never populates for progressive
// playback, so the second track was never reachable to switch to anyway.
// So: whichever language it ends up being, an MP4 at this resolution beats
// any MKV at this resolution.
function walkBuckets(allStreams: Stream[], isAnime: boolean, langOrder: AudioLanguage[], used: Set<Stream>): Stream[] {
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
  const walkResolution = (res: string) => {
    for (const lang of langOrder) take(s => resolutionOf(s) === res && isMp4(s) && detectAudioLanguage(s, isAnime) === lang);
    for (const lang of langOrder) take(s => resolutionOf(s) === res && !isMp4(s) && detectAudioLanguage(s, isAnime) === lang);
  };
  for (const res of RESOLUTION_PRIORITY) walkResolution(res);
  walkResolution('other');
  for (const res of LAST_RESORT_RESOLUTIONS) walkResolution(res);

  return ordered;
}

// Every candidate stream, reordered into the full priority walk: resolution
// first (1080p down to 480p, then whatever RESOLUTION_PRIORITY doesn't
// recognise, then 2160p as a genuine last resort), MP4 before MKV/other
// within each resolution, then language within that (dual/multi, then
// Japanese, then English, then whatever's left, for anime; just "everything"
// for non-anime since the buckets don't mean anything there). `streams()`'s
// own quality ordering is the final tiebreaker within a resolution+container
// +language slot.
//
// `preferred` is tried FIRST — as narrowly as given (just that language,
// just that resolution, or both) — and then the walk falls through to the
// normal full default priority for everything else. This is what lets
// Continue Watching and "next episode" say "try to stay at 1080p Dual
// Audio" without hard-failing when that exact combination isn't available
// for this episode/release: they get the preference when possible and a
// sane fallback the rest of the time, rather than a dead end. Every input
// stream ends up in the result exactly once.
export function orderCandidates(
  allStreams: Stream[],
  isAnime: boolean,
  preferred?: { language?: AudioLanguage; resolution?: string },
): Stream[] {
  const used = new Set<Stream>();
  const ordered: Stream[] = [];

  if (preferred?.language || preferred?.resolution) {
    const langs = preferred.language ? [preferred.language] : languagePriorityFor(isAnime);
    const preferredPool = preferred.resolution
      ? allStreams.filter(s => resolutionOf(s) === preferred.resolution)
      : allStreams;
    ordered.push(...walkBuckets(preferredPool, isAnime, langs, used));
  }

  // Fallback pass: full default priority over whatever's left. When no
  // preference was given at all, this pass covers everything and the block
  // above is a no-op — same behavior as before preferences existed.
  ordered.push(...walkBuckets(allStreams, isAnime, languagePriorityFor(isAnime), used));
  return ordered;
}

// Which language/resolution buckets actually have at least one stream —
// what the menu uses so it "only shows what's available", per spec, rather
// than offering a choice that would immediately dead-end.
export function availableLanguages(allStreams: Stream[], isAnime: boolean): AudioLanguage[] {
  const present = new Set(allStreams.map(s => detectAudioLanguage(s, isAnime)));
  return languagePriorityFor(isAnime).filter(l => present.has(l));
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
): Promise<{ stream: Stream; finalUrl: string } | null> {
  for (const s of candidates) {
    const label = s.behaviorHints?.filename || s.title || s.name || 'Unnamed release';
    onAttempt({ label, failed: false });
    try {
      const { finalUrl } = await resolveStream(s);
      if (finalUrl) return { stream: s, finalUrl };
    } catch {
      // fall through — reported as a failed attempt below, then the next
      // candidate gets its turn.
    }
    onAttempt({ label, failed: true });
  }
  return null;
}
