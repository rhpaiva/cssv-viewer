// The home (viewer.js without a file): the recent files' cards with their
// previews, the Open menu, and setting up the AppImage to open .cssv files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, PNG, cssv, setup, until } from './harness.js';

const ctx = setup();

// The cards: name, path, description and stats.
const cards = (tab) => tab.$$eval('.card', (els) => els.map((el) => [
  el.querySelector('.card-name').textContent,
  el.querySelector('.card-path').textContent,
  el.querySelector('.card-desc').textContent,
  el.querySelector('.card-stats').textContent,
  el.classList.contains('failed'),
]));

const names = async (w) => (await w.tabs()).map((t) => (t.selected ? `[${t.name}]` : t.name));

test('the home shows the latest eight recent files as cards, each with its title, description and size', async () => {
  const recent = [];
  for (let i = 1; i <= 10; i++) {
    const path = `/home/ana/t${i}.cssv`;
    ctx.server.disk(path, cssv(null, 'a,b,c', ...Array.from({ length: i }, (_, r) => `${r},x,y`)));
    recent.push(path);
  }
  ctx.server.disk('/home/ana/t1.cssv', cssv('/* cssv:title First table */\n/* cssv:description The very first. */', 'a', '1'));
  const w = await ctx.open({ storage: { recent } });
  const tab = await w.home();
  assert.equal(await tab.$eval('#recent', (el) => el.hidden), false);
  assert.equal(await tab.$eval('#home', (el) => el.classList.contains('with-recent')), true);
  const list = await cards(tab);
  assert.equal(list.length, 8);
  assert.deepEqual(list[0], ['First table', '/home/ana/t1.cssv', 'The very first.', '1 row · 1 column', false]);
  assert.deepEqual(list[1], ['t2.cssv', '/home/ana', '', '2 rows · 3 columns', false]);
  assert.equal(await tab.$eval('.card-open', (a) => a.title), '/home/ana/t1.cssv');
});

test('a preview is the file\'s first rows, with its style block and the files it names next to it', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => `${i},"line ${i}\nnext"`);
  ctx.server.disk('/home/ana/long.cssv', cssv('td:first-child { background: url(dot.png); }', 'n,text', ...rows));
  ctx.server.disk('/home/ana/dot.png', PNG);
  ctx.server.disk('/home/ana/plain.cssv', cssv(null, 'n', '1', '2'));
  const w = await ctx.open({ storage: { recent: ['/home/ana/long.cssv', '/home/ana/plain.cssv'] } });
  const tab = await w.home();
  assert.deepEqual((await cards(tab)).map((c) => c[3]), ['100 rows · 2 columns', '2 rows · 1 column']);
  const shown = await tab.$$eval('.card cssv-table', (tables) => tables.map((t) => t.table.tBodies[0].rows.length));
  assert.deepEqual(shown, [60, 2]);
  // The url() names the file's folder, so the image loads in the preview.
  const background = await tab.$eval('.card cssv-table', (t) => getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).backgroundImage);
  assert.match(background, /\/disk\/home\/ana\/dot\.png/);
});

test('a preview reads quotes as the renderer does: one inside a value is a letter', async () => {
  // Taken for one that opens a quoted field, the first quote would cut the
  // preview inside a later quoted field with a line break.
  const rows = Array.from({ length: 70 }, (_, i) => `${i + 1},"two\nlines"`);
  ctx.server.disk('/home/ana/quotes.cssv', cssv(null, 'n,text', '0,5" disk', ...rows));
  const w = await ctx.open({ storage: { recent: ['/home/ana/quotes.cssv'] } });
  const tab = await w.home();
  const shown = await tab.$eval('.card cssv-table', (t) => [t.errors.length, t.table?.tBodies[0].rows.length, t.table?.tBodies[0].rows[0].cells[1].textContent]);
  assert.deepEqual(shown, [0, 60, '5" disk']);
});

test('a preview holds its animations still', async () => {
  ctx.server.disk('/home/ana/moving.cssv', cssv('@keyframes spin { to { rotate: 1turn; } } td { animation: spin 1s infinite; }', 'n', '1'));
  const w = await ctx.open({ storage: { recent: ['/home/ana/moving.cssv'] } });
  const tab = await w.home();
  const states = await tab.$eval('.card cssv-table', (t) => t.table.getAnimations({ subtree: true }).map((a) => a.playState));
  assert.ok(states.length > 0);
  assert.deepEqual([...new Set(states)], ['paused']);
});

