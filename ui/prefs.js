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

const allowed = () => get('remote-allowed', []);
export const remoteRemembered = (path) => allowed().includes(path);

export function rememberRemote(path, on) {
  const rest = allowed().filter((p) => p !== path);
  set('remote-allowed', on ? [...rest, path] : rest);
}
