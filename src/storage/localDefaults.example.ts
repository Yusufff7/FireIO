// Template for localDefaults.ts — copy this file, rename it to
// localDefaults.ts, and fill in your own values. localDefaults.ts is
// gitignored; this example file is the only one safe to commit.
//
// These become the app's out-of-the-box defaults so you don't have to type
// long URLs with a remote control. Leaving the list empty is perfectly
// valid — the app just starts unconfigured until URLs are supplied.
//
// Keep this file free of real values: a configured addon URL usually embeds
// a personal API key, and anything here is compiled into the JS bundle.
export const LOCAL_DEFAULTS = {
  // Any number of Stremio-protocol stream addons. They're queried in
  // parallel and the results merged, so listing more simply widens the pool
  // of sources to choose from.
  streamAddonUrls: [] as string[],
};
