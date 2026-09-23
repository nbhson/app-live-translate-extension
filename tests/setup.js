// Vitest setup — mock chrome APIs globally
global.chrome = {
  storage: {
    local: {
      get: (keys) => Promise.resolve({}),
      set: (obj) => Promise.resolve(),
    },
  },
  runtime: {
    lastError: null,
    getURL: (path) => `chrome-extension://fake/${path}`,
    sendMessage: (msg, cb) => cb && cb({}),
  },
  tabs: {
    query: () => Promise.resolve([]),
    create: () => {},
  },
  sidePanel: {
    setPanelBehavior: () => Promise.resolve(),
    open: () => Promise.resolve(),
  },
  tabCapture: {
    getMediaStreamId: (opts, cb) => cb('fake-stream-id'),
  },
};

// Mock performance.now for shouldToggleSpeaker tests
if (!global.performance) global.performance = { now: () => Date.now() };