test('a recent file that can\'t be read says why on its card', async () => {
  ctx.server.disk('/home/ana/broken.cssv', '---\ntd { color: red; }\nno closing fence\n');
  ctx.server.disk('/home/ana/gone-midway.cssv', cssv(null, 'a', '1'));
  const w = await ctx.open({
    storage: { recent: ['/home/ana/missing.cssv', '/home/ana/broken.cssv', '/home/ana/gone-midway.cssv'] },
  });
  // The last one is allowed, then can't be fetched.
  await w.page.route('**/disk/home/ana/gone-midway.cssv', (route) => route.abort());
  const tab = await w.home();
  const list = await cards(tab);
  assert.deepEqual(list[0], ['missing.cssv', '/home/ana', '', 'Not found.', true]);
  assert.deepEqual(list[1], ['broken.cssv', '/home/ana', '', 'The opening fence has no closing fence.', true]);
  assert.equal(list[2][4], true);
  assert.match(list[2][3], /fetch/i);
});

test('a card opens its file in this tab, and its × takes it off the recent files', async () => {
  ctx.server.disk('/home/ana/budget.cssv', BUDGET);
  ctx.server.disk('/home/ana/other.cssv', cssv(null, 'a', '1'));
  const w = await ctx.open({ storage: { recent: ['/home/ana/other.cssv', '/home/ana/budget.cssv'] } });
  let tab = await w.home();
  await tab.click('.card:nth-child(1) .card-remove');
  await until(async () => (await cards(tab)).length === 1);
  assert.deepEqual(await tab.evaluate(() => JSON.parse(localStorage.getItem('cssv-viewer:recent'))), ['/home/ana/budget.cssv']);
  await tab.click('.card-open');
  tab = await w.file();
  assert.deepEqual(await names(w), ['[Household budget]']);
  // The last card gone, the home has no recent files to show.
  await w.page.click('#new-tab');
  tab = await w.home();
  await tab.click('.card-remove');
  await until(() => tab.$eval('#recent', (el) => el.hidden));
  assert.equal(await tab.$eval('#home', (el) => el.classList.contains('with-recent')), false);
});

test('a newer list of recent files stops the previews of an older one', async () => {
  ctx.server.disk('/home/ana/slow.cssv', cssv(null, 'a', '1'), { delay: 2000 });
  ctx.server.disk('/home/ana/b.cssv', cssv(null, 'a', '1'));
  ctx.server.disk('/home/ana/c.cssv', cssv(null, 'a', '1'));
  const w = await ctx.open({ storage: { recent: ['/home/ana/slow.cssv', '/home/ana/b.cssv', '/home/ana/c.cssv'] } });
  const tab = await w.tab();
  await tab.click('.card:nth-child(3) .card-remove');
  await w.home();
  const asked = (await w.calls('preview_file')).map((c) => c.args.path);
  assert.equal(asked.filter((p) => p.endsWith('/c.cssv')).length, 0, asked.join());
  assert.equal(asked.filter((p) => p.endsWith('/b.cssv')).length, 1, asked.join());
});

test('a file opened in another window joins this home\'s recent files', async () => {
  ctx.server.disk('/home/ana/budget.cssv', BUDGET);
  const context = await ctx.context();
  const w = await ctx.open({ context });
  const tab = await w.tab();
  assert.equal(await tab.$eval('#recent', (el) => el.hidden), true);
  const other = await ctx.open({ context, opens: ['/home/ana/budget.cssv'] });
  await other.file();
  await until(async () => (await cards(tab)).length === 1);
});

test('the Open button and the home\'s Choose button ask for files', async () => {
  const w = await ctx.open();
  const tab = await w.tab();
  await tab.click('#open-empty');
  await tab.click('#open');
  await until(async () => (await w.calls('dialog.open')).length === 2);
});

test('the Open menu lists the recent files but the shown one, and clears them', async () => {
  ctx.server.disk('/home/ana/budget.cssv', BUDGET);
  ctx.server.disk('C:\\Users\\ana\\b.cssv'.replaceAll('\\', '/'), cssv(null, 'a', '1'));
  const w = await ctx.open();
  let tab = await w.tab();
  await tab.click('#open-more');
  assert.deepEqual(await tab.$$eval('.menu.open .menu-item', (els) => els.map((el) => [el.textContent, el.getAttribute('aria-disabled')])), [['No recent files', 'true']]);
  await tab.page().keyboard.press('Escape');
  await tab.evaluate(() => localStorage.setItem('cssv-viewer:recent', JSON.stringify(['C:\\Users\\ana\\b.cssv', '/home/ana/budget.cssv'])));
  await tab.click('#open-more');
  const labels = await tab.$$eval('.menu.open .menu-label', (els) => els.map((el) => el.textContent));
  // A Windows path splits at its backslashes.
  assert.deepEqual(labels, ['b.cssvC:\\Users\\ana', 'budget.cssv/home/ana', 'Clear recent files']);
  await tab.click('.menu-item:has-text("budget.cssv")');
  tab = await w.file();
  await tab.click('#open-more');
  assert.deepEqual(await tab.$$eval('.menu.open .menu-label', (els) => els.map((el) => el.textContent)), ['b.cssvC:\\Users\\ana', 'Clear recent files']);
  await tab.click('.menu-item:has-text("Clear recent files")');
  assert.deepEqual(await tab.evaluate(() => JSON.parse(localStorage.getItem('cssv-viewer:recent'))), []);
});

