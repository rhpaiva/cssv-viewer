// Shared setup for the UI tests: a server for ui/ and the renderer, a fake
// of the Tauri API the pages call, and Chromium. The pages are the real
// ones: index.html is the window, and each of its tabs is viewer.html in a
// frame, as in the app. The fake's files are served from the test server
// under /disk, so a tab renders a real file with the real <cssv-table>.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before } from 'node:test';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI = join(ROOT, 'ui');
const RENDERER = join(ROOT, 'node_modules/@rhpaiva/cssv/src');
const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.cssv': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** A 1×1 PNG, for images a file's style block loads. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Chromium: the browser at CHROME_PATH when it is set, else Playwright's own. */
export function launchChromium() {
  const executablePath = process.env.CHROME_PATH;
  return chromium.launch(executablePath ? { executablePath } : {});
}

/**
 * Serves ui/ at the root and the renderer's two modules beside it, as the
 * app's frontendDist does (src-tauri/tauri.conf.json), and files a test adds:
 * disk(path) for the fake's files, file(path) for anything else.
 */
export function startServer() {
  const files = new Map();
  const server = http.createServer(async (req, res) => {
    const { port } = server.address();
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(421);
      return res.end();
    }
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const entry = files.get(path);
    if (entry) {
      if (entry.delay) await new Promise((r) => setTimeout(r, entry.delay));
      const type = 'type' in entry ? entry.type : TYPES[extname(path)] ?? 'text/plain';
      res.writeHead(entry.status ?? 200, { 'cache-control': 'no-store', ...(type ? { 'content-type': type } : {}) });
      return res.end(req.method === 'HEAD' ? undefined : entry.body);
    }
    const name = path.slice(1);
    const dir = name === 'cssv-table.js' || name === 'core.js' ? RENDERER : UI;
    if (!/^[\w.-]+$/.test(name)) {
      res.writeHead(404);
      return res.end();
    }
    try {
      const body = await readFile(join(dir, name));
      res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    resolve({
      origin,
      /** Serves `body` at `path`. Options: type (null for none), delay (ms), status. */
      file(path, body, options = {}) {
        files.set(path, { body, ...options });
        return origin + path;
      },
      /** A file on the fake's disk, at the absolute `path` the viewer names it by. */
      disk(path, body, options = {}) {
        files.set(`/disk${path}`, { body, ...options });
        return `${origin}/disk${path}`;
      },
      remove(path) {
        files.delete(`/disk${path}`);
      },
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

// The fake Tauri API, in the window's page; a tab's page uses its parent's,
// as in the app. Runs before any of the page's scripts, in every frame.
function fakeTauri(config) {
  if (config.platform) Object.defineProperty(Navigator.prototype, 'platform', { get: () => config.platform });
  if (config.languages) Object.defineProperty(Navigator.prototype, 'languages', { get: () => config.languages });
  if (config.brokenStorage) {
    Storage.prototype.getItem = () => { throw new Error('no storage'); };
    Storage.prototype.setItem = () => { throw new Error('no storage'); };
  }
  if (config.noColumnWrap) {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args) => (args[0] === 'column-wrap' || args[0] === 'column-height' ? false : supports(...args));
  }
  if (window !== top) return;

  const listeners = new Map(); // event name → handlers
  let dropHandler = null;
  const exists = async (path) => (await fetch(`/disk${path}`, { method: 'HEAD' })).ok;
  const fake = {
    calls: [],
    opens: [...(config.opens ?? [])],
    /** Answers by command; a function gets (args, options). */
    handlers: {
      take_opens: () => fake.opens.splice(0),
      open_file: async ({ path }) => {
        if (!(await exists(path))) throw `${path} is not a file.`;
        return `${location.origin}/disk${path}`;
      },
      preview_file: async ({ path }) => {
        if (!(await exists(path))) throw 'Not found.';
        return `${location.origin}/disk${path}`;
      },
      close_tab: () => null,
      set_page: () => null,
      quit: () => null,
      save_file: () => null,
      integration: () => config.integration ?? { available: false, installed: false },
      set_integration: ({ on }) => ({ available: true, installed: on }),
    },
    dialog: null, // what the Open dialog returns
    windowCalls: [],
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler({ event, payload });
    },
    drop(payload) {
      dropHandler({ payload });
    },
  };
  if (config.holdTake) fake.handlers.take_opens = () => new Promise(() => {});
  const win = {
    listen: async (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => listeners.set(event, listeners.get(event).filter((h) => h !== handler));
    },
    setTitle: async (title) => { fake.windowCalls.push(['setTitle', title]); },
    setTheme: async (theme) => { fake.windowCalls.push(['setTheme', theme]); },
    close: async () => { fake.windowCalls.push(['close']); },
  };
  window.__fake = fake;
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args, options) => {
        fake.calls.push({ cmd, args, options });
        return fake.handlers[cmd](args, options);
      },
    },
    dialog: {
      open: async (options) => {
        fake.calls.push({ cmd: 'dialog.open', args: options });
        return fake.dialog;
      },
    },
    webview: {
      getCurrentWebview: () => ({ onDragDropEvent: async (handler) => { dropHandler = handler; } }),
    },
    webviewWindow: { getCurrentWebviewWindow: () => win },
  };
}

/**
 * Registers before/after hooks and returns a context filled in by `before`:
 * server, browser, and open(options) for a window.
 */
