// A file's tab (viewer.js): opening the file, the problems the renderer
// reports and the lines they come from, updates when the file changes,
// plain view, and the tab's keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, cssv, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/budget.cssv';

async function open(text = BUDGET, options = {}, path = PATH) {
  ctx.server.disk(path, text);
  const w = await ctx.open({ opens: [path], ...options });
  const tab = await w.file();
  return { w, tab, path };
}

// The problems listed: "§section message (Line n)".
const problems = (tab) => tab.$$eval('#problems-list li', (lis) => lis.map((li) => [...li.children].map((c) => c.textContent).join(' ')));
const tabId = (w) => w.page.$eval('#frames iframe:not([hidden])', (f) => f.dataset.tab);

// Waits for a tab's page that set window.marker to load again.
async function reloaded(tab) {
  await until(async () => (await tab.evaluate(() => window.marker).catch(() => 1)) === undefined);
}

async function change(w, tab, text, path = PATH) {
  ctx.server.disk(path, text);
  await w.fake((f, id) => f.emit('cssv-file-changed', id), await tabId(w));
}

test('a file\'s tab names the file and its folder, and titles the page after the file for printing', async () => {
  const { tab } = await open();
  assert.equal(await tab.textContent('#file-name'), 'budget.cssv');
  assert.equal(await tab.textContent('#file-folder'), '/home/ana');
  assert.equal(await tab.$eval('#file-folder', (el) => el.title), PATH);
  assert.equal(await tab.title(), 'budget');
  assert.deepEqual(await tab.evaluate(() => JSON.parse(localStorage.getItem('cssv-viewer:recent'))), [PATH]);
  // The tools that need a file are enabled.
  assert.equal(await tab.$eval('#copy', (b) => b.disabled), false);
  assert.equal(await tab.textContent('#status'), '');
});

test('a file named only by its extension prints as "table"', async () => {
  const { tab } = await open(BUDGET, {}, '/home/ana/.cssv');
  assert.equal(await tab.title(), 'table');
});

test('a file that can\'t be opened says why, as a problem that opens by itself', async () => {
  const w = await ctx.open({ opens: ['/home/ana/missing.cssv'] });
  const tab = await w.tab();
  await until(async () => (await problems(tab)).length === 1);
  assert.deepEqual(await problems(tab), ['open /home/ana/missing.cssv is not a file.']);
  assert.equal(await tab.$eval('#problems', (el) => el.hidden), false);
  assert.equal(await tab.textContent('#problems-toggle'), '1 problem');
  assert.equal(await tab.$eval('#problems-toggle', (b) => b.getAttribute('aria-expanded')), 'true');
  assert.equal(await tab.$('#stage cssv-table'), null);
  // The toggle hides and shows the list.
  await tab.click('#problems-toggle');
  assert.equal(await tab.$eval('#problems', (el) => el.hidden), true);
  assert.equal(await tab.$eval('#problems-toggle', (b) => b.getAttribute('aria-expanded')), 'false');
  await tab.click('#problems-toggle');
  assert.equal(await tab.$eval('#problems', (el) => el.hidden), false);
});

test('a file gone between opening and reading it shows the renderer\'s load problem, without a line', async () => {
  const w = await ctx.open();
  await w.tab();
  await w.fake((f) => { f.handlers.open_file = async () => `${location.origin}/disk/nowhere/gone.cssv`; });
  await w.fake((f) => { f.opens.push('/home/ana/gone.cssv'); f.emit('cssv-open'); });
  const tab = await w.tab();
  await until(async () => (await problems(tab)).length === 1);
  const [problem] = await problems(tab);
  assert.match(problem, /^load Could not load .*\(HTTP 404\)\.$/);
  // The tab took no title: there was no text to read it from.
  assert.equal((await w.tabs())[0].name, 'gone.cssv');
});

test('each problem points at the line it comes from, which shows in the source', async () => {
  ctx.server.file('/disk/home/ana/missing.css', 'nope', { status: 404, type: 'text/css' });
  const text = cssv([
    '@import url(missing.css);',
    ':host { --cssv-key: Nope; }',
    'td { --cssv-format: bogus; }',
  ].join('\n'), 'Item,Amount', 'Rent,1200');
  const { tab } = await open(text);
  await until(async () => (await problems(tab)).length === 3);
  const list = await problems(tab);
  assert.ok(list.some((p) => p.startsWith('§4.2 ') && p.endsWith(' Line 2')), list.join('\n'));
  assert.ok(list.includes('§9.1 No column is named "Nope", so rows get no data-key. Line 3'), list.join('\n'));
  assert.ok(list.includes('§9.2 --cssv-format has an invalid value: bogus Line 4'), list.join('\n'));
  assert.equal(await tab.textContent('#problems-toggle'), '3 problems');
  // Not fatal: the list stays closed until asked for.
  assert.equal(await tab.$eval('#problems', (el) => el.hidden), true);
  await tab.click('#problems-toggle');
  await tab.click('#problems-list li:has-text("§9.2") button.line');
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), false);
  assert.equal(await tab.$eval('#source-band', (el) => el.hidden), false);
  assert.equal(await tab.$eval('#source', (b) => b.getAttribute('aria-pressed')), 'true');
});

