import { useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, MediaType, Meta } from '../../../../src/types';
import type { Nav } from '../App';
import { meta as fetchMeta } from '../../../../src/addons/client';
import { backdropThumb, posterThumb, stillThumb } from '../../../../src/addons/images';
import { trailerIdFor } from '../../../../src/addons/trailers';
import { getHistorySync, progressFractionFor, resumePositionFor } from '../../../../src/storage/history';
import { KEY, useKeys } from '../platform/keys';
import { startTrailer, stopTrailer, TrailerHost, useTrailerState } from '../trailer';

const EPISODE_STRIDE = 140;
const EPISODE_WINDOW = 9;
// Detail's own trailer, when the title wasn't opened with one playing.
const TRAILER_LOAD_MS = 500;
const TRAILER_PLAY_MS = 1500;

// Season 0 is Cinemeta's bucket for specials; it goes last, labelled as such.
const bySeason = (a: number, b: number) => (a === 0 ? 1 : b === 0 ? -1 : a - b);
const seasonLabel = (s: number) => (s === 0 ? 'Specials' : `Season ${s}`);
const episodeTitle = (v: Episode) => v.name ?? v.title ?? `Episode ${v.episode}`;
const aired = (v: Episode) => (v.released ?? v.firstAired ?? '').slice(0, 4);

