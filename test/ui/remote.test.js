// Remote content (viewer.js, SPEC 11.2): what a file loads from the internet
// is blocked and listed until the reader allows it for the file's style
// block, for the window or always.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cssv, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/remote.cssv';

const STYLE = [
  '@import url(http://remote.test/theme.css);',
  'td:nth-child(1) { background-image: url(http://remote.test/1.png); }',
  'td:nth-child(2) { background-image: url(http://remote.test/2.png); }',
  'th:nth-child(1) { background-image: url(http://remote.test/3.png); }',
  'th:nth-child(2) { background-image: url(http://remote.test/4.png); }',
  'tr:nth-child(2) td { border-image: url(http://remote.test/1.png) 1; }', // the same URL again
  'thead { background-image: url(http://localhost:1/x.png), url(http://box.localhost/y.png); }',
  'table { background-image: url(http://remote.test/5.png); }',
].join('\n');
const FILE = cssv(STYLE, 'Item,Amount', 'Rent,1200', 'Food,350');

// Remote requests the reader allows are answered here.
async function serveRemote(w) {
  await w.page.route('http://remote.test/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: 'td { color: rgb(0, 128, 0); }' });
    return route.fulfill({ status: 404 });
  });
}

async function open(options = {}, text = FILE) {
  ctx.server.disk(PATH, text);
  const w = await ctx.open({ opens: [PATH], ...options });
  await serveRemote(w);
  const tab = await w.file();
  return { w, tab };
}

const listed = (tab) => tab.$$eval('#remote-list li', (lis) => lis.map((li) => li.textContent));
const color = (tab) => tab.$eval('cssv-table', (t) => getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).color);
const reloaded = (tab) => until(async () => (await tab.evaluate(() => window.marker).catch(() => 1)) === undefined);

test('remote loads are blocked and listed in a bar by kind, once each, five at most', async () => {
  const { tab } = await open();
  await until(async () => (await listed(tab)).length === 6);
  const list = await listed(tab);
  assert.equal(list.at(-1), 'and 1 more');
  assert.ok(list.includes('stylesheethttp://remote.test/theme.css'), list.join('\n'));
  assert.ok(list.some((l) => /^imagehttp:\/\/remote\.test\/\d\.png$/.test(l)), list.join('\n'));
  // Nothing from this machine's names is listed.
  assert.ok(!list.some((l) => /localhost/.test(l)));
  assert.equal(await tab.$eval('#remote', (el) => el.hidden), false);
  assert.notEqual(await color(tab), 'rgb(0, 128, 0)');
  assert.equal(await tab.$eval('#remote-list code', (c) => c.title), (await tab.$eval('#remote-list code', (c) => c.textContent)));
});

test('a fetch blocked by the policy is listed as a resource; an inline script isn\'t a load', async () => {
  const { tab } = await open({}, cssv('td { color: red; }', 'Item', 'Rent'));
  await tab.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.ran = true';
    document.body.append(script);
  });
  await tab.evaluate(() => fetch('http://remote.test/data.json').catch(() => {}));
  await until(async () => (await listed(tab)).length === 1);
  assert.deepEqual(await listed(tab), ['resourcehttp://remote.test/data.json']);
  assert.equal(await tab.evaluate(() => window.ran), undefined);
});

test('a file:// URL in the style block isn\'t listed', async () => {
  const { tab } = await open({}, cssv('td { background-image: url(file:///etc/x.png); } th { background-image: url(http://remote.test/9.png); }', 'Item', 'Rent'));
  await until(async () => (await listed(tab)).length === 1);
  assert.deepEqual(await listed(tab), ['imagehttp://remote.test/9.png']);
});

