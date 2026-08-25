import type { MediaType, Subtitle } from '../types';
import { getSettingsSync } from '../storage/settings';

export async function fetchSubtitles(type: MediaType, id: string): Promise<Subtitle[]> {
  const { opensubtitlesBase } = getSettingsSync();
  try {
    const r = await fetch(`${opensubtitlesBase}/subtitles/${type}/${id}.json`);
    if (!r.ok) return [];
    const body = (await r.json()) as { subtitles?: Subtitle[] };
    const list = body.subtitles ?? [];
    // English first — coverage is thin and sometimes absent entirely
    // (verified: zero for The Matrix), so this just improves the common case.
    return [...list].sort((a, b) => (a.lang === 'eng' ? -1 : 0) - (b.lang === 'eng' ? -1 : 0));
  } catch {
    return [];
  }
}

// Several entries per language, not one. Collapsing to a single file per
// language threw away real choices — an anime title routinely has one "eng"
// track timed to the dub and another timed to the subbed release, and only
// one of them lines up with the audio you're actually playing. Still capped,
// because a popular title can return dozens and each one is a fetch+parse.
const MAX_PER_LANG = 4;

export function pickSubtitleSet(subs: Subtitle[], max = 16): Subtitle[] {
  const perLang = new Map<string, number>();
  const picked: Subtitle[] = [];
  for (const s of subs) {
    const count = perLang.get(s.lang) ?? 0;
    if (count >= MAX_PER_LANG) continue;
    perLang.set(s.lang, count + 1);
    picked.push(s);
    if (picked.length >= max) break;
  }
  return picked;
}

// Distinguishes same-language variants in the picker. The release name is
// the useful part (it's what says "dub" vs the original release), trimmed of
// the extension and truncated so a long filename doesn't blow out the row.
export function subtitleVariantLabel(sub: Subtitle): string | undefined {
  const raw = sub.movieReleaseName ?? sub.subtitleFileName;
  if (!raw) return undefined;
  const cleaned = raw.replace(/\.(srt|vtt|ass|ssa)$/i, '').replace(/[._]+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 42 ? `${cleaned.slice(0, 41)}…` : cleaned;
}

const LANG_NAMES: Record<string, string> = {
  eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
  por: 'Portuguese', pob: 'Portuguese (BR)', rus: 'Russian', jpn: 'Japanese',
  kor: 'Korean', chi: 'Chinese', ara: 'Arabic', hin: 'Hindi', dut: 'Dutch',
  swe: 'Swedish', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish', pol: 'Polish',
  tur: 'Turkish', gre: 'Greek', ell: 'Greek', heb: 'Hebrew', hrv: 'Croatian',
};

export function subtitleLangLabel(lang: string): string {
  return LANG_NAMES[lang] ?? lang.toUpperCase();
}

// One run of cue text with a consistent style — <i>, <b>, <u> are the only
// tags SRT/VTT commonly carry, and they're what the renderer applies.
export type SrtSegment = { text: string; italic?: boolean; bold?: boolean; underline?: boolean };
export type SrtCue = { start: number; end: number; text: string; segments: SrtSegment[] };

function parseTimestamp(ts: string): number | null {
  const m = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const [, h, mi, s, ms] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

const STYLE_TAG_RE = /<\/?(i|b|u)>/gi;

// Any tag that isn't one of the three we style gets dropped, keeping its
// content — e.g. `<font color="#ffff00">text</font>` still shows "text",
// just without the color we don't render. The negative lookahead is what
// keeps <i>/<b>/<u> themselves untouched here so the tokenizer below still
// sees them.
function stripUnsupportedTags(raw: string): string {
  return raw.replace(/<\/?(?!i>|b>|u>)[a-zA-Z][^>]*>/g, '');
}

// Turns "<i>Welcome</i> to the show" into styled runs instead of either
// showing the literal tag characters (the bug this fixes — the tags were
// passed straight through into a single flat Text node) or silently
// discarding the emphasis they were carrying.
export function parseCueSegments(raw: string): SrtSegment[] {
  const segments: SrtSegment[] = [];
  let italic = false;
  let bold = false;
  let underline = false;
  let lastIndex = 0;
  const pushText = (text: string) => {
    if (!text) return;
    segments.push({ text, ...(italic ? { italic: true } : {}), ...(bold ? { bold: true } : {}), ...(underline ? { underline: true } : {}) });
  };
  STYLE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STYLE_TAG_RE.exec(raw))) {
    pushText(raw.slice(lastIndex, match.index));
    lastIndex = STYLE_TAG_RE.lastIndex;
    const closing = match[0].startsWith('</');
    const tag = match[1].toLowerCase();
    if (tag === 'i') italic = !closing;
    else if (tag === 'b') bold = !closing;
    else if (tag === 'u') underline = !closing;
  }
  pushText(raw.slice(lastIndex));
  return segments;
}

// SRT text can also carry ASS-style position tags ("{\an8}") from some
// rippers — not valid cue text, strip them rather than showing literal
// garbage. Runs before the markup parser so it never has to see them.
function cleanCueText(raw: string): string {
  return stripUnsupportedTags(raw.replace(/\{\\an\d\}/g, '')).trim();
}

// Tolerant by design: skip malformed cues rather than throwing, since a
// single bad block (missing index line, truncated timestamp) shouldn't take
// out the whole track.
export function parseSrtCues(input: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blocks = input.replace(/\r/g, '').split(/\n\s*\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.length > 0);
    if (lines.length < 2) continue;
    const timingIdx = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const timingLine = lines[timingIdx];
    if (!timingLine) continue;
    const m = timingLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{1,3})/);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null || end <= start) continue;
    const cleaned = cleanCueText(lines.slice(timingIdx + 1).join('\n'));
    if (!cleaned) continue;
    const segments = parseCueSegments(cleaned);
    // Plain-text fallback, e.g. for anything that just needs to know a cue
    // is non-empty — the tags themselves never end up in it.
    const text = segments.map(s => s.text).join('');
    cues.push({ start, end, text, segments });
  }
  return cues;
}

// Single-byte code-page decode for the non-UTF-8 encodings OpenSubtitles
// reports (CP1252 most commonly, occasionally MacRoman). Only the CP1252
// upper range actually differs from plain Latin-1; everything else maps
// straight through. Good enough for subtitle text — not a full ICU decoder.
const CP1252_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeSingleByte(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b >= 0x80 && b < 0xa0 ? (CP1252_HIGH[b] ?? String.fromCharCode(b)) : String.fromCharCode(b);
  }
  return out;
}

// Fetches and parses one subtitle file's cues, honoring the encoding
// OpenSubtitles reports. Out-of-band URI text tracks are on Vega's
// deprecation path and its supported-MIME list doesn't include SRT at all —
// the documented approach is to parse client-side and feed cues in as
// VTTCue objects, which is what callers do with this.
export async function fetchSrtCues(sub: Subtitle): Promise<SrtCue[]> {
  const r = await fetch(sub.url);
  const encoding = (sub.SubEncoding ?? 'UTF-8').toLowerCase();
  const raw = encoding.includes('utf-8') || encoding.includes('utf8') ? await r.text() : decodeSingleByte(new Uint8Array(await r.arrayBuffer()));
  return parseSrtCues(raw);
}
