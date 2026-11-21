import { useEffect, useRef } from 'react';

// Remote keys as Tizen reports them (KeyboardEvent.keyCode).
export const KEY = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  ENTER: 13,
  BACK: 10009,
  PLAY_PAUSE: 10252,
  PLAY: 415,
  PAUSE: 19,
  STOP: 413,
  FAST_FORWARD: 417,
  REWIND: 412,
  NEXT: 10233,
  PREVIOUS: 10232,
  // On-screen keyboard
  IME_DONE: 65376,
  IME_CANCEL: 65385,
} as const;

declare const tizen: {
  tvinputdevice: { registerKey(name: string): void };
  application: { getCurrentApplication(): { exit(): void } };
};

// The media keys only reach the app once registered; the D-pad, OK and
// Back always do.
export function registerMediaKeys(): void {
  for (const name of [
    'MediaPlayPause',
    'MediaPlay',
    'MediaPause',
    'MediaStop',
    'MediaFastForward',
    'MediaRewind',
    'MediaTrackNext',
    'MediaTrackPrevious',
  ]) {
    try {
      tizen.tvinputdevice.registerKey(name);
    } catch {
      // Not on this remote.
    }
  }
}

export function exitApp(): void {
  try {
    tizen.application.getCurrentApplication().exit();
  } catch {
    window.close();
  }
}

// One document-level listener, handing each key to whichever screen is on
// top. Screens decide where focus goes themselves (a row/column model, not
// DOM focus), which keeps a key press to one state update: no measuring
// the page to find "the nearest element to the right".
//
// Handlers stack: the most recently enabled one gets the key (a menu opened
// over the player, say), and disabling it hands keys back to the one below.
// A handler returning `false` passes the key down the stack.
type Handler = (code: number, e: KeyboardEvent) => boolean | void;
const stack: Handler[] = [];

document.addEventListener('keydown', e => {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i](e.keyCode, e) !== false) {
      // Handled: stop the browser scrolling or moving its own focus.
      e.preventDefault();
      return;
    }
  }
});

export function useKeys(handler: Handler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const fn: Handler = (code, e) => ref.current(code, e);
    stack.push(fn);
    return () => {
      const at = stack.indexOf(fn);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [enabled]);
}
