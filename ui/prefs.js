// What the viewer remembers between runs, in localStorage: recent files,
// files allowed to load remote content, the theme, the language for numbers
// and the source pane. Storage can fail or come back empty; the viewer then
// works as on a first run.

const PREFIX = 'cssv-viewer:';
const RECENT = 10;

export function get(key, fallback) {
  try {
    const value = localStorage.getItem(PREFIX + key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // not remembered; nothing else depends on it
  }
}

/** Calls `fn(value)` when another window changes `key`. */
export function watch(key, fn) {
  addEventListener('storage', (event) => {
    if (event.key === PREFIX + key) fn(get(key));
  });
}

export const recent = () => get('recent', []);

export function addRecent(path) {
  set('recent', [path, ...recent().filter((p) => p !== path)].slice(0, RECENT));
}

export function removeRecent(path) {
  set('recent', recent().filter((p) => p !== path));
}

// Files allowed to load remote content, each as [path, the hash of the style
// block it was allowed for] (viewer.js): another style block asks again. A
// plain path, remembered before the hashes, asks again too.
const allowed = () => get('remote-allowed', []).filter(Array.isArray);
export const remoteRemembered = (path, hash) => allowed().some(([p, h]) => p === path && h === hash);

/** Remembers that `path` may load remote content with the style block `hash`, or forgets it when `hash` is null. */
export function rememberRemote(path, hash) {
  const rest = allowed().filter(([p]) => p !== path);
  set('remote-allowed', hash ? [...rest, [path, hash]] : rest);
}