function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function DetailScreen({
  nav,
  active,
  route,
}: {
  nav: Nav;
  active: boolean;
  route: { id: string; type: MediaType; initial?: Meta };
}) {
  const { id, type, initial } = route;
  const [info, setInfo] = useState<Meta | null>(initial ?? null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMeta(type, id)
      .then(m => {
        if (cancelled) return;
        if (m || type === 'series' || !initial) setInfo(m);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, type]);

  const historyEntry = getHistorySync().find(h => h.id === id);
  const episodes = info?.videos ?? [];
  const seasons = useMemo(() => [...new Set(episodes.map(v => v.season))].sort(bySeason), [episodes]);
  const isSeries = type === 'series' && seasons.length > 0;

  // Starts on the episode you were watching, when there is one.
  const resumeEp = historyEntry?.episodeId ? episodes.find(v => v.id === historyEntry.episodeId) : undefined;
  const [season, setSeason] = useState<number | null>(null);
  const activeSeason = season ?? resumeEp?.season ?? seasons[0] ?? null;
  const seasonEpisodes = useMemo(
    () => episodes.filter(v => v.season === activeSeason).sort((a, b) => a.episode - b.episode),
    [episodes, activeSeason],
  );

  // Focus: 'actions' (the button row) or an episode index.
  const [zone, setZone] = useState<'actions' | 'episodes'>('actions');
  const [epIndex, setEpIndex] = useState(0);
  const [action, setAction] = useState(0);
  const placedRef = useRef(false);
  useEffect(() => {
    if (placedRef.current || !isSeries || seasonEpisodes.length === 0) return;
    placedRef.current = true;
    const at = resumeEp ? seasonEpisodes.findIndex(v => v.id === resumeEp.id) : 0;
    setEpIndex(Math.max(0, at));
    setZone('episodes');
  }, [isSeries, seasonEpisodes, resumeEp]);

  // Trailer: keeps one handed over from Home, otherwise starts its own.
  // Leaving the page (back, or on into the player) stops it.
  const trailer = useTrailerState();
  const [trailerPlaying, setTrailerPlaying] = useState(false);
  const infoRef = useRef(info);
  infoRef.current = info;
  useEffect(() => {
    if (!active) {
      stopTrailer();
      return;
    }
    const openedAt = Date.now();
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    if (trailer?.itemId !== id) {
      stopTrailer();
      t = setTimeout(async () => {
        let ytId = infoRef.current ? trailerIdFor(infoRef.current) : undefined;
        if (!ytId) {
          const full = await fetchMeta(type, id);
          ytId = full ? trailerIdFor(full) : undefined;
        }
        if (ytId && live) startTrailer(id, ytId, openedAt + TRAILER_PLAY_MS);
      }, TRAILER_LOAD_MS);
    }
    return () => {
      live = false;
      if (t) clearTimeout(t);
      stopTrailer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, id]);

  const isAnime = Boolean(info?.genres?.includes('Animation'));

  const playEpisode = (v: Episode) => {
    if (!info) return;
    nav.push({
      name: 'player',
      params: {
        id: v.id,
        type,
        title: `${info.name} S${v.season}E${v.episode}`,
        poster: info.poster,
        background: info.background,
        isAnime,
        episodeThumbnail: v.thumbnail,
        episodeLabel: `S${v.season}E${v.episode}`,
      },
    });
  };
  const playMovie = () => {
    if (!info) return;
    nav.push({
      name: 'player',
      params: { id, type, title: info.name, poster: info.poster, background: info.background, isAnime },
    });
  };

  // Buttons: a movie gets Play (labelled Resume when there's a position);
  // a series gets "Resume SxEy" when there's history.
  const movieResumeAt = !isSeries && historyEntry ? resumePositionFor(historyEntry) : 0;
  const actions: Array<{ label: string; run: () => void }> = [];
  if (!isSeries && type === 'movie') {
    actions.push({ label: movieResumeAt > 0 ? `▸  Resume (${fmtMinutes(movieResumeAt)})` : '▸  Play', run: playMovie });
  }
  if (isSeries && resumeEp) {
    actions.push({ label: `▸  Resume S${resumeEp.season}E${resumeEp.episode}`, run: () => playEpisode(resumeEp) });
  }

  useKeys(
    code => {
      switch (code) {
        case KEY.BACK:
          nav.back();
          return;
        case KEY.UP:
          if (zone === 'episodes') {
            if (epIndex > 0) setEpIndex(epIndex - 1);
            else if (actions.length) setZone('actions');
          }
          return;
        case KEY.DOWN:
          if (zone === 'actions' && isSeries && seasonEpisodes.length) setZone('episodes');
          else if (zone === 'episodes' && epIndex < seasonEpisodes.length - 1) setEpIndex(epIndex + 1);
          return;
        case KEY.LEFT:
        case KEY.RIGHT: {
          const step = code === KEY.RIGHT ? 1 : -1;
          if (zone === 'actions') {
            setAction(Math.max(0, Math.min(actions.length - 1, action + step)));
            return;
          }
          // Left/Right on the episode list switches season.
          const at = activeSeason === null ? -1 : seasons.indexOf(activeSeason);
          const next = seasons[at + step];
          if (next !== undefined) {
            setSeason(next);
            setEpIndex(0);
          }
          return;
        }
        case KEY.ENTER:
          if (zone === 'actions') actions[action]?.run();
          else if (seasonEpisodes[epIndex]) playEpisode(seasonEpisodes[epIndex]);
          return;
        default:
          return false;
      }
    },
    active,
  );

  if (!info) {
    return (
      <div className="screen">
        <div className="center">
          {loading ? (
            <div className="spinner" />
          ) : (
            <>
              <div className="error-title">Details unavailable for this title</div>
              <div className="resolving">This entry came from a catalog that doesn't provide full details. Try finding it in Search.</div>
            </>
          )}
        </div>
      </div>
    );
  }

  const metaLine = [info.year, info.runtime, info.genres?.slice(0, 2).join(', '), info.imdbRating ? `★ ${info.imdbRating}` : undefined]
    .filter(Boolean)
    .join('  ·  ');
  const from = Math.max(0, epIndex - 2);
  const to = Math.min(seasonEpisodes.length, from + EPISODE_WINDOW);
  const trackY = -Math.max(0, epIndex - 1) * EPISODE_STRIDE;

  return (
    <div className="screen">
      {info.background && <div className="detail-backdrop" style={{ backgroundImage: `url("${info.background}")` }} />}
      <TrailerHost itemId={id} className="detail-trailer" onPlayingChange={setTrailerPlaying} />
      <div className="detail-scrim-light-v" />
      <div className="detail-scrim-light-h" />
      <div className={trailerPlaying ? 'detail-heavy clear' : 'detail-heavy'}>
        <div className="detail-scrim-v" />
        <div className="detail-scrim-h" />
      </div>

      <div className="detail-content">
        <div className="detail-head">
          {info.poster && <div className="detail-poster" style={{ backgroundImage: `url("${posterThumb(info.poster)}")` }} />}
          <div className="detail-info">
            <div className="detail-title">{info.name}</div>
            {metaLine && <div className="detail-meta">{metaLine}</div>}
            {info.description && <div className="detail-desc">{info.description}</div>}
            {info.cast?.length ? <div className="detail-cast">Starring {info.cast.slice(0, 3).join(', ')}</div> : null}
            {actions.length > 0 && (
              <div className="detail-actions">
                {actions.map((a, i) => (
                  <div key={a.label} className={zone === 'actions' && action === i ? 'btn focused' : 'btn'}>
                    {a.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {isSeries && (
          <div className="seasons">
            {seasons.map(s => (
              <div key={s} className={s === activeSeason ? 'season active' : 'season'}>
                {seasonLabel(s)}
              </div>
            ))}
            {seasons.length > 1 && <div className="season-hint">‹ ›  to switch</div>}
          </div>
        )}

        {type === 'series' && loading && episodes.length === 0 && (
          <div className="episodes">
            <div className="spinner" style={{ margin: '40px auto' }} />
          </div>
        )}

        {isSeries && (
          <div className="episodes">
            <div className="episodes-track" style={{ transform: `translateY(${trackY}px)` }}>
              {seasonEpisodes.slice(from, to).map((v, k) => {
                const i = from + k;
                const thumb = stillThumb(v.thumbnail) ?? backdropThumb(info.background);
                const progress = historyEntry?.episodeId === v.id ? progressFractionFor(historyEntry) : 0;
                const summary = v.overview ?? v.description;
                return (
                  <div
                    key={v.id}
                    className={zone === 'episodes' && i === epIndex ? 'episode focused' : 'episode'}
                    style={{ top: i * EPISODE_STRIDE }}>
                    <div className="episode-thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
                      {progress > 0 && (
                        <div className="cw-progress">
                          <div style={{ width: `${Math.round(progress * 100)}%` }} />
                        </div>
                      )}
                    </div>
                    <div className="episode-body">
                      <div className="episode-title">
                        {v.episode}. {episodeTitle(v)}
                      </div>
                      <div className="episode-meta">
                        {[aired(v), v.rating ? `★ ${v.rating}` : ''].filter(Boolean).join('   ')}
                      </div>
                      {summary ? <div className="episode-desc">{summary}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
