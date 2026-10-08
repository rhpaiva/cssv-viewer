// CSSV Viewer: a tab, showing one file rendered by <cssv-table>, the
// reference renderer, as published in the @rhpaiva/cssv package, or the home.
// Section numbers refer to the CSSV spec.
//
// The window's page (index.html, tabs.js) holds the tabs, each this page in a
// frame of its own, and the tab's file comes from the query string
// (?file=<path>): opening another file in the tab is a navigation, and a
// reload shows the file again. The frame reaches the Rust side (src-tauri)
// through the window's Tauri API, naming itself by its tab id. The Rust side
// serves the file and its folder to this tab over the cssv: protocol and says
// when the file changes.
import './cssv-table.js';
import { detectDelimiter, metadata, parse, rewriteCssUrls, splitFile } from './core.js';
import { blockRows, encode, pngOf, save, selectedBlock, svgOf, tableRows, tsv } from './export.js';
import { createFind } from './find.js';
import { menuButton } from './menu.js';
import * as prefs from './prefs.js';
import { createPrint } from './print.js';
import { createSource } from './source.js';

const { core, webviewWindow } = parent.__TAURI__;
const { shell } = parent;
const tab = frameElement.dataset.tab;
const win = webviewWindow.getCurrentWebviewWindow();
const params = new URLSearchParams(location.search);
const file = params.get('file');
const $ = (id) => document.getElementById(id);
const mac = /Mac/.test(navigator.platform);
const keys = (k) => (mac ? `⌘${k}` : `Ctrl+${k}`);

// 11.2: a file opened from disk may load files from its own folder, but
// nothing remote until the reader allows it for this file's style block. The
// policy has to be in place before the table loads anything; it can't be
// lifted again, so allowing remote content reloads the tab with a policy
// that lets it in. Scripts, plugins, frames and forms stay out either way.
function protect(remote) {
  const local = 'cssv: http://cssv.localhost'; // the second form is how Windows webviews see cssv:
  const from = remote ? `${local} http: https:` : local;
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline' ${from}`,
    `img-src 'self' data: blob: ${from}`,
    `font-src 'self' data: ${from}`,
    `media-src ${from}`,
    `connect-src 'self' ipc: http://ipc.localhost ${from}`, // the SVG fetches what the table loads (export.js)
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  document.head.prepend(meta);
}
// The home's previews never load remote content. A file's tab sets its
// policy once it has read the file (open).
if (file === null) protect(false);

// What the window shows: the file's URL and text, its parsed model (for
// find, copying and saving; null when it doesn't parse), and the table.
const state = { path: file, url: null, text: '', model: null, table: null, plain: false };
const stem = (path) => path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'table';
const marks = Object.assign(document.createElement('div'), { className: 'marks' });

// --- Status and problems ----------------------------------------------------

let statusTimer;
function status(text, { fade = false } = {}) {
  const el = $('status');
  clearTimeout(statusTimer);
  el.textContent = text;
  el.classList.remove('fade');
  if (fade) statusTimer = setTimeout(() => el.classList.add('fade'), 2500);
}

// The line of the file a problem comes from, where the file says it: the
// section tells which declaration or rule (an imported stylesheet's isn't in
// the file, so it has none).
function problemLine({ section, message }) {
  const lines = state.text.split('\n');
  const find = (test) => {
    const i = lines.findIndex(test);
    return i < 0 ? null : i + 1;
  };
  const value = message.split(': ').slice(1).join(': ').trim();
  switch (section) {
    case '3.4': return 1;
    case '4.2': return find((l) => /@import\b/i.test(l));
    case '9': case '9.1': return find((l) => /--cssv-key\s*:/.test(l));
    case '9.2': return (value && find((l) => l.includes(value))) ?? find((l) => /--cssv-format\s*:/.test(l));
    case '5': return unterminatedQuote();
    default: return null;
  }
}

