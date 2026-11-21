import { useEffect, useRef, useState } from 'react';
import type { Meta } from '../../../../src/types';
import type { Nav } from '../App';
import { search } from '../../../../src/addons/client';
import { posterThumb } from '../../../../src/addons/images';
import { KEY, useKeys } from '../platform/keys';

type Filter = 'all' | 'movie' | 'series';
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'movie', label: 'Movies' },
  { key: 'series', label: 'Shows' },
];
const COLUMNS = 5;
const COL_STRIDE = 222;
const ROW_STRIDE = 312;
const DEBOUNCE_MS = 400;

export function SearchScreen({ nav, active }: { nav: Nav; active: boolean }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [results, setResults] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Focus: the search box, the filter chips, or a result.
  const [zone, setZone] = useState<'input' | 'chips' | 'grid'>('input');
  const [chip, setChip] = useState(0);
  const [cell, setCell] = useState(0);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      const types: Array<'movie' | 'series'> = filter === 'all' ? ['movie', 'series'] : [filter];
      Promise.all(types.map(type => search(type, q).catch(() => [] as Meta[])))
        .then(lists => {
          if (cancelled) return;
          // Interleave so neither type buries the other.
          const merged: Meta[] = [];
          const longest = Math.max(...lists.map(l => l.length));
          for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) merged.push(l[i]);
          setResults(merged);
          setCell(0);
        })
        .finally(() => !cancelled && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, filter]);

  const openKeyboard = () => {
    setTyping(true);
    input.current?.focus();
  };
  const closeKeyboard = () => {
    setTyping(false);
    input.current?.blur();
  };

  // Opening Search goes straight to typing, as on Fire TV.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(openKeyboard, 300);
    return () => clearTimeout(t);
  }, [active]);

  useKeys(
    code => {
      if (typing) {
        // The TV's keyboard has the keys while it's open; these close it.
        if (code === KEY.IME_DONE || code === KEY.IME_CANCEL || code === KEY.BACK) {
          closeKeyboard();
          if (results.length) setZone('grid');
          return;
        }
        if (code === KEY.DOWN) {
          closeKeyboard();
          setZone('chips');
          return;
        }
        return false;
      }
      switch (code) {
        case KEY.BACK:
          nav.back();
          return;
        case KEY.ENTER:
          if (zone === 'input') openKeyboard();
          else if (zone === 'chips') setFilter(FILTERS[chip].key);
          else if (results[cell]) {
            const item = results[cell];
            nav.push({ name: 'detail', id: item.id, type: item.type, initial: item });
          }
          return;
        case KEY.UP:
          if (zone === 'chips') setZone('input');
          else if (zone === 'grid') {
            if (cell >= COLUMNS) setCell(cell - COLUMNS);
            else setZone('chips');
          }
          return;
        case KEY.DOWN:
          if (zone === 'input') setZone('chips');
          else if (zone === 'chips' && results.length) setZone('grid');
          else if (zone === 'grid' && cell + COLUMNS < results.length) setCell(cell + COLUMNS);
          return;
        case KEY.LEFT:
          if (zone === 'chips') setChip(Math.max(0, chip - 1));
          else if (zone === 'grid' && cell % COLUMNS > 0) setCell(cell - 1);
          return;
        case KEY.RIGHT:
          if (zone === 'chips') setChip(Math.min(FILTERS.length - 1, chip + 1));
          else if (zone === 'grid' && cell % COLUMNS < COLUMNS - 1 && cell < results.length - 1) setCell(cell + 1);
          return;
        default:
          return false;
      }
    },
    active,
  );

  const focusedRow = Math.floor(cell / COLUMNS);
  const firstRow = Math.max(0, focusedRow - 1);
  const shown = results.slice(firstRow * COLUMNS, (firstRow + 4) * COLUMNS);

  return (
    <div className="screen">
      <div className="search">
        <input
          ref={input}
          className={zone === 'input' ? 'search-input focused' : 'search-input'}
          value={query}
          placeholder="Search movies and shows"
          onChange={e => setQuery(e.target.value)}
          onBlur={() => setTyping(false)}
        />
        <div className="chips">
          {FILTERS.map((f, i) => (
            <div
              key={f.key}
              className={['chip', filter === f.key ? 'selected' : '', zone === 'chips' && chip === i ? 'focused' : ''].join(' ')}>
              {f.label}
            </div>
          ))}
        </div>
        {loading && <div className="spinner" style={{ marginTop: 40 }} />}
        {!loading && query.trim().length >= 2 && results.length === 0 && (
          <div className="search-empty">No results for "{query}"</div>
        )}
        <div className="grid">
          <div className="grid-track" style={{ transform: `translateY(${-firstRow * ROW_STRIDE}px)` }}>
            {shown.map((item, k) => {
              const i = firstRow * COLUMNS + k;
              const art = posterThumb(item.poster);
              return (
                <div
                  key={item.id + ':' + i}
                  className={zone === 'grid' && i === cell ? 'card focused' : 'card'}
                  style={{
                    transform: `translate(${(i % COLUMNS) * COL_STRIDE}px, ${Math.floor(i / COLUMNS) * ROW_STRIDE}px)`,
                  }}>
                  {art ? (
                    <div className="card-art" style={{ backgroundImage: `url("${art}")` }} />
                  ) : (
                    <div className="card-art card-placeholder">{item.name}</div>
                  )}
                  <div className="card-name">{item.name}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
