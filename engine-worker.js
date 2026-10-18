// The published site has no server: this worker runs the same engine the
// server runs (engine/src/api.js), off the page's main thread so simulations
// never freeze scrolling. The page sends { id, path, query, body, method }
// and gets back { id, ok, data } or { id, ok: false, status, error }.

// Before the engine loads: where its data files live, and the switches the
// server would read from its environment.
globalThis.FF_STATIC_BASE = new URL('./', self.location.href).href;
globalThis.FF_ENV = { MODEL_LAB: 'off' };

const engine = import('./engine/src/api.js');

self.onmessage = async (event) => {
  const { id, path, query, body, method } = event.data || {};
  try {
    const { handleApi } = await engine;
    const data = await handleApi(`/api/${path}`, { query: new URLSearchParams(query || ''), body, method: method || 'GET' });
    self.postMessage({ id, ok: true, data });
  } catch (err) {
    self.postMessage({ id, ok: false, status: err.status || 500, error: err.message || String(err) });
  }
};