// A data section as the renderer reads its records (5): a quote opens a
// quoted field only where a field begins, and is a letter anywhere else;
// inside one, two quotes are one. Returns where the first `limit` line
// breaks outside quoted fields are, and where the quoted field that never
// ends opens (-1 if none does).
function readData(data, limit = Infinity) {
  const delimiter = detectDelimiter(data);
  const breaks = [];
  let open = -1; // the quote that opened the quoted field we're in
  let start = true; // nothing of the current field read yet
  for (let i = 0; i < data.length && breaks.length < limit; i++) {
    const ch = data[i];
    if (open >= 0) {
      if (ch === '"' && data[i + 1] === '"') i++;
      else if (ch === '"') open = -1;
    } else if (ch === '\n' || ch === delimiter) {
      if (ch === '\n') breaks.push(i);
      start = true;
    } else {
      if (ch === '"' && start) open = i;
      start = false;
    }
  }
  return { breaks, open };
}

// 5: the line where the quoted field that never ends begins.
function unterminatedQuote() {
  let data;
  try {
    data = splitFile(state.text).data;
  } catch {
    return null;
  }
  const { open } = readData(data);
  if (open < 0) return null; // the renderer read other text
  return state.text.slice(0, state.text.length - data.length + open).split('\n').length;
}

// Problems the renderer reports, for the last render. Fatal ones leave the
// table empty (3.4, 5), so their list opens by itself.
const problems = [];
function showProblems() {
  const toggle = $('problems-toggle');
  $('problems-list').replaceChildren(...problems.map((problem) => {
    const { section, message, fatal } = problem;
    const li = document.createElement('li');
    const where = document.createElement('span');
    where.className = 'section';
    where.textContent = /^\d/.test(section) ? `§${section}` : section;
    const text = document.createElement('span');
    text.textContent = message;
    if (fatal) text.className = 'fatal';
    li.append(where, text);
    const line = state.text && problemLine(problem);
    if (line) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'line';
      go.textContent = `Line ${line}`;
      go.title = 'Show this line in the source';
      go.addEventListener('click', () => source.jump(line));
      li.append(go);
    }
    return li;
  }));
  toggle.hidden = problems.length === 0;
  toggle.textContent = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
  if (problems.length === 0) $('problems').hidden = true;
  if (problems.some((p) => p.fatal)) $('problems').hidden = false;
  toggle.setAttribute('aria-expanded', String(!$('problems').hidden));
}
$('problems-toggle').addEventListener('click', () => {
  $('problems').hidden = !$('problems').hidden;
  $('problems-toggle').setAttribute('aria-expanded', String(!$('problems').hidden));
});

// --- Remote content (11.2) --------------------------------------------------

// Each blocked load is listed in the bar with what it is, so the reader sees
// exactly which URLs the file asked for.
const KINDS = {
  'style-src': 'stylesheet',
  'style-src-elem': 'stylesheet', // what WebKit reports for @import
  'font-src': 'font',
  'img-src': 'image',
  'media-src': 'media',
};
const SHOWN = 5;
const blocked = new Map(); // URL → kind
let denied = false;

function showBlocked() {
  const items = [...blocked].slice(0, SHOWN).map(([url, kind]) => {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.className = 'kind';
    what.textContent = kind;
    const where = document.createElement('code');
    where.textContent = url;
    where.title = url;
    li.append(what, where);
    return li;
  });
  if (blocked.size > SHOWN) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `and ${blocked.size - SHOWN} more`;
    items.push(li);
  }
  $('remote-list').replaceChildren(...items);
  $('remote').hidden = denied;
}

