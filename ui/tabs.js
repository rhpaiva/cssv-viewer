// CSSV Viewer: the window. It holds tabs, each a frame showing viewer.html
// with one file, or the home, and decides where a file opens: in its tab if
// it's open already, in the current tab if that's the home, or else in a new
// tab after the current one.
//
// The Rust side (src-tauri) knows each tab by an id made here, and queues the
// files the viewer is asked to open from outside (its command line, the file
// manager, the viewer started again); this page takes them when it starts
// and when told there are more. A tab's page loads when the tab is first
// shown, so files opened together don't all render at once.
import * as prefs from './prefs.js';

const { core, dialog, webview, webviewWindow } = window.__TAURI__;
const win = webviewWindow.getCurrentWebviewWindow();
const $ = (id) => document.getElementById(id);
const mac = /Mac/.test(navigator.platform);

/** In the strip's order: { id, path (null for the home), loaded, el, name, close, frame }. */
const tabs = [];
let current = null;

const nameOf = (path) => path.split(/[\\/]/).pop();
const pageOf = (path) => (path === null ? 'viewer.html' : `viewer.html?${new URLSearchParams({ file: path })}`);

// The tab's name on the Rust side and in the URLs of its files, from the
// system's random source, so another tab's file can't guess it.
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

function label(tab) {
  const name = tab.path === null ? 'Home' : nameOf(tab.path);
  tab.name.textContent = name;
  tab.el.title = tab.path ?? 'Home';
  tab.frame.title = name;
  tab.close.setAttribute('aria-label', `Close ${name}`);
  if (tab === current) {
    document.title = tab.path === null ? 'CSSV Viewer' : `${name} — CSSV Viewer`;
    win.setTitle(document.title).catch(() => {});
  }
}

function create(path, at) {
  const tab = { id: newId(), path, loaded: false };
  tab.el = Object.assign(document.createElement('div'), { className: 'tab', id: `tab-${tab.id}`, tabIndex: -1 });
  tab.el.setAttribute('role', 'tab');
  tab.name = Object.assign(document.createElement('span'), { className: 'tab-name' });
  tab.close = Object.assign(document.createElement('button'), { type: 'button', className: 'tab-close', tabIndex: -1 });
  tab.close.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10"/><path d="M17 7 7 17"/></svg>';
  tab.el.append(tab.name, tab.close);
  tab.close.addEventListener('click', () => closeTab(tab));
  // A press leaves the focus in the tab's page (select) and doesn't
  // autoscroll; the middle button closes a tab, as in browsers.
  tab.el.addEventListener('mousedown', (event) => event.preventDefault());
  tab.el.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    closeTab(tab);
  });
  tab.el.addEventListener('pointerdown', (event) => drag(tab, event));

  tab.frame = Object.assign(document.createElement('iframe'), { id: `frame-${tab.id}`, hidden: true });
  tab.frame.dataset.tab = tab.id;
  tab.el.setAttribute('aria-controls', tab.frame.id);
  // A tab navigates by itself too (a recent file from the home, a reload,
  // allowing remote content): its file is the one its page shows.
  tab.frame.addEventListener('load', () => {
    const where = tab.frame.contentWindow.location;
    if (!where.pathname.endsWith('/viewer.html')) return; // the empty page before the first load
    tab.path = new URLSearchParams(where.search).get('file');
    label(tab);
  });

  tabs.splice(at, 0, tab);
  $('tabs').insertBefore(tab.el, $('tabs').children[at] ?? null);
  $('frames').append(tab.frame); // never moved after this: a moved frame reloads
  label(tab);
  return tab;
}

/** Shows `tab`, loading its page the first time, and focuses its page or, from the strip's keys, the tab. */
function select(tab, { focus = 'page' } = {}) {
  current = tab;
  for (const t of tabs) {
    const on = t === tab;
    t.frame.hidden = !on;
    t.el.setAttribute('aria-selected', String(on));
    t.el.tabIndex = on ? 0 : -1;
  }
  if (!tab.loaded) navigate(tab, tab.path);
  label(tab);
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  (focus === 'tab' ? tab.el : tab.frame).focus();
}

function navigate(tab, path) {
  tab.path = path;
  tab.loaded = true;
  tab.frame.src = pageOf(path);
  label(tab);
}