test('problems without a line in the file: an invalid key, a format over two lines, and too many cells', async () => {
  const text = cssv(':host { --cssv-key: 12 34; }\ntd {\n  --cssv-format: bogus\n    stuff;\n}', 'Item,Amount', 'Rent,1200');
  const { tab } = await open(text);
  await until(async () => (await problems(tab)).length === 2);
  const list = await problems(tab);
  assert.ok(list.includes('§9 --cssv-key has an invalid value: 12 34 Line 2'), list.join('\n'));
  // The value isn't on one line, so the line is the declaration's.
  assert.ok(list.some((p) => p.startsWith('§9.2') && p.endsWith('Line 4')), list.join('\n'));

  const wide = `a\n1\n${','.repeat(400_000)}\n`;
  const big = await open(wide, {}, '/home/ana/wide.cssv');
  await until(async () => (await problems(big.tab)).length === 1);
  const [problem] = await problems(big.tab);
  assert.match(problem, /^§11\.6 The table would have .* cells/);
  assert.equal(await big.tab.$('#problems-list button.line'), null);
});

test('a malformed file\'s problem opens by itself and points at its line: a missing fence, a quote never closed', async () => {
  const fence = await open('---\ntd { color: red; }\nItem\nRent\n', {}, '/home/ana/fence.cssv');
  await until(async () => (await problems(fence.tab)).length === 1);
  assert.deepEqual(await problems(fence.tab), ['§3.4 The opening fence has no closing fence. Line 1']);
  assert.equal(await fence.tab.$eval('#problems', (el) => el.hidden), false);
  // No title to read without a closing fence: the tab keeps the file's name.
  assert.equal((await fence.w.tabs())[0].name, 'fence.cssv');

  const quote = await open(cssv('td { color: red; }', 'Item,Note', 'Rent,"fine"', 'Food,"never', 'closed'), {}, '/home/ana/quote.cssv');
  await until(async () => (await problems(quote.tab)).length === 1);
  assert.deepEqual(await problems(quote.tab), ['§5 A quoted field is not terminated. Line 6']);
});

test('saving the file updates its table in place and says when', async () => {
  const { w, tab } = await open();
  await tab.evaluate(() => { window.marker = 1; });
  await change(w, tab, BUDGET.replace('Rent,1200', 'Rent,1300'));
  await tab.waitForFunction(() => /^Updated /.test(document.getElementById('status').textContent));
  assert.equal(await tab.evaluate(() => window.marker), 1); // not reloaded
  assert.equal(await tab.$eval('cssv-table', (t) => t.table.tBodies[0].rows[0].cells[1].textContent), '1300');
  // Another tab's change isn't this tab's.
  ctx.server.disk(PATH, BUDGET.replace('Rent,1200', 'Rent,1400'));
  await w.fake((f) => f.emit('cssv-file-changed', 'another-tab'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await tab.$eval('cssv-table', (t) => t.table.tBodies[0].rows[0].cells[1].textContent), '1300');
});

test('a change that can\'t be read yet (removed, mid-save, unreadable) leaves the table as it is', async () => {
  const { w, tab } = await open();
  const id = await tabId(w);
  ctx.server.remove(PATH);
  await w.fake((f, tabId) => f.emit('cssv-file-changed', tabId), id);
  await w.page.route('**/disk/home/ana/budget.cssv', (route) => route.abort());
  ctx.server.disk(PATH, BUDGET);
  await w.fake((f, tabId) => f.emit('cssv-file-changed', tabId), id);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await tab.textContent('#status'), '');
  assert.equal(await tab.$eval('cssv-table', (t) => t.table.tBodies[0].rows.length), 3);
  assert.deepEqual(w.page.errors, []);
});

