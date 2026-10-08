// Copying and saving (export.js, viewer.js): the selected cells or the
// whole table as the file has the values, and the table saved as CSV, SVG
// and PNG through the Rust side's save dialog.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, PNG, cssv, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/budget.cssv';

async function open(text = BUDGET, options = {}) {
  ctx.server.disk(PATH, text);
  const w = await ctx.open({ opens: [PATH], ...options });
  const tab = await w.file();
  // The clipboard is the system's: keep what's written to it.
  await tab.evaluate(() => {
    window.copied = [];
    navigator.clipboard.writeText = async (text) => { window.copied.push(text); };
  });
  return { w, tab };
}

const status = (tab) => tab.textContent('#status');

async function menu(tab, button, label) {
  await tab.click(button);
  await tab.click(`.menu-item:has-text("${label}")`);
}

// Selects from one cell to another: [row, column] in the table's terms,
// row 0 the header; each end a text node, or the cell itself with `asCell`.
function select(tab, from, to, { asCell = false } = {}) {
  return tab.evaluate(([from, to, asCell]) => {
    const table = document.querySelector('#stage cssv-table').table;
    const cell = ([r, c]) => (r === 0 ? table.tHead.rows[0] : table.tBodies[0].rows[r - 1]).cells[c];
    const end = (td, last) => (asCell ? [td, last ? td.childNodes.length : 0] : [td.firstChild, last ? td.firstChild.length : 0]);
    getSelection().setBaseAndExtent(...end(cell(from), false), ...end(cell(to), true));
  }, [from, to, asCell]);
}

// The last file the save dialog was given: its text or first bytes, and its headers.
const saved = (w) => w.page.evaluate(() => {
  const call = __fake.calls.filter((c) => c.cmd === 'save_file').at(-1);
  return { text: new TextDecoder().decode(call.args), head: [...call.args.slice(0, 8)], headers: call.options.headers };
});

test('the whole table copies tab-separated for spreadsheets, as Markdown, or as the file\'s data', async () => {
  const text = cssv('td { color: red; }', 'Item,Note', 'Rent,"say ""hi"""', 'Tab,"a\tb"', 'Food,"two\nlines"');
  const { tab } = await open(text);
  await menu(tab, '#copy', 'Copy the table for spreadsheets');
  await until(async () => (await status(tab)) === 'Copied the table, tab-separated');
  await menu(tab, '#copy', 'Copy the table as Markdown');
  await menu(tab, '#copy', 'Copy the data as CSV');
  const copied = await tab.evaluate(() => window.copied);
  assert.equal(copied[0], 'Item\tNote\nRent\t"say ""hi"""\nTab\t"a\tb"\nFood\t"two\nlines"\n');
  assert.equal(copied[1], '| Item | Note |\n|:--|:--|\n| Rent | say "hi" |\n| Tab | a\tb |\n| Food | two<br>lines |');
  assert.equal(copied[2], 'Item,Note\nRent,"say ""hi"""\nTab,"a\tb"\nFood,"two\nlines"\n');
  assert.equal(await status(tab), 'Copied the data section');
});

test('cells selected across the table copy as a block, from the menu or with Ctrl+C', async () => {
  const { tab } = await open();
  await select(tab, [0, 1], [2, 2]);
  await tab.click('#copy');
  assert.equal(await tab.textContent('.menu.open .menu-item'), 'Copy 6 selected cellsCtrl+C');
  await tab.click('.menu-item:has-text("Copy 6 selected cells")');
  await until(async () => (await status(tab)) === 'Copied 6 cells');
  assert.deepEqual(await tab.evaluate(() => window.copied), ['Amount\tNote\n1200\tmonthly\n350.5\tgroceries\n']);
  // Ctrl+C puts the same block on the clipboard; the selection may run backwards.
  await select(tab, [3, 2], [1, 0], { asCell: true });
  await tab.evaluate(() => addEventListener('copy', (event) => { window.clip = event.clipboardData.getData('text/plain'); }));
  await tab.page().keyboard.press('Control+c');
  await until(() => tab.evaluate(() => window.clip));
  assert.equal(await tab.evaluate(() => window.clip), 'Rent\t1200\tmonthly\nFood\t350.5\tgroceries\nFun\t-40\tcinema, popcorn\n');
  assert.equal(await status(tab), 'Copied 9 cells');
});

