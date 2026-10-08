// Find (find.js): searching the values as the file has them, the count,
// going through the matches, and the marks over the matched text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, cssv, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/budget.cssv';

async function open(text = BUDGET, options = {}) {
  ctx.server.disk(PATH, text, options.disk);
  const w = await ctx.open({ opens: [PATH], ...options });
  const tab = await w.file();
  return { w, tab };
}

const count = (tab) => tab.textContent('#find-count');
const marks = (tab) => tab.$$eval('.marks .mark', (els) => els.map((el) => (el.classList.contains('current') ? 'current' : 'mark')));
const markBoxes = (tab) => tab.$$eval('.marks .mark', (els) => els.map((el) => ({ width: parseFloat(el.style.width), height: parseFloat(el.style.height) })));

test('Find counts the cells whose value holds the text, header included, and marks the matched text', async () => {
  const { tab } = await open();
  await tab.click('#find-open');
  assert.equal(await tab.$eval('#find-open', (b) => b.getAttribute('aria-pressed')), 'true');
  assert.equal(await tab.evaluate(() => document.activeElement.id), 'find-text');
  assert.equal(await count(tab), '');
  await tab.fill('#find-text', 'e');
  assert.equal(await count(tab), '1 of 5');
  assert.deepEqual(await marks(tab), ['current', 'mark', 'mark', 'mark', 'mark', 'mark']); // "groceries" has two
  // A mark covers the matched letters, not the whole cell.
  const [first] = await markBoxes(tab);
  const cell = await tab.$eval('cssv-table', (t) => t.table.tHead.rows[0].cells[0].getBoundingClientRect().width);
  assert.ok(first.width < cell / 2, `${first.width} of ${cell}`);
  await tab.fill('#find-text', 'zzz');
  assert.equal(await count(tab), 'No matches');
  assert.equal(await tab.$eval('#find-count', (el) => el.classList.contains('none')), true);
  assert.deepEqual(await marks(tab), []);
  await tab.fill('#find-text', '');
  assert.equal(await count(tab), '');
  assert.equal(await tab.$eval('#find-count', (el) => el.classList.contains('none')), false);
});

test('Match case and Whole cell narrow the search; a whole cell\'s mark covers all its text', async () => {
  const { tab } = await open();
  await tab.click('#find-open');
  await tab.fill('#find-text', 'rent');
  assert.equal(await count(tab), '1 of 1');
  await tab.check('#find-case');
  assert.equal(await count(tab), 'No matches');
  await tab.fill('#find-text', 'Rent');
  assert.equal(await count(tab), '1 of 1');
  await tab.uncheck('#find-case');
  await tab.fill('#find-text', 'cinema');
  await tab.check('#find-whole');
  assert.equal(await count(tab), 'No matches');
  await tab.fill('#find-text', 'cinema, popcorn');
  assert.equal(await count(tab), '1 of 1');
  const [mark] = await markBoxes(tab);
  const text = await tab.$eval('cssv-table', (t) => {
    const range = document.createRange();
    range.selectNodeContents(t.table.tBodies[0].rows[2].cells[2]);
    return range.getBoundingClientRect().width;
  });
  assert.ok(Math.abs(mark.width - 2 - text) < 1, `${mark.width} vs ${text}`);
  // Special characters are text, not a pattern.
  await tab.uncheck('#find-whole');
  await tab.fill('#find-text', '350.5');
  assert.equal(await count(tab), '1 of 1');
  await tab.fill('#find-text', '3.0');
  assert.equal(await count(tab), 'No matches');
});

test('Enter, the arrows and F3 go through the matches, around the ends; Escape and × close Find', async () => {
  const { tab } = await open();
  const keys = tab.page().keyboard;
  await tab.click('#find-open');
  await tab.fill('#find-text', 'o');
  const total = Number((await count(tab)).split(' of ')[1]);
  assert.ok(total >= 3);
  await keys.press('Enter');
  assert.equal(await count(tab), `2 of ${total}`);
  await keys.press('Shift+Enter');
  await keys.press('Shift+Enter');
  assert.equal(await count(tab), `${total} of ${total}`);
  await tab.click('#find-next');
  assert.equal(await count(tab), `1 of ${total}`);
  await tab.click('#find-prev');
  assert.equal(await count(tab), `${total} of ${total}`);
  assert.ok((await marks(tab)).includes('current'));
  // Enter on a check box toggles it rather than going on.
  await tab.focus('#find-case');
  await keys.press('Enter');
  await keys.press('x');
  assert.equal(await count(tab), `${total} of ${total}`);
  await tab.click('#find-close');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), true);
  assert.deepEqual(await marks(tab), []);
  // Opening again searches what's in the box, staying on the same match.
  await tab.click('#find-open');
  assert.equal(await count(tab), `${total} of ${total}`);
  assert.equal(await tab.evaluate(() => getSelection().toString()), 'o');
  await keys.press('Escape');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), true);
  await keys.press('F3');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), false);
  await keys.press('F3');
  assert.equal(await count(tab), `1 of ${total}`);
  // The toolbar button closes it too.
  await tab.click('#find-open');
  assert.equal(await tab.$eval('#find-open', (b) => b.getAttribute('aria-pressed')), 'false');
  // No search going: Enter does nothing.
  await tab.click('#find-open');
  await tab.fill('#find-text', 'zzz');
  await keys.press('Enter');
  assert.equal(await count(tab), 'No matches');
});

