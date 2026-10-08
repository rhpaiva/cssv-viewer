// Drives the real viewer: the binary that `npm run coverage:rust` builds
// with coverage (or any build named by CSSV_VIEWER), in a virtual display,
// through WebKitWebDriver, the WebDriver server of WebKitGTK. The page's
// own scripts run as they do for a reader; the tests reach into them only
// to call the window's commands, and use xdotool for GTK's dialogs, which
// aren't web pages.
//
// Each launch is one run of the viewer in a home folder of its own. The
// viewer must end by itself (closing its window, or quitting), which is
// when it writes its coverage.
//
// Needs Xvfb, dbus-daemon, xdotool and WebKitWebDriver (Ubuntu's
// webkitgtk-webdriver package; WEBKIT_WEBDRIVER names another).
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const binary = process.env.CSSV_VIEWER ?? path.join(repo, 'src-tauri/target/coverage/debug/cssv-viewer');
const webdriver = process.env.WEBKIT_WEBDRIVER ?? 'WebKitWebDriver';

/** Waits until `check` returns something truthy, and returns that. */
export async function until(check, { timeout = 15000, what = 'a condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

const running = (pattern) => {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * A desktop of its own: a virtual display, a session bus and a home folder,
 * which `stop()` takes down. `more` adds variables for the viewer.
 */
export async function desktop(more = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cssv-e2e-'));
  const dir = (name) => {
    const p = path.join(root, name);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  };
  const home = dir('home');
  // The display: the first number free.
  let n = 90;
  while (fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`)) n++;
  const xvfb = spawn('Xvfb', [`:${n}`, '-screen', '0', '1400x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await until(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), { what: 'Xvfb' });
  // A socket path short enough for a Unix socket.
  const bus = `/tmp/cssv-e2e-${process.pid}-${n}.sock`;
  const dbus = spawn('dbus-daemon', ['--session', '--nofork', `--address=unix:path=${bus}`], { stdio: 'ignore' });
  await until(() => fs.existsSync(bus), { what: 'the session bus' });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_DATA_HOME: dir('home/.local/share'),
    XDG_CONFIG_HOME: dir('home/.config'),
    XDG_CACHE_HOME: dir('home/.cache'),
    XDG_RUNTIME_DIR: dir('run'),
    DISPLAY: `:${n}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
    GDK_BACKEND: 'x11',
    LIBGL_ALWAYS_SOFTWARE: '1',
    NO_AT_BRIDGE: '1',
    LANG: 'C.UTF-8',
    // WebKit's sandbox needs user namespaces, which containers often lack.
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
    // Lets WebKitWebDriver drive the viewer's webview (wry reads it).
    TAURI_WEBVIEW_AUTOMATION: 'true',
    // Where a build with coverage writes it: npm run coverage:rust says,
    // else it's dropped with the desktop.
    LLVM_PROFILE_FILE: process.env.LLVM_PROFILE_FILE ?? path.join(root, '%p.profraw'),
    ...more,
  };
  const xdotool = (...args) => execFileSync('xdotool', args, { env, encoding: 'utf8' }).trim();
  const search = (...args) => {
    try {
      return xdotool('search', '--onlyvisible', ...args).split('\n').filter(Boolean);
    } catch {
      return []; // xdotool fails when nothing matches
    }
  };
  return {
    root,
    home,
    env,
    xdotool,
    /** The viewer's window. */
    window: () => until(() => search('--class', 'cssv-viewer')[0], { what: "the viewer's window" }),
    /**
     * Waits for a GTK dialog named `name` (a regular expression), and gives
     * it the keyboard. Without a window manager, it opens partly off the
     * screen and doesn't get the focus by itself.
     */
    async dialog(name) {
      const id = await until(() => search('--name', name)[0], { what: `the ${name} dialog` });
      await sleep(500); // drawn and filled in
      xdotool('windowmove', id, '0', '0');
      xdotool('windowfocus', '--sync', id);
      return id;
    },
    /** Presses keys (xdotool's names) in the window with the keyboard. */
    async keys(...keys) {
      for (const key of keys) {
        xdotool('key', key);
        await sleep(300);
      }
    },
    /** Whether a window named `name` is open. */
    open: (name) => search('--name', name).length > 0,
    /** Runs the viewer once more, as the desktop would to open files with it. */
    again: (args, cwd = home) =>
      new Promise((resolve, reject) => {
        execFile(binary, args, { env, cwd, timeout: 30000 }, (error) => (error ? reject(error) : resolve()));
      }),
    async stop() {
      xvfb.kill();
      dbus.kill();
      fs.rmSync(bus, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The viewer launched in `desk` with `args` as a reader would, without
 * WebDriver, which WebKit doesn't let print. `exited` resolves to its exit
 * code.
 */
export function plain(desk, args = []) {
  const env = { ...desk.env };
  delete env.TAURI_WEBVIEW_AUTOMATION;
  const viewer = spawn(binary, args, { env, cwd: desk.home, stdio: 'ignore' });
  const exited = new Promise((resolve) => viewer.on('exit', (code, signal) => resolve(code ?? signal)));
  return { exited, kill: () => viewer.kill() };
}

/** A WebDriver session on a viewer launched with `args`, in `desk`. */
export async function launch(desk, args = []) {
  const port = await freePort();
  const driver = spawn(webdriver, [`--port=${port}`], { env: desk.env, cwd: desk.home, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${base}/status`).then((r) => r.ok, () => false), { what: 'WebKitWebDriver' });

  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const { value } = await res.json();
    if (!res.ok) throw new Error(`${method} ${url}: ${value?.error}: ${value?.message}`);
    return value;
  };
  const { sessionId } = await call('POST', '/session', {
    capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary, args } } },
  });
  const s = (url) => `/session/${sessionId}${url}`;
  const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'; // WebDriver's key for an element

  const session = {
    /** Runs `script` (a function body) in the current frame and returns its result. */
    run: (script, ...args) => call('POST', s('/execute/sync'), { script, args }),
    /** Runs `script`, which calls its last argument with the result. */
    runAsync: (script, ...args) => call('POST', s('/execute/async'), { script, args }),
    find: async (css) => (await call('POST', s('/element'), { using: 'css selector', value: css }))[ELEMENT],
    click: async (css) => call('POST', s(`/element/${await session.find(css)}/click`), {}),
    /** Types into the element that has the focus. */
    keys: async (css, text) => call('POST', s(`/element/${await session.find(css)}/value`), { text }),
    title: () => call('GET', s('/title')),
    /** Switches to the frame `css` selects, or back to the window with top(). */
    frame: async (css) => call('POST', s('/frame'), { id: { [ELEMENT]: await session.find(css) } }),
    top: () => call('POST', s('/frame'), { id: null }),
    screenshot: async (file) => fs.writeFileSync(file, Buffer.from(await call('GET', s('/screenshot')), 'base64')),
    /** Waits for `script` to return something truthy in the current frame. */
    waitFor: (script, what = script) => until(() => session.run(script).catch(() => false), { what }),
    /**
     * Waits for the viewer to end by itself (the caller closed its window or
     * quit), so it has written its coverage, then ends the session.
     */
    async ended() {
      await until(() => running(binary).length === 0, { what: 'the viewer to end', timeout: 20000 });
      await call('DELETE', s('')).catch(() => {});
      driver.kill();
    },
  };
  return session;
}
