// The stick's media pipeline is shared: a VideoPlayer that is still tearing
// down when the next one initializes leaks state into it (PlayerScreen's
// source-switch comment has the device log that proved it). Now that Home
// plays trailers too, there are two independent owners of a VideoPlayer —
// the hero trailer and PlayerScreen — so every deinitialize() is recorded
// here and every initialize() waits for whatever is still in flight.

let pending: Promise<void> = Promise.resolve();

export function trackTeardown(teardown: Promise<unknown>): void {
  pending = Promise.all([pending, teardown]).then(
    () => undefined,
    () => undefined,
  );
}

export function pendingTeardown(): Promise<void> {
  return pending;
}