test('a value the table shows formatted, or replaced, is marked whole; a cell the style block hides counts without a mark', async () => {
  const style = [
    'td:nth-child(2) { --cssv-format: "minimumFractionDigits: 2"; }',
    'td:nth-child(3) { display: none; }',
    'th:first-child { font-size: 0; }',
  ].join('\n');
  const { tab } = await open(cssv(style, 'Item,Amount,Note', 'Rent,1200,monthly'));
  await tab.click('#find-open');
  await tab.fill('#find-text', '1200');
  assert.equal(await count(tab), '1 of 1');
  const [mark] = await markBoxes(tab);
  const shown = await tab.$eval('cssv-table', (t) => {
    const cell = t.table.tBodies[0].rows[0].cells[1];
    const range = document.createRange();
    range.selectNodeContents(cell);
    return [cell.textContent, range.getBoundingClientRect().width];
  });
  assert.equal(shown[0], '1,200.00');
  assert.ok(Math.abs(mark.width - 2 - shown[1]) < 1);
  await tab.fill('#find-text', 'month');
  assert.equal(await count(tab), '1 of 1');
  assert.deepEqual(await marks(tab), []);
  // A header whose text has no size: the cell is marked.
  await tab.fill('#find-text', 'item');
  assert.equal(await count(tab), '1 of 1');
  const [box] = await markBoxes(tab);
  const th = await tab.$eval('cssv-table', (t) => t.table.tHead.rows[0].cells[0].getBoundingClientRect().toJSON());
  assert.ok(Math.abs(box.width - 2 - th.width) < 1 && box.height > 0);
});

test('a file that doesn\'t parse has nothing to find', async () => {
  ctx.server.disk(PATH, '---\nno closing fence\n');
  const w = await ctx.open({ opens: [PATH] });
  const tab = await w.tab();
  await until(() => tab.$eval('#problems-list', (ul) => ul.children.length === 1));
  await tab.click('#find-open');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), true);
});

test('the marks follow the table: a change searches the new values, and a resized stage moves them', async () => {
  const { w, tab } = await open();
  await tab.click('#find-open');
  await tab.fill('#find-text', 'rent');
  assert.equal(await count(tab), '1 of 1');
  const id = await w.page.$eval('#frames iframe', (f) => f.dataset.tab);
  ctx.server.disk(PATH, BUDGET.replace('Food,350.5,groceries', 'Rent,350.5,groceries'));
  await w.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await until(async () => (await count(tab)) === '1 of 2');
  await tab.click('#source'); // the source pane narrows the stage, which draws the marks again
  assert.equal((await marks(tab)).length, 2);
  // Closed, Find doesn't search a change.
  await tab.click('#find-close');
  ctx.server.disk(PATH, BUDGET);
  await w.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await tab.waitForFunction(() => /^Updated /.test(document.getElementById('status').textContent));
  assert.equal(await count(tab), '1 of 2');
});

test('matches found before the table has drawn their cells have no marks yet', async () => {
  ctx.server.disk(PATH, BUDGET);
  const w = await ctx.open();
  await w.tab();
  const tab = await w.openSlowTable(PATH);
  await until(async () => {
    await tab.click('#find-open').catch(() => {});
    return !(await tab.$eval('#find', (el) => el.hidden));
  });
  await tab.fill('#find-text', 'e');
  assert.equal(await count(tab), '1 of 5');
  assert.deepEqual(await marks(tab), []);
  await tab.page().keyboard.press('Enter');
  assert.equal(await count(tab), '2 of 5');
  // Drawn, the table gets its marks.
  await w.file();
  await until(async () => (await marks(tab)).length === 6);
});

test('matches in rows the table hasn\'t drawn yet have no marks', async () => {
  const { w, tab } = await open();
  await tab.click('#find-open');
  // The change's style block is hashed slowly, so the new values are read
  // before the table shows them.
  await tab.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      await new Promise((r) => setTimeout(r, 800));
      return digest(...args);
    };
  });
  const id = await w.page.$eval('#frames iframe', (f) => f.dataset.tab);
  ctx.server.disk(PATH, `${BUDGET}Extra,1,zebra\n`);
  await w.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await tab.waitForFunction(() => document.getElementById('source-code').textContent.includes('zebra'));
  await tab.fill('#find-text', 'zebra');
  assert.equal(await count(tab), '1 of 1');
  assert.deepEqual(await marks(tab), []);
  await until(async () => (await marks(tab)).length === 1);
});
