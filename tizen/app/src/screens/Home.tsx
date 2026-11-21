import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, Meta } from '../../../../src/types';
import type { Nav } from '../App';
import { meta as fetchMeta } from '../../../../src/addons/client';
import { discoveryRows, newEpisodesOfWatched } from '../../../../src/addons/discovery';
import { fetchAnimazeRows, type AnimazeRow } from '../../../../src/addons/animaze';
import { backdropThumb, posterThumb, stillThumb } from '../../../../src/addons/images';
import { trailerIdFor } from '../../../../src/addons/trailers';
import { getHistorySync, progressFractionFor, removeWatched, subscribeHistory } from '../../../../src/storage/history';
import { getSettingsSync, isConfigured } from '../../../../src/storage/settings';
import { exitApp, KEY, useKeys } from '../platform/keys';
import { HeroTrailer, startTrailer, stopTrailer } from '../trailer';

// Layout, in the interface canvas's pixels (1372x772, zoomed to fill the
// screen — see styles.css). Must match the hero/rows sizes there.
const HERO_EXPANDED = 380;
const HERO_COMPACT = 265;
// The trailer stops this far above the hero's bottom edge, inside the
// scrim's solid band (see .hero-scrim-bottom).
const TRAILER_INSET = 8;
const HERO_COLLAPSE = HERO_EXPANDED - HERO_COMPACT;
const ROW_GAP = 9; // between the hero's bottom edge and the focused row
const POSTER_STRIDE = 159 + 21;
const CW_STRIDE = 225 + 30;
// Title + card + its name, tight: the zoom makes every row taller on screen.
const POSTER_ROW_H = 340;
const CW_ROW_H = 252;
// Cards rendered either side of a row's position: enough to cover the
// screen and the next few presses, so a row never holds a whole catalog.
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 10;

const FOCUS_DEBOUNCE_MS = 200;
// Discovery rows loaded at once on start; the rest follow one at a time.
const INITIAL_ROWS = 4;
// Returning to Home after this long reloads every row.
const REFRESH_MS = 3 * 60 * 60 * 1000;
// Rows drawn either side of the focused one; the rest aren't in the page.
const ROWS_ABOVE = 2;
const ROWS_BELOW = 3;
const CW_COLLAPSED_COUNT = 15;
const LONG_PRESS_MS = 600;
// Trailer: loading starts early so it can begin right at TRAILER_PLAY_MS.
const TRAILER_LOAD_MS = 900;
const TRAILER_PLAY_MS = 2000;

type RowModel =
  | { key: 'cw'; title: string; kind: 'cw'; items: HistoryEntry[] }
  | { key: string; title: string; kind: 'poster'; items: Meta[] };

// Fetches artwork ahead of time, once per URL, so the hero rarely waits.
const prefetched = new Set<string>();
function prefetch(url: string | undefined) {
  if (!url || prefetched.has(url)) return;
  prefetched.add(url);
  const img = new Image();
  img.src = url;
}

function preload(url: string, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const img = new Image();
    const done = () => resolve();
    const t = setTimeout(done, timeoutMs);
    img.onload = img.onerror = () => {
      clearTimeout(t);
      done();
    };
    img.src = url;
  });
}

function displayName(item: HistoryEntry): string {
  return item.episodeLabel && item.name.endsWith(item.episodeLabel)
    ? item.name.slice(0, -item.episodeLabel.length).trim()
    : item.name;
}

// ---- Cards & rows ------------------------------------------------------------

const PosterCard = memo(function PosterCard({ item, x, focused }: { item: Meta; x: number; focused: boolean }) {
  const art = posterThumb(item.poster);
  return (
    <div className={focused ? 'card focused' : 'card'} style={{ transform: `translateX(${x}px)` }}>
      {art ? (
        <div className="card-art" style={{ backgroundImage: `url("${art}")` }}>
          {item.badge ? <div className="card-badge">{item.badge}</div> : null}
        </div>
      ) : (
        <div className="card-art card-placeholder">{item.name}</div>
      )}
      <div className="card-name">{item.name}</div>
    </div>
  );
});