document.addEventListener('securitypolicyviolation', (event) => {
  if (!file) return; // the home's previews stay without remote content
  let url;
  try {
    url = new URL(event.blockedURI);
  } catch {
    return; // inline or eval, not a remote load
  }
  if (!url.host || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return;
  if (blocked.has(url.href)) return;
  blocked.set(url.href, KINDS[event.effectiveDirective] ?? 'resource');
  showBlocked();
});

// Remote content is allowed for the file's style block as the reader saw it:
// `remote` in the query string holds a SHA-256 of it until the tab opens
// another file, and "Always allow" remembers it with the file. A file whose
// style block changes asks again, as what it loads may have changed too.
let styleHash = null;
let remoteAllowed = false;

async function hashStyle(text) {
  let style;
  try {
    style = splitFile(text).style ?? '';
  } catch {
    style = text; // no closing fence: nothing renders, but compare it all
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(style));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function allowRemote(on, { remember = false } = {}) {
  if (remember || !on) prefs.rememberRemote(file, on ? styleHash : null);
  if (on) params.set('remote', styleHash);
  else params.delete('remote');
  location.search = params;
}
$('remote-allow').addEventListener('click', () => allowRemote(true));
$('remote-always').addEventListener('click', () => allowRemote(true, { remember: true }));
// Not allowing keeps the loads blocked and the bar away until the window
// opens or reloads a file.
$('remote-deny').addEventListener('click', () => {
  denied = true;
  $('remote').hidden = true;
});

// While remote content is allowed, a chip in the toolbar says so and takes it back.
function showRemoteOn() {
  const remembered = () => prefs.remoteRemembered(file, styleHash);
  $('remote-on').hidden = false;
  menuButton($('remote-on'), () => [
    { heading: remembered() ? 'Allowed for this file' : 'Allowed until the window closes' },
    ...(remembered() ? [] : [{ label: 'Always allow for this file', run: () => prefs.rememberRemote(file, styleHash) }]),
    { label: 'Block remote content', run: () => allowRemote(false) },
  ], 'Remote content');
}

// --- Opening files ----------------------------------------------------------

// The window decides where a file opens (tabs.js): its tab if it's open, this
// tab if it's the home, or a new tab.
const go = (path) => shell.open([path]);

const split = (path) => {
  const parts = path.split(/[\\/]/);
  const name = parts.pop();
  return { name, folder: parts.join(path.includes('\\') ? '\\' : '/') };
};

function recentItems() {
  const list = prefs.recent().filter((p) => p !== file);
  if (!list.length) return [{ label: 'No recent files', disabled: true }];
  return [
    ...list.map((path) => ({ label: split(path).name, detail: split(path).folder, run: () => go(path) })),
    { separator: true },
    { label: 'Clear recent files', run: () => { prefs.set('recent', []); showRecent(); } },
  ];
}

// The home lists the latest recent files as cards, each with a preview: the
// file's first rows, rendered from its own style block. The window may read
// a recent file's folder for that (preview_file), and nothing remote. The
// Open menu and the command palette list all of them.
const HOME_CARDS = 8;
const PREVIEW_ROWS = 60;

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null));
  return node;
}

// The first `n` records of a data section; a line break inside a quoted
// field doesn't end one.
function firstRecords(data, n) {
  const { breaks } = readData(data, n);
  return breaks.length === n ? data.slice(0, breaks[n - 1] + 1) : data;
}

// The header and the first rows. The preview has no src, so relative URLs
// in the style block are made absolute against the file's URL (4.3).
function preview(text, url) {
  const { style, data } = splitFile(text);
  const rows = firstRecords(data, PREVIEW_ROWS + 1);
  return style === null ? rows : `---\n${rewriteCssUrls(style, url)}---\n${rows}`;
}

async function fillCard(card, path) {
  const table = card.querySelector('cssv-table');
  const stats = card.querySelector('.card-stats');
  try {
    const url = await core.invoke('preview_file', { tab, path });
    const text = await (await fetch(url, { cache: 'no-store' })).text();
    const model = parse(text);
    // The file's own title and description (4.6), as plain text. With a
    // title, the line under it names the file, as in the web editor.
    const { title, description } = metadata(text);
    if (title) {
      card.querySelector('.card-name').textContent = title;
      card.querySelector('.card-path').textContent = path;
    }
    card.querySelector('.card-desc').textContent = description ?? '';
    stats.textContent = `${count(model.rows.length, 'row')} · ${count(model.columns.length, 'column')}`;
    await table.update(preview(text, url));
    // A preview holds still: ten animated tables would keep the page busy.
    for (const animation of table.table?.getAnimations({ subtree: true }) ?? []) animation.pause();
  } catch (error) {
    card.classList.add('failed');
    stats.textContent = String(error?.message ?? error);
  }
}