test('a change whose style block can\'t be hashed still updates the table', async () => {
  const { w, tab } = await open();
  await tab.evaluate(() => { crypto.subtle.digest = () => Promise.reject(new Error('no digest')); });
  await change(w, tab, BUDGET.replace('Rent,1200', 'Rent,1500'));
  await tab.waitForFunction(() => /^Updated /.test(document.getElementById('status').textContent));
  assert.equal(await tab.$eval('cssv-table', (t) => t.table.tBodies[0].rows[0].cells[1].textContent), '1500');
});

test('the tab takes the title a changed file gives itself', async () => {
  const { w, tab } = await open();
  await change(w, tab, BUDGET.replace('Household budget', 'Our budget'));
  await until(async () => (await w.tabs())[0].name === 'Our budget');
  await change(w, tab, BUDGET.replace('/* cssv:title Household budget */', ''));
  await until(async () => (await w.tabs())[0].name === 'budget.cssv');
});

test('plain view shows the data without its style block, and back', async () => {
  const { w, tab } = await open(cssv('td { color: rgb(255, 0, 0); }', 'Item,Amount', 'Rent,1200'));
  const color = () => tab.$eval('cssv-table', (t) => getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).color);
  assert.equal(await color(), 'rgb(255, 0, 0)');
  await tab.click('#plain');
  await tab.waitForFunction(() => document.querySelector('cssv-table').table && getComputedStyle(document.querySelector('cssv-table').table.tBodies[0].rows[0].cells[0]).color !== 'rgb(255, 0, 0)');
  assert.equal(await tab.$eval('#plain', (b) => b.getAttribute('aria-pressed')), 'true');
  // A change shows plain too.
  await change(w, tab, cssv('td { color: rgb(255, 0, 0); }', 'Item,Amount', 'Rent,1300'));
  await tab.waitForFunction(() => document.querySelector('cssv-table').table?.tBodies[0].rows[0].cells[1].textContent === '1300');
  assert.notEqual(await color(), 'rgb(255, 0, 0)');
  await tab.click('#plain');
  await tab.waitForFunction(() => getComputedStyle(document.querySelector('cssv-table').table.tBodies[0].rows[0].cells[0]).color === 'rgb(255, 0, 0)');
});

test('plain view of a file that doesn\'t split shows the renderer\'s reason', async () => {
  const { w, tab } = await open();
  await tab.click('#plain');
  await change(w, tab, '---\nno closing fence\n');
  await until(async () => (await problems(tab)).some((p) => p.startsWith('§3.4')));
});

test('F3 and Shift+F3 open Find and go through the matches; Ctrl+F opens it', async () => {
  const { tab } = await open();
  const keys = tab.page().keyboard;
  await keys.press('F3');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), false);
  await keys.type('e');
  assert.equal(await tab.textContent('#find-count'), '1 of 5');
  await keys.press('F3');
  assert.equal(await tab.textContent('#find-count'), '2 of 5');
  await keys.press('Shift+F3');
  assert.equal(await tab.textContent('#find-count'), '1 of 5');
  await keys.press('Escape');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), true);
  await keys.press('Control+f');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), false);
});

test('Ctrl+U shows and hides the source; Ctrl+R and F5 reload the file', async () => {
  const { w, tab } = await open();
  const keys = tab.page().keyboard;
  await keys.press('Control+u');
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), false);
  await keys.press('Control+u');
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), true);
  for (const key of ['Control+r', 'F5']) {
    await tab.evaluate(() => { window.marker = 1; });
    await keys.press(key);
    await reloaded(tab);
    await w.file();
  }
  // Other keys, with or without Ctrl, are the page's.
  const again = await w.tab();
  await again.evaluate(() => { window.marker = 2; });
  await keys.press('Control+Alt+r');
  await keys.press('Control+j');
  await keys.press('x');
  assert.equal(await again.evaluate(() => window.marker), 2);
});

test('in the home, the keys for a file\'s tools do nothing', async () => {
  const w = await ctx.open();
  const tab = await w.tab();
  const keys = w.page.keyboard;
  for (const key of ['Control+p', 'Control+f', 'Control+u']) await keys.press(key);
  assert.equal(await tab.$eval('#find', (el) => el.hidden), true);
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), true);
  assert.equal(await tab.$eval('#print-view', (el) => el.hidden), true);
  // The tools that need a file are disabled.
  assert.equal(await tab.$eval('#copy', (b) => b.disabled), true);
});

test('the source opens with the file when it was open last time', async () => {
  const { tab } = await open(BUDGET, { storage: { 'source-open': true } });
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), false);
  assert.match(await tab.textContent('#source-info'), /^9 lines$/);
});

