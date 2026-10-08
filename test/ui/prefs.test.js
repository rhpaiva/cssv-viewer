// What the viewer remembers (prefs.js, boot.js) and the two settings every
// window shares (viewer.js): light or dark, and the language for numbers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/budget.cssv';

const theme = (frame) => frame.evaluate(() => document.documentElement.dataset.theme ?? null);
const themes = (w) => w.fake((f) => f.windowCalls.filter(([c]) => c === 'setTheme').map(([, t]) => t));

async function choose(tab, button, label) {
  await tab.click(button);
  await tab.click(`.menu-item:has-text("${label}")`);
}

test('light or dark applies to the tab, the window and the table, and the next window starts with it', async () => {
  ctx.server.disk(PATH, BUDGET);
  const context = await ctx.context();
  const w = await ctx.open({ context, opens: [PATH] });
  const tab = await w.file();
  assert.equal(await tab.$eval('#theme', (b) => b.title), 'Light or dark: Match the system');
  await choose(tab, '#theme', 'Dark');
  assert.equal(await theme(tab), 'dark');
  assert.equal(await tab.$eval('#theme', (b) => b.getAttribute('aria-label')), 'Light or dark: Dark');
  assert.deepEqual(await themes(w), [null, 'dark']);
  await choose(tab, '#theme', 'Light');
  assert.equal(await theme(tab), 'light');

  // boot.js gives a new window its colors before the first paint.
  const next = await ctx.open({ context });
  assert.equal(await theme(next.page), 'light');
  const home = await next.tab();
  assert.equal(await theme(home), 'light');
  assert.deepEqual(await themes(next), ['light']);
  await choose(home, '#theme', 'Match the system');
  assert.equal(await theme(home), null);
  assert.deepEqual(await themes(next), ['light', null]);
});

test('a theme chosen in another window applies here; one taken away is the system\'s', async () => {
  const context = await ctx.context();
  const a = await ctx.open({ context });
  const tabA = await a.tab();
  const b = await ctx.open({ context });
  const tabB = await b.tab();
  await choose(tabA, '#theme', 'Dark');
  await until(async () => (await theme(tabB)) === 'dark' && (await theme(b.page)) === 'dark');
  await tabA.evaluate(() => localStorage.removeItem('cssv-viewer:theme'));
  await until(async () => (await theme(tabB)) === null && (await theme(b.page)) === null);
  assert.equal(await tabB.$eval('#theme', (el) => el.title), 'Light or dark: Match the system');
});

test('a theme stored as something else, or not as JSON, is the system\'s', async () => {
  const context = await ctx.context({ storage: { theme: 'sepia' } });
  const w = await ctx.open({ context });
  const tab = await w.tab();
  assert.equal(await theme(tab), null);
  assert.equal(await theme(w.page), null);
  assert.equal(await tab.$eval('#theme', (el) => el.title), 'Light or dark: Match the system');
  await tab.evaluate(() => localStorage.setItem('cssv-viewer:theme', '{not json'));
  const next = await ctx.open({ context });
  const again = await next.tab();
  assert.equal(await theme(next.page), null);
  assert.equal(await again.$eval('#theme', (el) => el.title), 'Light or dark: Match the system');
});

test('numbers show in the system\'s language, or in one chosen, in the table, the previews and the next windows', async () => {
  ctx.server.disk(PATH, BUDGET);
  const context = await ctx.context();
  const w = await ctx.open({ context, opens: [PATH] });
  const tab = await w.file();
  assert.equal(await tab.textContent('#numbers'), 'en-GB');
  assert.equal(await tab.$eval('#numbers', (b) => b.title), 'Numbers in the system\'s language (en-GB)');
  await tab.click('#numbers');
  const items = await tab.$$eval('.menu.open .menu-item', (els) => els.slice(0, 3).map((el) => [el.querySelector('.menu-label').firstChild.textContent, el.title, el.getAttribute('aria-checked')]));
  assert.deepEqual(items, [['System language (en-GB)', '-1,234,567.89', 'true'], ['American English', '-1,234,567.89', 'false'], ['British English', '-1,234,567.89', 'false']]);
  await tab.click('.menu-item:has-text("German (Germany)")');
  assert.equal(await tab.textContent('#numbers'), 'de-DE');
  assert.equal(await tab.$eval('#numbers', (b) => b.title), 'Numbers in German (Germany)');
  assert.equal(await tab.$eval('cssv-table', (t) => t.getAttribute('lang')), 'de-DE');
  await tab.waitForFunction(() => document.querySelector('cssv-table').table.tBodies[0].rows[1].cells[1].textContent === '350,5');

  const next = await ctx.open({ context });
  const home = await next.home();
  assert.equal(await home.textContent('#numbers'), 'de-DE');
  assert.equal(await home.$eval('.card cssv-table', (t) => t.getAttribute('lang')), 'de-DE');
  await choose(home, '#numbers', 'System language');
  assert.equal(await home.$eval('.card cssv-table', (t) => t.hasAttribute('lang')), false);
  // The other window follows.
  await tab.waitForFunction(() => !document.querySelector('cssv-table').hasAttribute('lang'));
  assert.equal(await tab.textContent('#numbers'), 'en-GB');
});

test('a language from another window that isn\'t a valid tag shows as it is; one taken away is the system\'s', async () => {
  const context = await ctx.context();
  const a = await ctx.open({ context });
  const tabA = await a.tab();
  const b = await ctx.open({ context });
  const tabB = await b.tab();
  await tabA.evaluate(() => localStorage.setItem('cssv-viewer:locale', JSON.stringify('not a tag!')));
  await until(async () => (await tabB.textContent('#numbers')) === 'not a tag!');
  assert.equal(await tabB.$eval('#numbers', (el) => el.title), 'Numbers in not a tag!');
  await tabA.evaluate(() => localStorage.removeItem('cssv-viewer:locale'));
  await until(async () => (await tabB.textContent('#numbers')) === 'en-GB');
});

test('a system language that isn\'t a valid tag is passed over for the next', async () => {
  const w = await ctx.open({ languages: ['no_such!', 'fr-FR'] });
  const tab = await w.tab();
  assert.equal(await tab.textContent('#numbers'), 'fr-FR');
});

test('without storage the viewer works as on a first run, remembering nothing', async () => {
  ctx.server.disk(PATH, BUDGET);
  const w = await ctx.open({ opens: [PATH], brokenStorage: true });
  const tab = await w.file();
  await choose(tab, '#theme', 'Dark');
  assert.equal(await theme(tab), 'dark');
  await w.page.click('#new-tab');
  const home = await w.tab();
  assert.equal(await home.$eval('#recent', (el) => el.hidden), true);
  assert.equal(await theme(home), null);
  assert.deepEqual(w.page.errors, []);
});

test('a tab opening a file doesn\'t show the home while the file loads', async () => {
  ctx.server.disk(PATH, BUDGET, { delay: 300 });
  const w = await ctx.open({ opens: [PATH] });
  const tab = await w.tab();
  assert.equal(await tab.evaluate(() => document.documentElement.classList.contains('opening')), true);
  const home = await ctx.open();
  const homeTab = await home.tab();
  assert.equal(await homeTab.evaluate(() => document.documentElement.classList.contains('opening')), false);
});
