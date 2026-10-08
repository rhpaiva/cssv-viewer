// CSSV Viewer: one file per window, rendered by <cssv-table>, the reference
// renderer, as published in the @rhpaiva/cssv package. Section numbers refer
// to the CSSV spec.
//
// The window's file comes from the query string (?file=<path>), so opening
// another file is a navigation and a reload shows the file again. The Rust
// side (src-tauri) serves the file and its folder over the cssv: protocol and
// says when the file changes.
import './cssv-table.js';
import { parse, rewriteCssUrls, splitFile } from './core.js';
import { blockRows, encode, pngOf, save, selectedBlock, svgOf, tableRows, tsv } from './export.js';
import { createFind } from './find.js';
import { menuButton } from './menu.js';
import * as prefs from './prefs.js';
import { createSource } from './source.js';

const { core, dialog, webview, webviewWindow } = window.__TAURI__;
const win = webviewWindow.getCurrentWebviewWindow();
const params = new URLSearchParams(location.search);
const file = params.get('file');
const remoteAllowed = params.get('remote') === '1' || (file !== null && prefs.remoteRemembered(file));
const $ = (id) => document.getElementById(id);
const mac = /Mac/.test(navigator.platform);
const keys = (k) => (mac ? `⌘${k}` : `Ctrl+${k}`);

// 11.2: a file opened from disk may load files from its own folder, but
// nothing remote until the reader allows it for this file. The policy has to
// be in place before the table loads anything; it can't be lifted again, so
// allowing remote content reloads the window without it.
if (!remoteAllowed) {
  const local = 'cssv: http://cssv.localhost'; // the second form is how Windows webviews see cssv:
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline' ${local}`,
    `img-src 'self' data: blob: ${local}`,
    `font-src 'self' data: ${local}`,
    `media-src ${local}`,
    `connect-src 'self' ipc: http://ipc.localhost ${local}`,
  ].join('; ');
  document.head.prepend(meta);
}

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

// 5: the line where the quoted field that never ends begins.
function unterminatedQuote() {
  let data;
  try {
    data = splitFile(state.text).data;
  } catch {
    return null;
  }
  let line = state.text.slice(0, state.text.length - data.length).split('\n').length;
  let quoted = false;
  let opened = null;
  for (const ch of data) {
    if (ch === '\n') line++;
    else if (ch === '"') {
      quoted = !quoted;
      if (quoted) opened = line;
    }
  }
  return quoted ? opened : null;
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

function allowRemote(on, { remember = false } = {}) {
  if (remember || !on) prefs.rememberRemote(file, on);
  if (on) params.set('remote', '1');
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
if (file && remoteAllowed) {
  $('remote-on').hidden = false;
  menuButton($('remote-on'), () => [
    { heading: prefs.remoteRemembered(file) ? 'Allowed for this file' : 'Allowed until the window closes' },
    ...(prefs.remoteRemembered(file) ? [] : [{ label: 'Always allow for this file', run: () => prefs.rememberRemote(file, true) }]),
    { label: 'Block remote content', run: () => allowRemote(false) },
  ], 'Remote content');
}

// --- Opening files ----------------------------------------------------------

function go(path) {
  location.search = new URLSearchParams({ file: path });
}

async function choose() {
  const path = await dialog.open({
    multiple: false,
    directory: false,
    filters: [{ name: 'CSSV', extensions: ['cssv'] }, { name: 'CSV', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (typeof path === 'string') go(path);
}

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

// The home lists recent files as cards, each with a preview: the file's
// first rows, rendered from its own style block. The window may read a
// recent file's folder for that (preview_file), and nothing remote.
const PREVIEW_ROWS = 60;

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null));
  return node;
}

// The first `n` records of a data section; a line break inside quotes
// doesn't end one.
function firstRecords(data, n) {
  let quoted = false;
  let records = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === '"') quoted = !quoted;
    else if (data[i] === '\n' && !quoted && ++records === n) return data.slice(0, i + 1);
  }
  return data;
}

// The header and the first rows. The preview has no src, so relative URLs
// in the style block are made absolute against the file's URL (4.3).
function preview(text, url) {
  const { style, data } = splitFile(text);
  const rows = firstRecords(data, PREVIEW_ROWS + 1);
  return style === null ? rows : `---\n${rewriteCssUrls(style, url)}---\n${rows}`;
}

// The style block's opening comment, when it comes before the first rule.
function summary(text) {
  const { style } = splitFile(text);
  const open = style?.indexOf('/*') ?? -1;
  const brace = style?.indexOf('{') ?? -1;
  if (open < 0 || (brace >= 0 && brace < open)) return '';
  const close = style.indexOf('*/', open + 2);
  return close < 0 ? '' : style.slice(open + 2, close).replace(/\s+/g, ' ').trim();
}

async function fillCard(card, path) {
  const table = card.querySelector('cssv-table');
  const stats = card.querySelector('.card-stats');
  try {
    const url = await core.invoke('preview_file', { path });
    const text = await (await fetch(url, { cache: 'no-store' })).text();
    const model = parse(text);
    card.querySelector('.card-desc').textContent = summary(text);
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
    h('a', { className: 'card-open', href: `?${new URLSearchParams({ file: path })}`, title: path },
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
  const list = file === null ? prefs.recent() : [];
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
  $('setup').hidden = file !== null || !integration.available || integration.installed || prefs.get('setup-dismissed', false);
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

$('open').addEventListener('click', choose);
$('open-empty').addEventListener('click', choose);
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

// Dropping a file on the window opens it there.
webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
  if (payload.type === 'enter' || payload.type === 'over') $('drop').hidden = false;
  else $('drop').hidden = true;
  if (payload.type === 'drop' && payload.paths.length > 0) go(payload.paths[0]);
});

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
    state.url = await core.invoke('open_file', { path });
  } catch (error) {
    $('stage').replaceChildren();
    problems.push({ section: 'open', message: String(error), fatal: true });
    showProblems();
    return;
  }
  prefs.addRecent(path);

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
  table.src = state.url; // relative URLs in the style block resolve against the file (4.3)
  $('stage').replaceChildren(table, marks);
  await readText();
  showProblems(); // problems found before the text arrived get their lines

  // Saving the file updates the table in place: unchanged rows, the scroll
  // position and the formats of unchanged cells stay as they are.
  win.listen('cssv-file-changed', async () => {
    try {
      if (!(await readText())) return;
      table.update(shown(state.text));
      await table.ready;
      status(`Updated ${new Date().toLocaleTimeString()}`, { fade: true });
    } catch {
      // the same: wait for the next change
    }
  });
}