function recentCard(path) {
  const { name, folder } = split(path);
  const table = document.createElement('cssv-table');
  setLang(table, prefs.get('locale', ''));
  const card = h('article', { className: 'card', role: 'listitem' },
    h('a', {
      className: 'card-open',
      href: `?${new URLSearchParams({ file: path })}`,
      title: path,
      onclick: (event) => {
        event.preventDefault();
        go(path);
      },
    },
      h('div', { className: 'thumb', inert: true }, table),
      h('div', { className: 'card-body' },
        h('strong', { className: 'card-name', textContent: name }),
        h('span', { className: 'card-path', textContent: folder }),
        h('p', { className: 'card-desc' }),
        h('span', { className: 'card-stats', textContent: 'Loading…' }))),
    h('button', {
      type: 'button',
      className: 'card-remove',
      title: 'Remove from recent files',
      ariaLabel: `Remove ${name} from recent files`,
      textContent: '×',
      onclick: () => {
        prefs.removeRecent(path);
        showRecent();
      },
    }));
  return card;
}

// The previews render one after another, so the page builds one table at a
// time; a newer list stops an older one.
let listing = 0;
async function showRecent() {
  if (file !== null) return; // a file's tab has no home: its table took the place
  const list = prefs.recent().slice(0, HOME_CARDS);
  $('recent').hidden = list.length === 0;
  $('home').classList.toggle('with-recent', list.length > 0);
  const cards = list.map(recentCard);
  $('recent-cards').replaceChildren(...cards);
  const run = ++listing;
  for (const [i, card] of cards.entries()) {
    if (run !== listing) return;
    await fillCard(card, list[i]);
  }
}

// Linux, run as an AppImage: whether this copy opens .cssv files from the
// file manager. Installed packages and other systems register themselves.
let integration = { available: false, installed: false };
function showSetup() {
  if (file !== null) return; // the offer is the home's
  $('setup').hidden = !integration.available || integration.installed || prefs.get('setup-dismissed', false);
}
async function setIntegration(on) {
  try {
    integration = await core.invoke('set_integration', { on });
    status(on ? 'CSSV Viewer now opens .cssv files' : 'CSSV Viewer no longer opens .cssv files', { fade: true });
  } catch (error) {
    status(String(error));
  }
  showSetup();
}
core.invoke('integration').then((answer) => {
  integration = answer;
  showSetup();
});
$('setup-yes').addEventListener('click', () => setIntegration(true));
$('setup-no').addEventListener('click', () => {
  prefs.set('setup-dismissed', true);
  showSetup();
});

$('open').addEventListener('click', () => shell.choose());
$('open-empty').addEventListener('click', () => shell.choose());
menuButton($('open-more'), () => [
  { heading: 'Recent files' },
  ...recentItems(),
  ...(integration.available ? [
    { separator: true },
    integration.installed
      ? { label: 'Stop opening .cssv files with CSSV Viewer', run: () => setIntegration(false) }
      : { label: 'Open .cssv files with CSSV Viewer', run: () => setIntegration(true) },
  ] : []),
], 'Open');

// --- The table --------------------------------------------------------------

// Plain view shows the data alone, with the renderer's default styles: what
// the file holds when its style block hides or rearranges it.
function shown(text) {
  if (!state.plain) return text;
  try {
    return splitFile(text).data;
  } catch {
    return text; // the renderer reports why it doesn't parse
  }
}

async function readText() {
  const response = await fetch(state.url, { cache: 'no-store' });
  if (!response.ok) return false; // removed, or caught mid-save: the next change tries again
  state.text = await response.text();
  try {
    state.model = parse(state.text);
  } catch {
    state.model = null;
  }
  source.render(state.text);
  // The tab and the window are named after the file's title (4.6).
  let title = null;
  try {
    title = metadata(state.text).title || null;
  } catch {
    // no style block to read it from; the renderer reports why
  }
  shell.titled(tab, title);
  return true;
}