test('a selection inside one cell, or reaching outside the table, copies as the browser does', async () => {
  const { tab } = await open(cssv(null, 'a,b', 'x,'));
  const block = () => tab.evaluate(async () => {
    const { selectedBlock } = await import('/export.js');
    return selectedBlock(document.querySelector('#stage cssv-table'));
  });
  // No selection at all.
  await tab.evaluate(() => getSelection().removeAllRanges());
  assert.equal(await block(), null);
  // A caret.
  await tab.evaluate(() => {
    const td = document.querySelector('#stage cssv-table').table.tBodies[0].rows[0].cells[0];
    getSelection().setBaseAndExtent(td.firstChild, 1, td.firstChild, 1);
  });
  assert.equal(await block(), null);
  // Within one cell.
  await select(tab, [1, 0], [1, 0]);
  assert.equal(await block(), null);
  // An empty cell, which has no text, is a cell too.
  await select(tab, [1, 0], [1, 1], { asCell: true });
  assert.deepEqual(await block(), { rows: [1, 1], cols: [0, 1] });
  // From a cell to the toolbar.
  await tab.evaluate(() => {
    const td = document.querySelector('#stage cssv-table').table.tBodies[0].rows[0].cells[0];
    getSelection().setBaseAndExtent(td.firstChild, 0, document.getElementById('file-name').firstChild, 2);
  });
  assert.equal(await block(), null);
  // Ctrl+C with no block leaves the copy to the browser.
  await select(tab, [1, 0], [1, 0]);
  await tab.evaluate(() => addEventListener('copy', (event) => { window.clip = event.defaultPrevented; }));
  await tab.page().keyboard.press('Control+c');
  await until(async () => (await tab.evaluate(() => window.clip)) === false);
  // A browser without getComposedRanges can't see into the table.
  await select(tab, [0, 0], [1, 1], { asCell: true });
  assert.notEqual(await block(), null);
  await tab.evaluate(() => { Selection.prototype.getComposedRanges = undefined; });
  assert.equal(await block(), null);
});

test('copying that the clipboard refuses says so', async () => {
  const { tab } = await open();
  await tab.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
  await menu(tab, '#copy', 'Copy the data as CSV');
  await until(async () => (await status(tab)) === 'Could not copy: Error: denied');
});

test('copying and saving wait for what they need: a file that parses, a drawn table', async () => {
  ctx.server.disk(PATH, '---\nno closing fence\n');
  const w = await ctx.open({ opens: [PATH] });
  const tab = await w.tab();
  await until(() => tab.$eval('#problems-list', (ul) => ul.children.length === 1));
  await tab.click('#copy');
  const disabled = await tab.$$eval('.menu.open .menu-item', (els) => els.map((el) => el.getAttribute('aria-disabled')));
  assert.deepEqual(disabled, ['true', 'true', 'true', 'true']);
  await tab.click('#export');
  const save = await tab.$$eval('.menu.open .menu-item', (els) => els.map((el) => el.getAttribute('aria-disabled')));
  assert.deepEqual(save, ['true', 'true', 'true', 'true']);
});

test('before the table has drawn, the menus offer only the data', async () => {
  ctx.server.disk(PATH, BUDGET);
  const w = await ctx.open();
  await w.tab();
  const tab = await w.openSlowTable(PATH);
  await until(async () => {
    await tab.click('#copy');
    const items = await tab.$$eval('.menu.open .menu-item', (els) => els.map((el) => el.getAttribute('aria-disabled')));
    await tab.page().keyboard.press('Escape');
    return items.at(-1) === null && items;
  }).then((items) => assert.deepEqual(items, ['true', 'true', 'true', null]));
});

test('Save as CSV writes the data section where the reader chooses, starting in the file\'s folder', async () => {
  const { w, tab } = await open();
  await w.fake((f) => { f.handlers.save_file = () => '/home/ana/out/budget.csv'; });
  await menu(tab, '#export', 'Data as CSV');
  await until(async () => (await status(tab)) === 'Saved budget.csv');
  const file = await saved(w);
  assert.equal(file.text, 'Item,Amount,Note\nRent,1200,monthly\nFood,350.5,groceries\nFun,-40,"cinema, popcorn"\n');
  const id = await w.page.$eval('#frames iframe', (f) => f.dataset.tab);
  assert.deepEqual(file.headers, { 'x-tab': id, 'x-name': 'budget.csv', 'x-kind': 'CSV', 'x-ext': 'csv' });
  // Cancelled, nothing is said; a failure says why.
  await w.fake((f) => { f.handlers.save_file = () => null; });
  await menu(tab, '#export', 'Data as CSV');
  await until(async () => (await w.calls('save_file')).length === 2);
  await until(async () => (await status(tab)) === '');
  await w.fake((f) => { f.handlers.save_file = () => Promise.reject(new Error('disk full')); });
  await menu(tab, '#export', 'Data as CSV');
  await until(async () => (await status(tab)) === 'Could not save: disk full');
  await w.fake((f) => { f.handlers.save_file = () => Promise.reject('Could not save /x: denied'); });
  await menu(tab, '#export', 'Data as CSV');
  await until(async () => (await status(tab)) === 'Could not save: Could not save /x: denied');
});