// Moves `tab` one place along the strip, `by` -1 or 1. The neighbor's strip
// element is the one that moves: moving the tab's own would end a drag (its
// pointer capture), and frames never move, as a frame that moves reloads.
function move(tab, by) {
  const i = tabs.indexOf(tab);
  const other = tabs[i + by];
  if (!other) return;
  [tabs[i], tabs[i + by]] = [other, tab];
  if (by > 0) tab.el.before(other.el);
  else tab.el.after(other.el);
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Pressing a tab shows it; dragging it along the strip moves it past each
// tab whose middle the pointer crosses.
function drag(tab, down) {
  if (down.button !== 0 || tab.close.contains(down.target)) return;
  select(tab);
  const middle = (t) => {
    const box = t.el.getBoundingClientRect();
    return box.left + box.width / 2;
  };
  const along = (event) => {
    for (;;) {
      const i = tabs.indexOf(tab);
      if (i > 0 && event.clientX < middle(tabs[i - 1])) move(tab, -1);
      else if (i < tabs.length - 1 && event.clientX > middle(tabs[i + 1])) move(tab, 1);
      else return;
    }
  };
  const end = () => {
    tab.el.removeEventListener('pointermove', along);
    tab.el.removeEventListener('pointerup', end);
    tab.el.removeEventListener('pointercancel', end);
  };
  tab.el.setPointerCapture(down.pointerId);
  tab.el.addEventListener('pointermove', along);
  tab.el.addEventListener('pointerup', end);
  tab.el.addEventListener('pointercancel', end);
}

/** Files of closed tabs, latest last, with their places, for Ctrl+Shift+T. */
const closed = [];

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  if (tab.path !== null) closed.push({ path: tab.path, at: i });
  tabs.splice(i, 1);
  tab.el.remove();
  tab.frame.remove();
  core.invoke('close_tab', { tab: tab.id }).catch(() => {});
  if (tabs.length === 0) {
    win.close();
  } else if (tab === current) {
    select(tabs[Math.min(i, tabs.length - 1)]);
  }
}

/** Opens files, showing the last. */
function open(paths) {
  let at = current ? tabs.indexOf(current) + 1 : tabs.length;
  let last = null;
  for (const path of paths) {
    last = tabs.find((t) => t.path === path);
    if (last) continue;
    if (current?.path === null) {
      navigate(current, path);
      last = current;
    } else {
      last = create(path, at++);
    }
  }
  if (last) select(last);
}

/** The home: its tab if there is one, or a new tab at the end. */
function home() {
  select(tabs.find((t) => t.path === null) ?? create(null, tabs.length));
}

/** The last closed tab's file, back in its place, unless it's open again. */
function reopen() {
  const last = closed.pop();
  if (!last) return;
  select(tabs.find((t) => t.path === last.path) ?? create(last.path, Math.min(last.at, tabs.length)));
}

async function choose() {
  const picked = await dialog.open({
    multiple: true,
    directory: false,
    filters: [{ name: 'CSSV', extensions: ['cssv'] }, { name: 'CSV', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (picked) open([picked].flat());
}

function step(by) {
  select(tabs[(tabs.indexOf(current) + by + tabs.length) % tabs.length]);
}

/** The window's keys, pressed here or in a tab's page; true if it took the key. */
function key(event) {
  const mod = mac ? event.metaKey : event.ctrlKey;
  // WebKitGTK names Shift+Tab "Unidentified"; its code is still Tab.
  const k = event.code === 'Tab' ? 'tab' : event.key.toLowerCase();
  if (event.ctrlKey && !event.altKey && (k === 'tab' || k === 'pagedown' || k === 'pageup')) {
    const by = k === 'pageup' || (k === 'tab' && event.shiftKey) ? -1 : 1;
    // With Shift, PgUp and PgDn move the tab instead.
    if (event.shiftKey && k !== 'tab') move(current, by);
    else step(by);
  } else if (!mod || event.altKey) return false;
  else if (k === 't') event.shiftKey ? reopen() : home();
  else if (k === 'w') closeTab(current);
  else if (k === 'o') choose();
  else if (k === 'q') core.invoke('quit');
  else if (/^[1-9]$/.test(k)) {
    const tab = k === '9' ? tabs.at(-1) : tabs[Number(k) - 1];
    if (tab) select(tab);
  } else return false;
  return true;
}

// What a tab's page asks of the window (viewer.js).
window.shell = { open, choose, key };

addEventListener('keydown', (event) => {
  if (key(event)) event.preventDefault();
});

// The strip's own keys, as in any list of tabs.
$('tabs').addEventListener('keydown', (event) => {
  const i = tabs.indexOf(current);
  const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (to === undefined || !tabs[to]) return;
  event.preventDefault();
  select(tabs[to], { focus: 'tab' });
});

// Many tabs scroll; a mouse wheel scrolls them sideways.
$('tabs').addEventListener('wheel', (event) => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  $('tabs').scrollLeft += event.deltaY;
  event.preventDefault();
}, { passive: false });

$('new-tab').addEventListener('click', () => home());
if (mac) $('new-tab').title = $('new-tab').title.replace('Ctrl+', '⌘');

// Files dropped on the window open in tabs.
webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
  $('drop').hidden = payload.type !== 'enter' && payload.type !== 'over';
  if (payload.type === 'drop' && payload.paths.length > 0) open(payload.paths);
});

// The window's own colors follow the theme a tab chooses (boot.js sets it
// before the first paint).
prefs.watch('theme', (theme) => {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
});

// Files to open, from the Rust side; None (null) asks for the home.
async function take() {
  const asked = await core.invoke('take_opens');
  const files = asked.filter((path) => path !== null);
  if (files.length) open(files);
  else if (asked.length || !tabs.length) home();
}
await win.listen('cssv-open', take);
take();