test('Allow loads the remote content for this window; its chip offers to always allow it, or block it again', async () => {
  const { w, tab } = await open();
  await until(async () => (await listed(tab)).length > 0);
  await tab.evaluate(() => { window.marker = 1; });
  await tab.click('#remote-allow');
  await reloaded(tab);
  await w.file();
  await until(async () => (await color(tab)) === 'rgb(0, 128, 0)');
  assert.match(await tab.evaluate(() => location.search), /[?&]remote=[0-9a-f]{64}/);
  assert.equal(await tab.$eval('#remote', (el) => el.hidden), true);
  assert.equal(await tab.$eval('#remote-on', (el) => el.hidden), false);
  await tab.click('#remote-on');
  assert.deepEqual(await tab.$$eval('.menu.open > *', (els) => els.map((el) => el.textContent)), [
    'Allowed until the window closes', 'Always allow for this file', 'Block remote content',
  ]);
  await tab.click('.menu-item:has-text("Always allow")');
  await tab.click('#remote-on');
  assert.deepEqual(await tab.$$eval('.menu.open > *', (els) => els.map((el) => el.textContent)), ['Allowed for this file', 'Block remote content']);
  await tab.evaluate(() => { window.marker = 1; });
  await tab.click('.menu-item:has-text("Block remote content")');
  await reloaded(tab);
  await w.file();
  assert.doesNotMatch(await tab.evaluate(() => location.search), /remote=/);
  await until(async () => (await listed(tab)).length > 0);
  assert.notEqual(await color(tab), 'rgb(0, 128, 0)');
  assert.deepEqual(await tab.evaluate(() => JSON.parse(localStorage.getItem('cssv-viewer:remote-allowed'))), []);
});

test('Always allow remembers the file with its style block: it loads at once next time, and a new style block asks again', async () => {
  const context = await ctx.context();
  const { w, tab } = await open({ context });
  await until(async () => (await listed(tab)).length > 0);
  await tab.evaluate(() => { window.marker = 1; });
  await tab.click('#remote-always');
  await reloaded(tab);
  await w.file();
  await until(async () => (await color(tab)) === 'rgb(0, 128, 0)');

  const other = await ctx.open({ context, opens: [PATH] });
  await serveRemote(other);
  const again = await other.file();
  await until(async () => (await color(again)) === 'rgb(0, 128, 0)');
  assert.equal(await again.$eval('#remote-on', (el) => el.hidden), false);
  assert.doesNotMatch(await again.evaluate(() => location.search), /remote=/);

  // A change to the data alone keeps it allowed.
  const id = await other.page.$eval('#frames iframe', (f) => f.dataset.tab);
  ctx.server.disk(PATH, FILE.replace('Rent,1200', 'Rent,1300'));
  await other.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await again.waitForFunction(() => /^Updated /.test(document.getElementById('status').textContent));
  // Another style block reloads the tab without it, which asks again.
  await again.evaluate(() => { window.marker = 1; });
  ctx.server.disk(PATH, FILE.replace('theme.css', 'other.css'));
  await other.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await reloaded(again);
  await other.file();
  await until(async () => (await listed(again)).length > 0);
  assert.equal(await again.$eval('#remote', (el) => el.hidden), false);
});

test('a path remembered before the style block\'s hash was asks again', async () => {
  const { tab } = await open({ storage: { 'remote-allowed': [PATH, ['/home/ana/other.cssv', 'abc']] } });
  await until(async () => (await listed(tab)).length > 0);
  assert.equal(await tab.$eval('#remote-on', (el) => el.hidden), true);
});

test('Don\'t allow hides the bar, and more blocked loads don\'t bring it back', async () => {
  const { tab } = await open();
  await until(async () => (await listed(tab)).length > 0);
  await tab.click('#remote-deny');
  assert.equal(await tab.$eval('#remote', (el) => el.hidden), true);
  await tab.evaluate(() => fetch('http://remote.test/more.json').catch(() => {}));
  await until(async () => (await listed(tab)).length === 6);
  assert.equal(await tab.$eval('#remote', (el) => el.hidden), true);
});

test('the home\'s previews never load remote content, nor show the bar', async () => {
  ctx.server.disk(PATH, FILE);
  const w = await ctx.open({ storage: { recent: [PATH] } });
  await serveRemote(w);
  const tab = await w.home();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await tab.$eval('#remote', (el) => el.hidden), true);
  const cell = await tab.$eval('.card cssv-table', (t) => getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).color);
  assert.notEqual(cell, 'rgb(0, 128, 0)');
});
