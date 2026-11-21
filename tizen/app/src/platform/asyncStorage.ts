// Stands in for React Native's AsyncStorage, which the shared addon and
// storage code (../../src) is written against. Same promise-returning API,
// backed by the TV browser's localStorage — which a Tizen web app keeps
// across launches.

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store()?.getItem(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      store()?.setItem(key, value);
    } catch {
      // Quota full: the write is lost but the app keeps working.
    }
  },
  async removeItem(key: string): Promise<void> {
    store()?.removeItem(key);
  },
};

export default AsyncStorage;