async function open(path) {
  const { name, folder } = split(path);
  $('file-name').textContent = name;
  $('file-folder').textContent = folder;
  $('file-folder').title = path;
  $('file').hidden = false;
  document.title = stem(path); // what Print and "Save as PDF" name the file

  try {
    state.url = await core.invoke('open_file', { tab, path });
  } catch (error) {
    protect(false);
    $('stage').replaceChildren();
    problems.push({ section: 'open', message: String(error), fatal: true });
    showProblems();
    return;
  }
  prefs.addRecent(path);

  // Whether remote content is allowed depends on the style block, so the
  // text comes before the policy, and the policy before the table (11.2).
  try {
    if (await readText()) styleHash = await hashStyle(state.text);
  } catch {
    // the table reports why it can't load the file
  }
  remoteAllowed = styleHash !== null && (params.get('remote') === styleHash || prefs.remoteRemembered(file, styleHash));
  protect(remoteAllowed);
  if (remoteAllowed) showRemoteOn();

  const table = document.createElement('cssv-table');
  state.table = table;
  setLang(table, prefs.get('locale', ''));
  table.addEventListener('cssv-loadstart', () => {
    problems.length = 0;
    showProblems();
  });
  table.addEventListener('cssv-error', (event) => {
    problems.push(event.detail);
    showProblems();
  });
  table.addEventListener('cssv-loadend', () => find.refresh());
  // The table fades in once it first renders (viewer.css).
  status('Opening…');
  table.addEventListener('cssv-loadend', () => {
    table.classList.add('shown');
    status('');
  }, { once: true });
  table.src = state.url; // relative URLs in the style block resolve against the file (4.3)
  $('stage').replaceChildren(table, marks);

  // Saving the file updates the table in place: unchanged rows, the scroll
  // position and the formats of unchanged cells stay as they are. The window
  // hears of every tab's changes; the listener lives in the window's page, so
  // it goes when this page does.
  const unlisten = await win.listen('cssv-file-changed', async ({ payload }) => {
    if (payload !== tab) return;
    try {
      if (!(await readText())) return;
      // Remote content was allowed for the style block as it was: another
      // one shows in the tab reloaded without it, which asks again.
      const hash = await hashStyle(state.text).catch(() => null);
      if (remoteAllowed && hash !== styleHash) {
        params.delete('remote');
        location.search = params;
        return;
      }
      styleHash = hash;
      table.update(shown(state.text));
      await table.ready;
      status(`Updated ${new Date().toLocaleTimeString()}`, { fade: true });
    } catch {
      // the same: wait for the next change
    }
  });
  addEventListener('pagehide', unlisten);
}

// --- Toolbar ----------------------------------------------------------------

const find = createFind({ stage: $('stage'), marks, host: () => state.table, model: () => state.model });
const source = createSource({
  onToggle: (open) => $('source').setAttribute('aria-pressed', String(open)),
});

$('find-open').addEventListener('click', () => find.toggle());

function togglePlain() {
  state.plain = !state.plain;
  $('plain').setAttribute('aria-pressed', String(state.plain));
  state.table?.update(shown(state.text));
}
$('plain').addEventListener('click', togglePlain);

$('source').addEventListener('click', () => source.toggle());