test('an AppImage offers to open .cssv files; setting it up says so, and "Not now" is remembered', async () => {
  const context = await ctx.context();
  const w = await ctx.open({ context, integration: { available: true, installed: false } });
  const tab = await w.tab();
  await until(async () => !(await tab.$eval('#setup', (el) => el.hidden)));
  await tab.click('#setup-yes');
  await until(() => tab.$eval('#setup', (el) => el.hidden));
  assert.deepEqual((await w.calls('set_integration')).map((c) => c.args), [{ on: true }]);
  assert.equal(await tab.textContent('#status'), 'CSSV Viewer now opens .cssv files');
  // The status fades after a while.
  await tab.waitForFunction(() => document.getElementById('status').classList.contains('fade'), null, { timeout: 4000 });
  // Set up, the Open menu offers to undo it.
  await tab.click('#open-more');
  await tab.click('.menu-item:has-text("Stop opening .cssv files")');
  await until(async () => (await tab.textContent('#status')) === 'CSSV Viewer no longer opens .cssv files');
  await tab.click('#open-more');
  await tab.click('.menu-item:has-text("Open .cssv files with CSSV Viewer")');
  await until(async () => (await w.calls('set_integration')).length === 3);
  // A failure says why.
  await w.fake((f) => { f.handlers.set_integration = () => Promise.reject('No home folder.'); });
  await tab.click('#open-more');
  await tab.click('.menu-item:has-text("Stop opening .cssv files")');
  await until(async () => (await tab.textContent('#status')) === 'No home folder.');

  const second = await ctx.open({ context, integration: { available: true, installed: false } });
  const home = await second.tab();
  await until(async () => !(await home.$eval('#setup', (el) => el.hidden)));
  await home.click('#setup-no');
  assert.equal(await home.$eval('#setup', (el) => el.hidden), true);
  const third = await ctx.open({ context, integration: { available: true, installed: false } });
  const again = await third.tab();
  await until(async () => (await third.calls('integration')).length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await again.$eval('#setup', (el) => el.hidden), true);
});

test('in a file\'s tab, which has no home, a late answer about the AppImage and setting it up from the Open menu are no errors', async () => {
  ctx.server.disk('/home/ana/budget.cssv', BUDGET);
  const w = await ctx.open();
  await w.tab();
  // The answer comes once the file has taken the home's place.
  await w.fake((f) => {
    f.handlers.integration = () => new Promise((resolve) => { f.answer = () => resolve({ available: true, installed: false }); });
  });
  await w.fake((f) => { f.opens.push('/home/ana/budget.cssv'); f.emit('cssv-open'); });
  const tab = await w.file();
  await until(() => w.page.evaluate(() => typeof __fake.answer === 'function'));
  await w.fake((f) => f.answer());
  await tab.click('#open-more');
  await tab.click('.menu-item:has-text("Open .cssv files with CSSV Viewer")');
  await until(async () => (await tab.textContent('#status')) === 'CSSV Viewer now opens .cssv files');
  assert.deepEqual(w.page.errors, []);
});

test('in a file\'s tab, clearing the recent files, or another tab adding one, is no error', async () => {
  ctx.server.disk('/home/ana/budget.cssv', BUDGET);
  ctx.server.disk('/home/ana/other.cssv', cssv(null, 'a', '1'));
  const w = await ctx.open({ storage: { recent: ['/home/ana/old.cssv'] }, opens: ['/home/ana/budget.cssv'] });
  const tab = await w.file();
  await tab.click('#open-more');
  await tab.click('.menu-item:has-text("Clear recent files")');
  // Another file opens in a tab of its own, which makes it a recent file.
  await w.fake((f) => { f.opens.push('/home/ana/other.cssv'); f.emit('cssv-open'); });
  await w.file();
  await until(() => tab.evaluate(() => JSON.parse(localStorage.getItem('cssv-viewer:recent'))?.[0] === '/home/ana/other.cssv'));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(w.page.errors, []);
});

test('the set-up offer isn\'t shown in a file\'s tab, nor once set up', async () => {
  ctx.server.disk('/home/ana/budget.cssv', BUDGET);
  const w = await ctx.open({ opens: ['/home/ana/budget.cssv'], integration: { available: true, installed: false } });
  const tab = await w.file();
  await until(async () => (await w.calls('integration')).length === 1);
  // The file took the home's place.
  assert.equal(await tab.$('#setup:not([hidden])'), null);
  assert.deepEqual(w.page.errors, []);
  const installed = await ctx.open({ integration: { available: true, installed: true } });
  const home = await installed.tab();
  await until(async () => (await installed.calls('integration')).length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await home.$eval('#setup', (el) => el.hidden), true);
});