// --- Toolbar ----------------------------------------------------------------

const find = createFind({ stage: $('stage'), marks, host: () => state.table, model: () => state.model });
const source = createSource({
  onToggle: (open) => $('source').setAttribute('aria-pressed', String(open)),
});

$('find-open').addEventListener('click', () => find.toggle());

$('plain').addEventListener('click', () => {
  state.plain = !state.plain;
  $('plain').setAttribute('aria-pressed', String(state.plain));
  state.table?.update(shown(state.text));
});

$('source').addEventListener('click', () => source.toggle());

// Light or dark sets the window's preference, which the table's
// light-dark() values and prefers-color-scheme queries follow, as the
// viewer's own colors do. It applies to every window.
const THEMES = [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']];
function applyTheme(theme) {
  win.setTheme(theme === 'light' || theme === 'dark' ? theme : null).catch(() => {});
  const label = `Light or dark: ${THEMES.find(([v]) => v === theme)?.[1] ?? THEMES[0][1]}`;
  $('theme').title = label;
  $('theme').setAttribute('aria-label', label);
}
applyTheme(prefs.get('theme', 'system'));
prefs.watch('theme', applyTheme);
menuButton($('theme'), () => THEMES.map(([value, label]) => ({
  label,
  radio: true,
  checked: prefs.get('theme', 'system') === value,
  run: () => {
    prefs.set('theme', value);
    applyTheme(value);
  },
})), 'Light or dark');

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
menuButton($('numbers'), () => {
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
}, 'Language for numbers');

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
menuButton($('copy'), () => {
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
}, 'Copy');
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
      path = await save(encode(splitFile(state.text).data), { name: `${name}.csv`, kind: 'CSV', ext: 'csv' });
    } else if (kind === 'svg') {
      status('Drawing the table…');
      const { svg } = await svgOf(state.table, options);
      path = await save(encode(svg), { name: `${name}.svg`, kind: 'SVG image', ext: 'svg' });
    } else {
      status('Drawing the table…');
      path = await save(await pngOf(state.table, options), { name: `${name}.png`, kind: 'PNG image', ext: 'png' });
    }
    status(path ? `Saved ${split(path).name}` : '', { fade: true });
  } catch (error) {
    status(`Could not save: ${error?.message ?? error}`);
  }
}
menuButton($('export'), () => {
  const ready = !!state.table?.table;
  return [
    { label: 'Data as CSV…', disabled: !state.model, run: () => saveAs('csv') },
    { separator: true },
    { label: 'Image as PNG…', disabled: !ready, run: () => saveAs('png') },
    { label: 'Image as SVG…', disabled: !ready, run: () => saveAs('svg') },
    { separator: true },
    { label: 'Print or save as PDF…', shortcut: keys('P'), disabled: !ready, run: () => window.print() },
  ];
}, 'Save as');

// Printing prints the table alone (viewer.css), with the file's own
// @media print rules.
$('print').addEventListener('click', () => window.print());

// --- Keyboard ---------------------------------------------------------------

if (mac) {
  $('mod').textContent = '⌘';
  for (const el of document.querySelectorAll('[title*="Ctrl+"]')) el.title = el.title.replaceAll('Ctrl+', '⌘');
}

addEventListener('keydown', (event) => {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (event.key === 'F3') find.next(event.shiftKey ? -1 : 1);
  else if (event.key === 'F5') location.reload();
  else if (!mod || event.altKey) return;
  else if (key === 'o') choose();
  else if (key === 'r') location.reload();
  else if (key === 'w') win.close();
  else if (key === 'q') core.invoke('quit');
  else if (key === 'f' && file) find.open();
  else if (key === 'p' && file) window.print();
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