// Light or dark sets the window's preference, which the table's
// light-dark() values and prefers-color-scheme queries follow, as the
// viewer's own colors do. It applies to every window.
const THEMES = [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']];
function applyTheme(theme) {
  const chosen = theme === 'light' || theme === 'dark' ? theme : null;
  win.setTheme(chosen).catch(() => {});
  if (chosen) document.documentElement.dataset.theme = chosen; // the viewer's own colors (viewer.css)
  else delete document.documentElement.dataset.theme;
  const label = `Light or dark: ${THEMES.find(([v]) => v === theme)?.[1] ?? THEMES[0][1]}`;
  $('theme').title = label;
  $('theme').setAttribute('aria-label', label);
}
applyTheme(prefs.get('theme', 'system'));
prefs.watch('theme', applyTheme);
// The menus' items, which the command palette offers too.
const themeItems = () => THEMES.map(([value, label]) => ({
  label,
  radio: true,
  checked: prefs.get('theme', 'system') === value,
  run: () => {
    prefs.set('theme', value);
    applyTheme(value);
  },
}));
menuButton($('theme'), themeItems, 'Light or dark');

// The language numbers display in (10.1): the system's, or one chosen to see
// the file as readers elsewhere will. It is the table's lang attribute.
const LOCALES = ['en-US', 'en-GB', 'en-IN', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-BR', 'nl-NL', 'sv-SE', 'pl-PL', 'ja-JP', 'zh-CN', 'hi-IN', 'ar-EG'];
// The system's language as the renderer picks it: the first valid tag.
const SYSTEM = [...navigator.languages, 'en-US'].find((tag) => {
  try {
    return Intl.getCanonicalLocales(tag).length > 0;
  } catch {
    return false;
  }
});
const sample = (tag) => new Intl.NumberFormat(tag || SYSTEM).format(-1234567.89);
const languageName = (tag) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
  } catch {
    return tag;
  }
};
function setLang(table, locale) {
  if (locale) table.setAttribute('lang', locale);
  else table.removeAttribute('lang');
}

function applyLocale(locale) {
  const tag = locale || SYSTEM;
  $('numbers').textContent = tag;
  const label = `Numbers in ${locale ? languageName(tag) : `the system's language (${tag})`}`;
  $('numbers').title = label;
  $('numbers').setAttribute('aria-label', label);
  for (const table of document.querySelectorAll('cssv-table')) setLang(table, locale);
}
applyLocale(prefs.get('locale', ''));
prefs.watch('locale', (locale) => applyLocale(locale ?? ''));
function localeItems() {
  const current = prefs.get('locale', '');
  const item = (tag, label) => ({
    label,
    detail: sample(tag),
    radio: true,
    checked: current === tag,
    run: () => {
      prefs.set('locale', tag);
      applyLocale(tag);
    },
  });
  return [
    item('', `System language (${SYSTEM})`),
    { separator: true },
    ...LOCALES.map((tag) => item(tag, languageName(tag))),
  ];
}
menuButton($('numbers'), localeItems, 'Language for numbers');

// Copying: the cells a selection spans (Ctrl+C does it too), or the whole
// table, as the file has the values.
async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    status(message, { fade: true });
  } catch (error) {
    status(`Could not copy: ${error}`);
  }
}
const count = (n, what) => `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}`;
function copyItems() {
  const block = state.model && selectedBlock(state.table);
  const cells = block ? (block.rows[1] - block.rows[0] + 1) * (block.cols[1] - block.cols[0] + 1) : 0;
  const ready = !!state.model && !!state.table?.table;
  return [
    {
      label: block ? `Copy ${count(cells, 'selected cell')}` : 'Copy selected cells',
      shortcut: keys('C'),
      disabled: !block,
      run: () => copy(tsv(blockRows(state.model, block)), `Copied ${count(cells, 'cell')}`),
    },
    { separator: true },
    { label: 'Copy the table for spreadsheets', disabled: !ready, run: () => copy(tsv(tableRows(state.model)), 'Copied the table, tab-separated') },
    { label: 'Copy the table as Markdown', disabled: !ready, run: () => copy(state.table.toMarkdown(), 'Copied the table as Markdown') },
    { label: 'Copy the data as CSV', disabled: !state.model, run: () => copy(splitFile(state.text).data, 'Copied the data section') },
  ];
}
menuButton($('copy'), copyItems, 'Copy');
document.addEventListener('copy', (event) => {
  const block = state.model && selectedBlock(state.table);
  if (!block) return; // text in one cell, or outside the table: the browser copies it
  event.clipboardData.setData('text/plain', tsv(blockRows(state.model, block)));
  event.preventDefault();
  const cells = (block.rows[1] - block.rows[0] + 1) * (block.cols[1] - block.cols[0] + 1);
  status(`Copied ${count(cells, 'cell')}`, { fade: true });
});

