import { useCallback, useMemo, useState } from 'react';
import type { MediaType, Meta, RootStackParamList } from '../../../src/types';
import { HomeScreen } from './screens/Home';
import { DetailScreen } from './screens/Detail';
import { SearchScreen } from './screens/Search';
import { PlayerScreen } from './screens/Player';

export type PlayerParams = RootStackParamList['Player'];

export type Route =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'detail'; id: string; type: MediaType; initial?: Meta }
  | { name: 'player'; params: PlayerParams };

export type Nav = {
  push(route: Route): void;
  replace(route: Route): void;
  back(): void;
};

// A plain stack instead of a router. Home is always at the bottom and stays
// mounted underneath everything (hidden), the way the Fire TV app's native
// stack keeps it: coming back to it keeps its scroll position and data
// without refetching or re-decoding its artwork.
export function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);

  const push = useCallback((route: Route) => setStack(s => [...s, route]), []);
  const replace = useCallback((route: Route) => setStack(s => [...s.slice(0, -1), route]), []);
  const back = useCallback(() => setStack(s => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const nav = useMemo<Nav>(() => ({ push, replace, back }), [push, replace, back]);

  const top = stack.length - 1;
  return (
    <>
      {stack.map((route, i) => {
        const active = i === top;
        // Screens above Home that are no longer on top are dropped rather than
        // hidden — only Home is worth keeping alive.
        if (i > 0 && !active) return null;
        const key = `${i}:${route.name}`;
        const style = active ? undefined : { display: 'none' };
        switch (route.name) {
          case 'home':
            return (
              <div key={key} style={style}>
                <HomeScreen nav={nav} active={active} />
              </div>
            );
          case 'search':
            return <SearchScreen key={key} nav={nav} active={active} />;
          case 'detail':
            return <DetailScreen key={key + route.id} nav={nav} active={active} route={route} />;
          case 'player':
            return <PlayerScreen key={key + route.params.id} nav={nav} active={active} params={route.params} />;
        }
      })}
    </>
  );
}