export function setup() {
  const ctx = {};
  // Under c8, NODE_V8_COVERAGE names the folder where Node writes its
  // coverage; the pages' coverage of ui/ goes there too.
  const coverage = process.env.NODE_V8_COVERAGE;
  const pages = [];
  const contexts = [];
  before(async () => {
    ctx.server = await startServer();
    ctx.browser = await launchChromium();

    /** A browser context: one profile, its storage shared by its pages. */
    ctx.context = async ({ reducedMotion = 'reduce', locale = 'en-GB', storage = {}, ...options } = {}) => {
      const localStorage = Object.entries(storage).map(([key, value]) => ({ name: `cssv-viewer:${key}`, value: JSON.stringify(value) }));
      const context = await ctx.browser.newContext({
        reducedMotion,
        locale,
        viewport: { width: 1100, height: 720 },
        storageState: { cookies: [], origins: [{ origin: ctx.server.origin, localStorage }] },
        ...options,
      });
      contexts.push(context);
      return context;
    };

    /**
     * Opens the window (index.html). Options: opens (the paths the Rust side
     * asks it to open), storage (prefs to start with), context (to share one),
     * page (a page path other than index.html), and the fake's config:
     * platform, languages, integration, brokenStorage, holdTake, noColumnWrap.
     */
    ctx.open = async ({ context, page: path = '/index.html', storage, reducedMotion, locale, contextOptions, ...config } = {}) => {
      context ??= await ctx.context({ storage, reducedMotion, locale, ...contextOptions });
      const page = await context.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e));
      if (coverage) {
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        pages.push(page);
      }
      await page.addInitScript(fakeTauri, config);
      await page.goto(ctx.server.origin + path);
      return new Window(page);
    };
  });
  after(async () => {
    if (coverage) {
      const result = [];
      for (const page of pages) {
        if (page.isClosed()) continue;
        for (const { scriptId, url, functions } of await page.coverage.stopJSCoverage()) {
          if (!url.startsWith(`${ctx.server.origin}/`)) continue;
          const name = new URL(url).pathname.slice(1);
          if (!/^[\w-]+\.js$/.test(name) || name === 'cssv-table.js' || name === 'core.js') continue;
          // c8 reads the source from the file the URL names.
          result.push({ scriptId, url: pathToFileURL(join(UI, name)).href, functions });
        }
      }
      await writeFile(join(coverage, `coverage-browser-${process.pid}-${Date.now()}.json`), JSON.stringify({ result }));
    }
    for (const context of contexts) await context.close().catch(() => {});
    await ctx.browser?.close();
    await ctx.server?.close();
  });
  return ctx;
}

/** The window's page, with helpers for its tabs and the fake. */
export class Window {
  constructor(page) {
    this.page = page;
  }

  /** The fake's recorded calls of `cmd`. */
  calls(cmd) {
    return this.page.evaluate((c) => __fake.calls.filter((x) => x.cmd === c).map(({ args, options }) => ({ args, options })), cmd);
  }

  /** Runs `fn(fake, arg)` in the window's page. */
  fake(fn, arg) {
    return this.page.evaluate(`(${fn})(window.__fake, ${JSON.stringify(arg)})`);
  }

  /** The tabs in the strip, in order: { name, path, selected }. */
  tabs() {
    return this.page.$$eval('#tabs .tab', (els) => els.map((el) => ({
      name: el.querySelector('.tab-name').textContent,
      path: el.title,
      selected: el.getAttribute('aria-selected') === 'true',
    })));
  }

  /** The frame of the shown tab, or of the tab at `index`, once its page has loaded. */
  async tab(index) {
    const selector = index === undefined ? '#frames iframe:not([hidden])' : `#frames iframe:nth-child(${index + 1})`;
    await this.page.waitForSelector(selector, { state: 'attached' });
    const frame = await (await this.page.$(selector)).contentFrame();
    await frame.waitForFunction(() => document.readyState === 'complete' && window.paletteCommands);
    return frame;
  }

  /** The shown tab's frame once its table has rendered. */
  async file(index) {
    const frame = await this.tab(index);
    await frame.waitForFunction(() => document.querySelector('#stage > cssv-table')?.classList.contains('shown'));
    return frame;
  }

  /**
   * Opens `path` from the home in a new tab, and holds the table's own load
   * of the file back for `delay` ms: the tab has read the file (its model is
   * there) while the table hasn't drawn it. Returns the tab's frame.
   */
  async openSlowTable(path, delay = 1500) {
    let reads = 0;
    // The fake's check that the file exists (a HEAD) isn't a read.
    await this.page.route(`**/disk${path}`, async (route) => {
      if (route.request().method() === 'GET' && ++reads > 1) await new Promise((r) => setTimeout(r, delay));
      await route.continue();
    });
    await this.fake((f, p) => { f.opens.push(p); f.emit('cssv-open'); }, path);
    return this.tab();
  }

  /** The shown tab's frame once its home has finished filling the recent files' cards. */
  async home(index) {
    const frame = await this.tab(index);
    await frame.waitForFunction(() => [...document.querySelectorAll('.card-stats')].every((s) => s.textContent !== 'Loading…'));
    return frame;
  }
}

/** Waits until `fn` (run in the test) returns a truthy value. */
export async function until(fn, { timeout = 5000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A CSSV file: a style block (null for none) and data lines. */
export const cssv = (style, ...lines) => (style === null ? '' : `---\n${style}\n---\n`) + lines.map((l) => `${l}\n`).join('');

export const BUDGET = cssv('/* cssv:title Household budget */\n.number { color: green; }',
  'Item,Amount,Note', 'Rent,1200,monthly', 'Food,350.5,groceries', 'Fun,-40,"cinema, popcorn"');
