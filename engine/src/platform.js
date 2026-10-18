// Where the engine is running. On the server it is Node, with a disk and
// environment variables; on the published site the same engine runs inside
// the browser (a worker), where none of that exists. Node-only modules are
// loaded only on Node, so every engine file can be imported in both places.

export const IS_NODE = typeof process !== 'undefined' && Boolean(process.versions?.node)
  && typeof window === 'undefined' && typeof WorkerGlobalScope === 'undefined';

const load = async (name) => (IS_NODE ? (await import(name)).default : null);

/** node:fs/promises, or null in a browser. */
export const fsp = await load('node:fs/promises');
/** node:fs, or null in a browser. */
export const fsSync = await load('node:fs');
/** node:path, or null in a browser. */
export const pathMod = await load('node:path');
/** node:crypto, or null in a browser. */
export const cryptoMod = await load('node:crypto');

/** Environment settings: process.env on Node, globalThis.FF_ENV in a browser. */
export const env = IS_NODE ? process.env : (globalThis.FF_ENV || {});

/** The working directory on Node, '' in a browser. */
export const cwd = () => (IS_NODE ? process.cwd() : '');

/**
 * Where the engine fetches its own data files from in a browser (the built
 * site's folder). Set by the worker before the engine loads.
 */
export const STATIC_BASE = IS_NODE ? null : (globalThis.FF_STATIC_BASE || './');