// Saving as another file: the data alone, or a picture of the table as it
// shows (the SVG keeps its animations; the PNG is the table at rest).
async function saveAs(kind) {
  const name = stem(state.path);
  const options = { text: state.text, plain: state.plain, base: state.url };
  try {
    let path;
    if (kind === 'csv') {
      path = await save(encode(splitFile(state.text).data), { tab, name: `${name}.csv`, kind: 'CSV', ext: 'csv' });
    } else if (kind === 'svg') {
      status('Drawing the table…');
      const { svg } = await svgOf(state.table, options);
      path = await save(encode(svg), { tab, name: `${name}.svg`, kind: 'SVG image', ext: 'svg' });
    } else {
      status('Drawing the table…');
      path = await save(await pngOf(state.table, options), { tab, name: `${name}.png`, kind: 'PNG image', ext: 'png' });
    }
    status(path ? `Saved ${split(path).name}` : '', { fade: true });
  } catch (error) {
    status(`Could not save: ${error?.message ?? error}`);
  }
}
function saveItems() {
  const ready = !!state.table?.table;
  return [
    { label: 'Data as CSV…', disabled: !state.model, run: () => saveAs('csv') },
    { separator: true },
    { label: 'Image as PNG…', disabled: !ready, run: () => saveAs('png') },
    { label: 'Image as SVG…', disabled: !ready, run: () => saveAs('svg') },
  ];
}
const printItem = () => ({ label: 'Print or save as PDF…', shortcut: keys('P'), disabled: !state.table?.table, run: () => print.open() });
menuButton($('export'), () => [...saveItems(), { separator: true }, printItem()], 'Save as');

// Printing shows a preview on paper first (print.js), then prints the table
// alone (viewer.css), with the file's own @media print rules.
const print = createPrint({
  tab,
  host: () => state.table,
  source: () => [state.text, { plain: state.plain, base: state.url }],
});
$('print').addEventListener('click', () => print.open());

// --- Command palette --------------------------------------------------------

// What the window's command palette (Ctrl+K, palette.js) offers in this tab:
// the toolbar's tools, from the same items as its menus, under the menu's
// name where an item's label needs it. Only what this tab can do now.
window.paletteCommands = () => {
  const items = (group, list) => list.filter((i) => i.label && !i.disabled).map((i) => ({ ...i, group }));
  return [
    ...items('', file ? [
      { label: 'Find in the values', shortcut: keys('F'), disabled: !state.model, run: () => find.open() },
      { label: source.isOpen() ? 'Hide the source' : 'Show the source', shortcut: keys('U'), run: () => source.toggle() },
      { label: state.plain ? 'Show the file with its styles' : 'Plain view: the data without its styles', run: togglePlain },
      printItem(),
      ...copyItems(),
      { label: 'Reload the file', shortcut: keys('R'), run: () => location.reload() },
    ] : []),
    ...items('Save as', saveItems()),
    ...items('Light or dark', themeItems()),
    ...items('Numbers in', localeItems()),
  ];
};

// --- Keyboard ---------------------------------------------------------------

if (mac) {
  for (const el of document.querySelectorAll('.mod')) el.textContent = '⌘';
  for (const el of document.querySelectorAll('[title*="Ctrl+"]')) el.title = el.title.replaceAll('Ctrl+', '⌘');
}

// The window's keys (tabs, Open, Quit) come first (tabs.js), then the tab's.
addEventListener('keydown', (event) => {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (shell.key(event)) event.preventDefault();
  else if (event.key === 'F3' && !print.isOpen()) find.next(event.shiftKey ? -1 : 1);
  else if (event.key === 'F5') location.reload();
  else if (!mod || event.altKey) return;
  else if (key === 'p' && file) print.request();
  else if (print.isOpen()) return; // the rest wait for the preview to close
  else if (key === 'r') location.reload();
  else if (key === 'f' && file) find.open();
  else if (key === 'u' && file) source.toggle();
  else return;
  event.preventDefault();
});

// --- Start ------------------------------------------------------------------

for (const el of document.querySelectorAll('.needs-file')) el.disabled = !file;
showRecent();
prefs.watch('recent', showRecent);
if (file) {
  if (prefs.get('source-open', false)) source.show(true);
  open(file);
}