const CwCard = memo(function CwCard({
  item,
  x,
  focused,
  confirming,
}: {
  item: HistoryEntry;
  x: number;
  focused: boolean;
  confirming: boolean;
}) {
  const art = stillThumb(item.episodeThumbnail) ?? backdropThumb(item.background) ?? posterThumb(item.poster);
  const progress = progressFractionFor(item);
  return (
    <div className={focused ? 'cw-card focused' : 'cw-card'} style={{ transform: `translateX(${x}px)` }}>
      <div className="cw-art" style={art ? { backgroundImage: `url("${art}")` } : undefined}>
        {progress > 0 && (
          <div className="cw-progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {confirming && (
          <div className="cw-confirm">
            Remove?<span>Press OK</span>
          </div>
        )}
      </div>
      <div className="cw-name">{displayName(item)}</div>
      {item.episodeLabel ? <div className="cw-ep">{item.episodeLabel}</div> : null}
    </div>
  );
});

const Row = memo(function Row({
  row,
  y,
  col,
  focused,
  confirmId,
}: {
  row: RowModel;
  y: number;
  col: number;
  focused: boolean;
  confirmId: string | null;
}) {
  const stride = row.kind === 'cw' ? CW_STRIDE : POSTER_STRIDE;
  const from = Math.max(0, col - WINDOW_BEFORE);
  const to = Math.min(row.items.length, col + WINDOW_AFTER);
  const cards = [];
  for (let i = from; i < to; i++) {
    const isFocused = focused && i === col;
    if (row.kind === 'cw') {
      const item = row.items[i];
      cards.push(<CwCard key={item.id} item={item} x={i * stride} focused={isFocused} confirming={confirmId === item.id} />);
    } else {
      const item = row.items[i];
      cards.push(<PosterCard key={item.id + ':' + i} item={item} x={i * stride} focused={isFocused} />);
    }
  }
  return (
    <div className="row" style={{ transform: `translateY(${y}px)` }}>
      <div className="row-title">{row.title}</div>
      {/* Anchored, Netflix-style: the selected card stays at the left edge
          and the row slides under it. */}
      <div className="row-track" style={{ transform: `translateX(${-col * stride}px)` }}>
        {cards}
      </div>
    </div>
  );
});

// ---- Hero --------------------------------------------------------------------

function heroImage(item: Meta): string | undefined {
  return item.background ?? item.poster;
}

const Hero = memo(function Hero({
  item,
  compact,
  kicker,
}: {
  item: Meta | null;
  compact: boolean;
  kicker?: string;
}) {
  // Two backdrop layers cross-fading: the new artwork is decoded before
  // its layer fades in, so the change never passes through an empty frame.
  const [layers, setLayers] = useState<{ a?: string; b?: string; front: 'a' | 'b' }>({ front: 'a' });
  const [shown, setShown] = useState<Meta | null>(null);
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    const url = heroImage(item);
    const swap = () => {
      if (cancelled) return;
      setShown(item);
      setLayers(prev => {
        const back = prev.front === 'a' ? 'b' : 'a';
        return { ...prev, [back]: url, front: back };
      });
    };
    if (url) preload(url, 450).then(swap);
    else swap();
    return () => {
      cancelled = true;
    };
  }, [item]);

  const metaParts = shown
    ? [
        shown.year,
        shown.genres?.length ? shown.genres.slice(0, 3).join(', ') : undefined,
        shown.runtime,
        shown.imdbRating ? `★ ${shown.imdbRating}` : undefined,
      ].filter(Boolean)
    : [];
  const cast = shown?.cast?.length ? `Starring ${shown.cast.slice(0, 3).join(', ')}` : undefined;

  // The hero is always full height and slides up to collapse, with its art
  // counter-shifted so the picture holds still — no height animation, so no
  // re-layout while the rows move.
  const shift = compact ? -HERO_COLLAPSE : 0;
  return (
    <div className={compact ? 'hero compact' : 'hero'} style={{ transform: `translateY(${shift}px)` }}>
      <div className="hero-art" style={{ transform: `translateY(${-shift}px)` }}>
        {(['a', 'b'] as const).map(k =>
          layers[k] ? (
            <div
              key={k}
              className={layers.front === k ? 'hero-layer shown' : 'hero-layer'}
              style={{ backgroundImage: `url("${layers[k]}")` }}
            />
          ) : null,
        )}
        {shown && <HeroTrailer itemId={shown.id} height={(compact ? HERO_COMPACT : HERO_EXPANDED) - TRAILER_INSET} />}
      </div>
      <div className="hero-scrim-bottom" />
      <div className="hero-scrim-side" />
      {shown && (
        <div className="hero-text">
          {kicker ? <div className="hero-kicker">{kicker}</div> : null}
          <div className="hero-title">{shown.name}</div>
          {metaParts.length > 0 && <div className="hero-meta">{metaParts.join('  ·  ')}</div>}
          {shown.description ? <div className="hero-desc">{shown.description}</div> : null}
          {compact && cast ? <div className="hero-cast">{cast}</div> : null}
        </div>
      )}
    </div>
  );
});