test('on a Mac the tab\'s keys take Command, and its hints and tooltips say ⌘', async () => {
  const { tab } = await open(BUDGET, { platform: 'MacIntel' });
  const keys = tab.page().keyboard;
  await keys.press('Control+u');
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), true);
  await keys.press('Meta+u');
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), false);
  assert.equal(await tab.$eval('#print', (b) => b.title), 'Print or save as PDF (⌘P)');
  await tab.click('#copy');
  assert.equal(await tab.$eval('.menu.open kbd', (k) => k.textContent), '⌘C');
});

test('the home on a Mac shows ⌘ in its hints', async () => {
  const w = await ctx.open({ platform: 'MacIntel' });
  const tab = await w.tab();
  assert.deepEqual(await tab.$$eval('.hint .mod', (els) => els.map((el) => el.textContent)), ['⌘', '⌘']);
});

test('the tab\'s palette commands follow its state', async () => {
  const { w, tab } = await open();
  const labels = () => tab.evaluate(() => paletteCommands().filter((c) => !c.group).map((c) => c.label));
  assert.ok((await labels()).includes('Show the source'));
  assert.ok((await labels()).includes('Plain view: the data without its styles'));
  await tab.click('#source');
  await tab.click('#plain');
  assert.ok((await labels()).includes('Hide the source'));
  assert.ok((await labels()).includes('Show the file with its styles'));
  await tab.evaluate(() => paletteCommands().find((c) => c.label === 'Show the file with its styles').run());
  assert.equal(await tab.$eval('#plain', (b) => b.getAttribute('aria-pressed')), 'false');
  await tab.evaluate(() => { window.marker = 1; paletteCommands().find((c) => c.label === 'Reload the file').run(); });
  await reloaded(tab);
  await w.file();
  // The home offers the window-wide items only.
  await w.page.click('#new-tab');
  const home = await w.tab();
  const groups = await home.evaluate(() => [...new Set(paletteCommands().map((c) => c.group))]);
  assert.deepEqual(groups, ['Light or dark', 'Numbers in']);
});

// Opens PATH in a home tab whose page reads the file once (`first`), then
// lets the table load what the disk has.
async function openRacing(first) {
  const w = await ctx.open();
  await w.tab();
  let reads = 0;
  // The fake's own check that the file exists (a HEAD) isn't a read.
  await w.page.route('**/disk/home/ana/budget.cssv', (route) => (route.request().method() === 'GET' && ++reads === 1 ? first(route) : route.continue()));
  await w.fake((f) => { f.opens.push('/home/ana/budget.cssv'); f.emit('cssv-open'); });
  return { w, tab: await w.tab() };
}

test('a file the tab can\'t read but its table can still shows, without a title', async () => {
  ctx.server.disk(PATH, BUDGET);
  const { w } = await openRacing((route) => route.abort());
  await w.file();
  assert.equal((await w.tabs())[0].name, 'budget.cssv');
  assert.deepEqual(w.page.errors, []);
});

test('a file saved again while its tab opens it: a quote never closed that the text the tab read doesn\'t have has no line', async () => {
  ctx.server.disk(PATH, cssv(null, 'Item', '"never closed'));
  const { tab } = await openRacing((route) => route.fulfill({ body: 'Item\nRent\n', contentType: 'text/plain' }));
  await until(async () => (await problems(tab)).length === 1);
  assert.deepEqual(await problems(tab), ['§5 A quoted field is not terminated.']);
});

test('a file saved again while its tab opens it: a problem in the new text that the old one can\'t place has no line', async () => {
  ctx.server.disk(PATH, cssv(null, 'Item', '"never closed'));
  const { tab } = await openRacing((route) => route.fulfill({ body: '---\nno closing fence\n', contentType: 'text/plain' }));
  await until(async () => (await problems(tab)).length === 1);
  assert.deepEqual(await problems(tab), ['§5 A quoted field is not terminated.']);
});

test('a quote inside a value is a letter, as the renderer reads it: the line is where the quoted field that never ends begins', async () => {
  const { tab } = await open(cssv(null, 'a,b', 'x"y,1', '"open,2'));
  await until(async () => (await problems(tab)).length === 1);
  assert.deepEqual(await problems(tab), ['§5 A quoted field is not terminated. Line 3']);

  // With semicolons, a comma is a letter; so is a quote after a quoted
  // field's end, and a doubled quote inside one is a quote.
  const lines = ['Item;Note', 'Rent;"a,b ""c"""x"', 'Food;"never', 'closed'];
  const semi = await open(cssv('td { color: red; }', ...lines), {}, '/home/ana/semi.cssv');
  await until(async () => (await problems(semi.tab)).length === 1);
  assert.deepEqual(await problems(semi.tab), ['§5 A quoted field is not terminated. Line 6']);
});
