// Typed access to AVPlay, Samsung's native media player — the reason the
// Tizen port needs no MKV remuxer: on a 2018 TV it opens MKV directly,
// seeks it, and switches its audio tracks (verified on a UN65NU8000 with an
// H.264 / E-AC-3 / two-audio-track release).
//
// Times are milliseconds, as AVPlay uses them.

export type AvTrack = {
  index: number;
  type: 'VIDEO' | 'AUDIO' | 'TEXT' | string;
  // JSON: language, fourCC, channels, ...
  extra_info: string;
};

export type AvListener = {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (ms: number) => void;
  onstreamcompleted?: () => void;
  onevent?: (type: string, data: string) => void;
  onerror?: (type: string) => void;
  onsubtitlechange?: (durationMs: number, text: string, type: number, attrCount: number) => void;
};

type AvPlay = {
  open(url: string): void;
  close(): void;
  prepareAsync(ok: () => void, fail: (e: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(ms: number, ok?: () => void, fail?: (e: unknown) => void): void;
  getCurrentTime(): number;
  getDuration(): number;
  getState(): 'NONE' | 'IDLE' | 'READY' | 'PLAYING' | 'PAUSED' | string;
  setDisplayRect(x: number, y: number, w: number, h: number): void;
  setDisplayMethod(method: string): void;
  setListener(listener: AvListener): void;
  setStreamingProperty(name: string, value: string): void;
  setBufferingParam(option: 'PLAYER_BUFFER_FOR_PLAY' | 'PLAYER_BUFFER_FOR_RESUME', unit: 'PLAYER_BUFFER_SIZE_IN_SECOND' | 'PLAYER_BUFFER_SIZE_IN_BYTE', amount: number): void;
  getTotalTrackInfo(): AvTrack[];
  getCurrentStreamInfo(): AvTrack[];
  setSelectTrack(type: string, index: number): void;
  setSilentSubtitle(silent: boolean): void;
  suspend(): void;
  restore(url?: string, resumeMs?: number, prepare?: boolean): void;
};

declare const webapis: { avplay: AvPlay };

export const av = (): AvPlay => webapis.avplay;

export function trackExtra(t: AvTrack): { language?: string; fourCC?: string; channels?: string; track_lang?: string } {
  try {
    return JSON.parse(t.extra_info);
  } catch {
    return {};
  }
}

// Releases the player whatever state it's in. Safe to call repeatedly.
export function closePlayer(): void {
  const p = av();
  try {
    if (p.getState() !== 'NONE' && p.getState() !== 'IDLE') p.stop();
  } catch {
    // already stopped
  }
  try {
    p.close();
  } catch {
    // already closed
  }
}