test('a name with spaces and accents reaches the dialog encoded', async () => {
  const path = '/home/ana/Café menu.cssv';
  ctx.server.disk(path, BUDGET);
  const w = await ctx.open({ opens: [path] });
  const tab = await w.file();
  await menu(tab, '#export', 'Data as CSV');
  await until(async () => (await w.calls('save_file')).length === 1);
  assert.equal((await saved(w)).headers['x-name'], 'Caf%C3%A9%20menu.csv');
});

test('Save as SVG draws the table with its styles and everything they load inside the picture', async () => {
  ctx.server.disk('/home/ana/brand.css', '@import "deep.css";\nth { color: rgb(1, 2, 3); }', { type: 'text/css' });
  ctx.server.disk('/home/ana/deep.css', 'td { color: rgb(4, 5, 6); }', { type: 'text/css' });
  ctx.server.disk('/home/ana/layered.css', 'td { font-weight: 700; }', { type: 'text/css' });
  ctx.server.disk('/home/ana/notes.txt', 'not a stylesheet', { type: 'text/plain' });
  ctx.server.disk('/home/ana/untyped.css', 'td { margin: 0; }', { type: null });
  ctx.server.disk('/home/ana/dot.png', PNG);
  ctx.server.disk('/home/ana/secret.txt', 'key=1', { type: 'text/plain' });
  const style = [
    '/* @import "commented.css"; url(commented.png) */',
    '@import url("brand.css") layer(brand) supports(display: grid) screen;',
    '@import "layered.css" layer;',
    '@import "missing.css";',
    '@import "notes.txt";',
    '@import "untyped.css";',
    ':host { --edge: 1px; }',
    'td:first-child { background-image: url(dot.png); }',
    'th:first-child { background-image: url("data:image/png;base64,AAAA"); }',
    'th:nth-child(2) { background-image: url(secret.txt); }',
    'th:nth-child(3) { background-image: url(cssv://localhost/abc/home/ana/dot.png); }',
    'td::after { content: "]]>"; }',
    'td:nth-child(2)::before { content: "/* not a comment */"; }',
  ].join('\n');
  const { w, tab } = await open(cssv(style, 'Item,Amount,Note', 'Rent,1200,monthly'));
  await menu(tab, '#export', 'Image as SVG');
  await until(async () => (await w.calls('save_file')).length === 1);
  const { text: svg, headers } = await saved(w);
  assert.equal(headers['x-name'], 'budget.svg');
  assert.equal(headers['x-kind'], 'SVG%20image');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+"/);
  assert.match(svg, /<foreignObject/);
  assert.match(svg, /@layer cssv-defaults/);
  assert.match(svg, /@layer brand \{\n@supports \(display: grid\) \{\n@media screen \{\ntd \{ color: rgb\(4, 5, 6\); \}\n\nth \{ color: rgb\(1, 2, 3\); \}/);
  assert.match(svg, /@layer  \{\ntd \{ font-weight: 700; \}/);
  assert.doesNotMatch(svg, /not a stylesheet|margin: 0|commented/);
  assert.match(svg, /\.frame \{ --edge: 1px; \}/);
  assert.match(svg, /url\("data:image\/png;base64,iVBOR/);
  assert.match(svg, /url\("data:image\/png;base64,AAAA"\)/);
  // What isn't an image stays a link; a file of the reader's (a cssv: URL)
  // is left out, as its URL names the folder it is in.
  assert.match(svg, /th:nth-child\(2\) \{ background-image: url\("http:\/\/127\.0\.0\.1:\d+\/disk\/home\/ana\/secret\.txt"\); \}/);
  assert.match(svg, /th:nth-child\(3\) \{ background-image: url\(""\); \}/);
  assert.match(svg, /content: "\]\]\]\]><!\[CDATA\[>"/);
  assert.match(svg, /content: "\/\* not a comment \*\/"/);
  assert.equal(await status(tab), '');
});

test('imports nested too deep, a comment never closed and a string never closed end the style block', async () => {
  for (let i = 0; i < 12; i++) ctx.server.disk(`/home/ana/chain${i}.css`, `@import "chain${i + 1}.css";\n.c${i} { order: ${i}; }`, { type: 'text/css' });
  const style = '@import "chain0.css";\ntd { color: red; }\nth::after { content: "open';
  const { w, tab } = await open(cssv(style, 'a', '1'));
  await menu(tab, '#export', 'Image as SVG');
  await until(async () => (await w.calls('save_file')).length === 1);
  const { text: svg } = await saved(w);
  assert.match(svg, /\.c8 \{ order: 8; \}/);
  assert.doesNotMatch(svg, /\.c10 /);
  assert.match(svg, /content: "open/);

  ctx.server.disk(PATH, cssv('td { color: red; }\n/* never closed\nth { color: blue; }', 'a', '1'));
  await w.fake((f, tab) => f.emit('cssv-file-changed', tab), await w.page.$eval('#frames iframe', (f) => f.dataset.tab));
  await tab.waitForFunction(() => /^Updated /.test(document.getElementById('status').textContent));
  await menu(tab, '#export', 'Image as SVG');
  await until(async () => (await w.calls('save_file')).length === 2);
  const second = (await saved(w)).text;
  assert.match(second, /td \{ color: red; \}/);
  assert.doesNotMatch(second, /color: blue/);
});

test('an image that can\'t be read into the picture is left as it is', async () => {
  ctx.server.disk('/home/ana/dot.png', PNG);
  const { w, tab } = await open(cssv('td { background-image: url(dot.png); }', 'a', '1'));
  await tab.evaluate(() => {
    FileReader.prototype.readAsDataURL = function () {
      setTimeout(() => this.onerror());
    };
  });
  await menu(tab, '#export', 'Image as SVG');
  await until(async () => (await w.calls('save_file')).length === 1);
  assert.match((await saved(w)).text, /url\("http:\/\/127\.0\.0\.1:\d+\/disk\/home\/ana\/dot\.png"\)/);
});

test('plain view saves the picture with the default styles alone', async () => {
  const { w, tab } = await open(cssv('td { color: rgb(9, 9, 9); }', 'a', '1'));
  await tab.click('#plain');
  await tab.waitForFunction(() => getComputedStyle(document.querySelector('cssv-table').table.tBodies[0].rows[0].cells[0]).color !== 'rgb(9, 9, 9)');
  await menu(tab, '#export', 'Image as SVG');
  await until(async () => (await w.calls('save_file')).length === 1);
  assert.doesNotMatch((await saved(w)).text, /rgb\(9, 9, 9\)/);
});

test('a picture\'s animations go on from where they are, and a PNG holds them still', async () => {
  const style = [
    '@keyframes spin { to { rotate: 1turn; } }',
    'td { animation: spin 10s linear infinite, nope 3s; }',
    'th { animation: spin 4s 2s infinite; animation-timeline: scroll(self); }',
    'td::before { content: "·"; animation: spin 1s infinite; }',
  ].join('\n');
  const { w, tab } = await open(cssv(style, 'a', '1'));
  await new Promise((r) => setTimeout(r, 300));
  await menu(tab, '#export', 'Image as SVG');
  await until(async () => (await w.calls('save_file')).length === 1);
  const svg = (await saved(w)).text;
  // The cell's spin started a while ago, so its delay is negative; "nope"
  // has no keyframes and keeps its own.
  assert.match(svg, /<td[^>]*style="animation-delay: -\d+(\.\d+)?s, 0s;"/);
  // The header's scroll timeline has no time: it keeps its delay.
  assert.match(svg, /<th[^>]*style="animation-delay: 2s;"/);
  assert.doesNotMatch(svg, /animation-play-state: paused !important/);

  await w.fake((f) => { f.handlers.save_file = () => '/home/ana/budget.png'; });
  await menu(tab, '#export', 'Image as PNG');
  await until(async () => (await status(tab)) === 'Saved budget.png');
  const png = await saved(w);
  assert.deepEqual(png.head, [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.headers['x-ext'], 'png');
});

test('the save items run from the palette', async () => {
  const { w, tab } = await open();
  await tab.evaluate(() => paletteCommands().find((c) => c.group === 'Save as' && c.label === 'Data as CSV…').run());
  await until(async () => (await w.calls('save_file')).length === 1);
  await tab.evaluate(() => paletteCommands().find((c) => c.label === 'Copy the table as Markdown').run());
  await until(async () => (await tab.evaluate(() => window.copied.length)) === 1);
});

test('tableRows() gives a record shorter than the header empty values', async () => {
  const { tab } = await open();
  const rows = await tab.evaluate(async () => {
    const { tableRows } = await import('/export.js');
    return tableRows({ columns: ['a', 'b'], rows: [{ fields: ['1'] }] });
  });
  assert.deepEqual(rows, [['a', 'b'], ['1', '']]);
});