// ---- Screen ------------------------------------------------------------------

export function HomeScreen({ nav, active }: { nav: Nav; active: boolean }) {
  const [history, setHistory] = useState<HistoryEntry[]>(getHistorySync);
  const [anime, setAnime] = useState<AnimazeRow[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<Meta[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);

  // Discovery rows (src/addons/discovery.ts): trending, new, top rated and
  // genre rows, all live from Cinemeta. The list itself is rebuilt each day
  // so "New" follows the calendar; each row's contents are loaded in order
  // — the first few at once, the rest one by one behind them — and reloaded
  // when Home is returned to after REFRESH_MS, so the page keeps up with
  // what's trending without a restart.
  const [day, setDay] = useState(() => new Date().toDateString());
  const specs = useMemo(() => discoveryRows(new Date()), [day]);
  const [catalogs, setCatalogs] = useState<Record<string, Meta[]>>({});
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const loadAll = useCallback(() => {
    let cancelled = false;
    const run = async () => {
      const results: Record<string, Meta[]> = {};
      const publish = () => !cancelled && setCatalogs(prev => ({ ...prev, ...results }));
      const first = specs.slice(0, INITIAL_ROWS);
      await Promise.all(
        first.map(sp =>
          sp
            .load()
            .then(items => (results[sp.key] = items))
            .catch(() => (results[sp.key] = [])),
        ),
      );
      if (cancelled) return;
      if (first.every(sp => !results[sp.key]?.length)) setError('Cinemeta did not answer');
      publish();
      setLoading(false);
      for (const sp of specs.slice(INITIAL_ROWS)) {
        if (cancelled) return;
        results[sp.key] = await sp.load().catch(() => [] as Meta[]);
        publish();
      }
      if (!cancelled) setLoadedAt(Date.now());
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [specs]);

  useEffect(() => loadAll(), [loadAll]);

  useEffect(() => {
    let cancelled = false;
    fetchAnimazeRows()
      .then(rows => !cancelled && setAnime(rows))
      .catch(() => {});
    const unsub = subscribeHistory(h => !cancelled && setHistory(h));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // New episodes of the shows you watch, re-checked whenever history changes.
  const historySeriesKey = history.filter(h => h.type === 'series').map(h => h.id).join(',');
  useEffect(() => {
    let cancelled = false;
    newEpisodesOfWatched(history)
      .then(list => !cancelled && setNewEpisodes(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySeriesKey, loadedAt]);

  // Coming back to Home (or to the app) after a while refreshes everything.
  useEffect(() => {
    const check = () => {
      if (document.hidden || !active) return;
      const today = new Date().toDateString();
      if (today !== day) setDay(today);
      else if (loadedAt && Date.now() - loadedAt > REFRESH_MS) loadAll();
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [active, day, loadedAt, loadAll]);

  const rows = useMemo<RowModel[]>(() => {
    const list: RowModel[] = [];
    if (history.length > 0) {
      list.push({
        key: 'cw',
        title: 'Continue Watching',
        kind: 'cw',
        items: showAllHistory ? history : history.slice(0, CW_COLLAPSED_COUNT),
      });
    }
    if (newEpisodes.length) list.push({ key: 'new-episodes', title: 'New Episodes', kind: 'poster', items: newEpisodes });
    for (const sp of specs) {
      const items = catalogs[sp.key];
      if (items?.length) list.push({ key: sp.key, title: sp.title, kind: 'poster', items });
    }
    for (const r of anime) if (r.data.length) list.push({ key: `anime:${r.title}`, title: r.title, kind: 'poster', items: r.data });
    return list;
  }, [history, showAllHistory, newEpisodes, specs, catalogs, anime]);

  const rowYs = useMemo(() => {
    let y = 0;
    return rows.map(r => {
      const at = y;
      y += r.kind === 'cw' ? CW_ROW_H : POSTER_ROW_H;
      return at;
    });
  }, [rows]);

  // Focus: which row (by key, so rows arriving above can't shift it; 'top' =
  // the top bar) and each row's own position, so moving back to a row
  // returns to where you were in it.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const keyIndex = focusKey === 'top' ? -1 : rows.findIndex(r => r.key === focusKey);
  const rowIndex = focusKey === 'top' ? -1 : keyIndex >= 0 ? keyIndex : 0;
  const setRowIndex = (i: number) => setFocusKey(i < 0 ? 'top' : rows[i]?.key ?? null);
  const [cols, setCols] = useState<Record<string, number>>({});
  const colOf = (key: string) => cols[key] ?? 0;
  const row = rowIndex >= 0 ? rows[rowIndex] : undefined;
  const col = row ? Math.min(colOf(row.key), row.items.length - 1) : 0;
  const focusedItem: Meta | undefined = row ? row.items[col] : undefined;
  const onCw = row?.kind === 'cw';
  const compact = rowIndex >= 0 && !onCw;

  // The hero follows focus after a short pause, so holding the D-pad doesn't
  // rebuild it for every card passed. Continue Watching entries only record
  // a few fields, so those wait for the title's full record first.
  const [heroItem, setHeroItem] = useState<Meta | null>(null);
  const heroKey = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedItem) return;
    const key = `${focusedItem.type}:${focusedItem.id}`;
    heroKey.current = key;
    const t = setTimeout(() => {
      if (focusedItem.genres?.length) return setHeroItem(focusedItem);
      fetchMeta(focusedItem.type, focusedItem.id).then(full => {
        if (heroKey.current === key) setHeroItem(full ? { ...full, id: focusedItem.id } : focusedItem);
      });
    }, FOCUS_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [focusedItem]);

  // Prefetch what the next presses will need: backdrops either side, and
  // posters just past the row's rendered window.
  useEffect(() => {
    if (!row) return;
    for (const i of [col + 1, col - 1, col + 2]) prefetch(row.items[i]?.background);
    if (row.kind === 'poster') for (let i = col + WINDOW_AFTER; i < col + WINDOW_AFTER + 4; i++) prefetch(posterThumb(row.items[i]?.poster));
    for (const r of [rows[rowIndex - 1], rows[rowIndex + 1]]) if (r) prefetch(r.items[colOf(r.key)]?.background);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, col, rowIndex, rows]);

  // Trailer: whatever focus rests on plays after TRAILER_PLAY_MS. Any move
  // stops it; leaving Home stops it too, unless it's that title being
  // opened (Detail carries it on full screen).
  const handoffRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) {
      if (handoffRef.current !== focusedItem?.id) stopTrailer();
      handoffRef.current = null;
      return;
    }
    stopTrailer();
    if (!focusedItem) return;
    const item = focusedItem;
    const focusAt = Date.now();
    let cancelled = false;
    const t = setTimeout(async () => {
      let ytId = trailerIdFor(item);
      if (!ytId) {
        const full = await fetchMeta(item.type, item.id);
        ytId = full ? trailerIdFor(full) : undefined;
      }
      if (ytId && !cancelled) startTrailer(item.id, ytId, focusAt + TRAILER_PLAY_MS);
    }, TRAILER_LOAD_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedItem, active]);

  // Opening a title fetches its full record now rather than on arrival.
  useEffect(() => {
    if (!focusedItem) return;
    const t = setTimeout(() => fetchMeta(focusedItem.type, focusedItem.id).catch(() => {}), 900);
    return () => clearTimeout(t);
  }, [focusedItem]);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  // One OK press on Continue Watching, from key-down to key-up. Holding it
  // past LONG_PRESS_MS arms "Remove?" — decided by a timer, not by repeated
  // key events: this remote doesn't reliably repeat OK while it's held, and
  // when it does the repeats aren't always marked as such.
  const enterDown = useRef<{ armed: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);

  const openDetail = useCallback(
    (item: Meta) => {
      handoffRef.current = item.id;
      nav.push({ name: 'detail', id: item.id, type: item.type, initial: item });
    },
    [nav],
  );

  const resume = useCallback(
    (entry: HistoryEntry) => {
      nav.push({
        name: 'player',
        params: {
          id: entry.episodeId ?? entry.id,
          type: entry.type,
          title: entry.episodeLabel ? `${displayName(entry)} ${entry.episodeLabel}` : entry.name,
          isAnime: entry.isAnime,
          preferredResolution: entry.lastResolution,
          poster: entry.poster,
          background: entry.background,
          episodeThumbnail: entry.episodeThumbnail,
          episodeLabel: entry.episodeLabel,
        },
      });
    },
    [nav],
  );

  const setCol = (key: string, value: number) => setCols(c => ({ ...c, [key]: value }));

  // Continue Watching acts on key-UP, so holding OK can arm "Remove?"
  // without first starting playback.
  useEffect(() => {
    if (!active) return;
    const onUp = (e: KeyboardEvent) => {
      if (e.keyCode !== KEY.ENTER || !enterDown.current) return;
      const press = enterDown.current;
      enterDown.current = null;
      if (press.timer) clearTimeout(press.timer);
      if (press.armed) return;
      const r = rows[rowIndex];
      if (r?.kind === 'cw') {
        const item = r.items[Math.min(colOf('cw'), r.items.length - 1)];
        if (item) resume(item);
      }
    };
    document.addEventListener('keyup', onUp);
    return () => document.removeEventListener('keyup', onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rows, rowIndex, cols, resume]);

  useKeys(
    (code, e) => {
      if (confirmId && code !== KEY.ENTER) setConfirmId(null);
      switch (code) {
        case KEY.LEFT:
          if (row && col > 0) setCol(row.key, col - 1);
          return;
        case KEY.RIGHT:
          if (row && col < row.items.length - 1) setCol(row.key, col + 1);
          else if (row?.kind === 'cw' && !showAllHistory && history.length > CW_COLLAPSED_COUNT) setShowAllHistory(true);
          return;
        case KEY.UP:
          if (rowIndex > -1) setRowIndex(rowIndex - 1);
          return;
        case KEY.DOWN:
          if (rowIndex < rows.length - 1) setRowIndex(rowIndex + 1);
          return;
        case KEY.ENTER: {
          if (rowIndex === -1) return nav.push({ name: 'search' });
          if (!row || !focusedItem) return;
          if (row.kind === 'poster') {
            if (!e.repeat) openDetail(focusedItem);
            return;
          }
          // Still the same press (the key hasn't come up yet).
          if (enterDown.current) return;
          if (confirmId === focusedItem.id) {
            setConfirmId(null);
            removeWatched(focusedItem.id).catch(() => {});
            enterDown.current = { armed: true };
            return;
          }
          const press: { armed: boolean; timer?: ReturnType<typeof setTimeout> } = { armed: false };
          const target = focusedItem.id;
          press.timer = setTimeout(() => {
            if (enterDown.current !== press) return;
            press.armed = true;
            setConfirmId(target);
          }, LONG_PRESS_MS);
          enterDown.current = press;
          return;
        }
        case KEY.BACK:
          if (confirmId) return setConfirmId(null);
          if (rowIndex > 0 || col > 0) {
            if (row) setCol(row.key, 0);
            setRowIndex(0);
            return;
          }
          exitApp();
          return;
        default:
          return false;
      }
    },
    active,
  );

  // Park the focused row just under the hero's visible bottom edge; the
  // whole block of rows moves with one transform.
  const rowsShift = row
    ? -rowYs[rowIndex] + (onCw ? ROW_GAP : -HERO_COLLAPSE + ROW_GAP)
    : 0;

  const configured = isConfigured(getSettingsSync());

  return (
    <div className="screen">
      {loading && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}
      {error && (
        <div className="center">
          <div className="error-text">Couldn't load the catalog: {error}</div>
        </div>
      )}

      <div className="rows" style={{ transform: `translateY(${rowsShift}px)` }}>
        {rows.map((r, i) =>
          i < rowIndex - ROWS_ABOVE || i > Math.max(rowIndex, 0) + ROWS_BELOW ? null : (
            <Row
              key={r.key}
              row={r}
              y={rowYs[i]}
              col={Math.min(colOf(r.key), Math.max(0, r.items.length - 1))}
              focused={i === rowIndex}
              confirmId={r.kind === 'cw' ? confirmId : null}
            />
          ),
        )}
      </div>

      <Hero
        item={heroItem}
        compact={compact}
        kicker={onCw && heroItem && history.some(h => h.id === heroItem.id) ? 'Continue Watching' : undefined}
      />

      <div className={rowIndex <= 0 ? 'topbar' : 'topbar hidden'}>
        <div className={rowIndex === -1 ? 'btn focused' : 'btn'}>Search</div>
      </div>

      {!configured && <div className="banner">No stream sources configured. Add addon URLs to src/storage/localDefaults.ts.</div>}
    </div>
  );
}
