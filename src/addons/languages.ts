// One language identity for tracks that describe their language in very
// different ways. An OpenSubtitles entry says "eng"; an MKV track may say
// "en" (BCP-47), "eng" (ISO 639-2), or carry no code at all ("und") and only
// a name — "English", "Japanese", "日本語", "JPN Stereo". Remembering a
// language per show only works if all of those land on the same key, so
// everything here reduces to ISO 639-1 ("en", "ja") where it can.

const THREE_TO_TWO: Record<string, string> = {
  eng: 'en', jpn: 'ja', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  ita: 'it', por: 'pt', pob: 'pt', rus: 'ru', kor: 'ko', chi: 'zh', zho: 'zh',
  ara: 'ar', hin: 'hi', dut: 'nl', nld: 'nl', swe: 'sv', dan: 'da', nor: 'no',
  nob: 'no', nno: 'no', fin: 'fi', pol: 'pl', tur: 'tr', gre: 'el', ell: 'el',
  heb: 'he', hrv: 'hr', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms',
  ukr: 'uk', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro', bul: 'bg',
  tgl: 'tl', fil: 'tl', per: 'fa', fas: 'fa', cat: 'ca', srp: 'sr', slo: 'sk',
  slk: 'sk', slv: 'sl', est: 'et', lav: 'lv', lit: 'lt', ice: 'is', isl: 'is',
  tam: 'ta', tel: 'te', ben: 'bn', urd: 'ur',
};

// Names and common abbreviations found in track titles, in English and in
// the language itself. Checked as whole words (or exact substrings for
// non-Latin scripts), so "Japanese Stereo" and "[JPN] 2.0" both match.
const NAME_TO_CODE: Array<[RegExp, string]> = [
  [/\b(japanese|jpn|jap|nihongo)\b|日本語/i, 'ja'],
  [/\b(english|eng)\b|英語/i, 'en'],
  [/\b(spanish|espa[nñ]ol|castellano|latino|latin american|esp|spa)\b/i, 'es'],
  [/\b(french|fran[cç]ais|fre|fra|vf|vff)\b/i, 'fr'],
  [/\b(german|deutsch|ger|deu)\b/i, 'de'],
  [/\b(italian|italiano|ita)\b/i, 'it'],
  [/\b(portuguese|portugu[eê]s|brazilian|por|pt-br)\b/i, 'pt'],
  [/\b(russian|rus)\b|русский/i, 'ru'],
  [/\b(korean|kor)\b|한국어/i, 'ko'],
  [/\b(chinese|mandarin|cantonese|chi|zho|chs|cht)\b|中文|简体|繁體|繁体/i, 'zh'],
  [/\b(arabic|ara)\b|العربية/i, 'ar'],
  [/\b(hindi|hin)\b|हिन्दी/i, 'hi'],
  [/\b(thai)\b|ไทย/i, 'th'],
  [/\b(vietnamese|vie)\b|tiếng việt/i, 'vi'],
  [/\b(indonesian|ind)\b|bahasa indonesia/i, 'id'],
  [/\b(turkish|t[uü]rk[cç]e|tur)\b/i, 'tr'],
  [/\b(polish|polski|pol)\b/i, 'pl'],
  [/\b(dutch|nederlands|dut|nld)\b/i, 'nl'],
];

// The language's ISO 639-1 key, from a code (any of the forms above) and/or
// a track name; "" when neither says.
export function canonicalLang(code?: string | null, name?: string | null): string {
  const raw = (code ?? '').trim().toLowerCase();
  if (raw && raw !== 'und' && raw !== 'mul' && raw !== 'zxx') {
    const base = raw.split(/[-_]/)[0];
    if (base.length === 2) return base;
    if (THREE_TO_TWO[base]) return THREE_TO_TWO[base];
    // An unrecognised code may still be a written-out name ("japanese").
    for (const [re, two] of NAME_TO_CODE) if (re.test(raw)) return two;
    return base;
  }
  if (name) for (const [re, two] of NAME_TO_CODE) if (re.test(name)) return two;
  return '';
}

function words(s: string | undefined): Set<string> {
  return new Set((s ?? '').toLowerCase().split(/[\s[\](){}<>\-_.,:;/|&+'"!?#*~]+/).filter(w => w.length > 1));
}

// A remembered track choice: its language, and the track's name to tell
// same-language tracks apart ("Full Subtitles" vs "Signs & Songs", or a
// commentary track).
export type TrackPreference = { lang: string; name?: string };

// The candidate that best matches a remembered choice, or undefined when
// none is in that language. Among same-language candidates the one whose
// name shares the most words with the remembered name wins; ties keep the
// candidates' own order.
export function bestTrackMatch<T>(
  pref: TrackPreference,
  candidates: T[],
  describe: (c: T) => { code?: string | null; name?: string | null },
): T | undefined {
  if (!pref.lang) return undefined;
  const wanted = words(pref.name);
  let best: T | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    const d = describe(c);
    if (canonicalLang(d.code, d.name) !== pref.lang) continue;
    const have = words(d.name ?? undefined);
    let shared = 0;
    for (const w of wanted) if (have.has(w)) shared++;
    const exact = (d.name ?? '').trim().toLowerCase() === (pref.name ?? '').trim().toLowerCase() ? 100 : 0;
    const score = exact + shared;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
