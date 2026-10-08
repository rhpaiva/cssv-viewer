// The print preview (print.js): the table on paper as the printer gets it,
// the paper, scale and margins it sends to printing, and how it opens and
// closes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, cssv, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/budget.cssv';

async function open(text = BUDGET, options = {}) {
  ctx.server.disk(PATH, text);
  const w = await ctx.open({ opens: [PATH], ...options });
  const tab = await w.file();
  // Printing itself is the system's dialog: count the requests instead.
  await tab.evaluate(() => { window.printed = 0; window.print = () => { window.printed++; }; });
  return { w, tab };
}

const shownPreview = (tab) => tab.waitForFunction(() => document.getElementById('print-view').classList.contains('open'));
const info = (tab) => tab.textContent('#print-info');
const pages = (tab) => tab.$$eval('#papers .sheet span', (els) => els.map((el) => el.textContent));
const lastPage = async (w) => (await w.calls('set_page')).at(-1).args.page;

test('the Print button shows the table on paper, sized to the reader\'s paper, and tells printing about it', async () => {
  const { w, tab } = await open();
  await tab.click('#print');
  await shownPreview(tab);
  assert.equal(await tab.$eval('#print-view', (el) => el.hidden), false);
  assert.equal(await tab.evaluate(() => document.activeElement.id), 'print-go');
  assert.equal(await info(tab), 'A4, portrait · actual size · 1 page');
  assert.deepEqual(await pages(tab), ['Page 1 of 1']);
  assert.deepEqual(await lastPage(w), { paper: 'a4', landscape: false, margin: 12 });
  // On Linux the paper comes from the print dialog, so @page sets only the margins.
  assert.equal(await tab.evaluate(() => [...document.styleSheets].map((s) => s.ownerNode.textContent).find((t) => t?.startsWith('@page'))), '@page { margin: 12mm; }');
  assert.equal(await tab.evaluate(() => document.documentElement.style.getPropertyValue('--print-zoom')), '1');
  // The preview has the file's table, in a copy of its own.
  assert.equal(await tab.$eval('#pages cssv-table', (t) => t.table.tBodies[0].rows.length), 3);
});

test('readers in the United States and Canada start with Letter paper', async () => {
  const { w, tab } = await open(BUDGET, { locale: 'en-US' });
  await tab.click('#print');
  await shownPreview(tab);
  assert.equal(await info(tab), 'Letter, portrait · actual size · 1 page');
  assert.equal((await lastPage(w)).paper, 'letter');
});

test('paper, orientation, margins and background colors change the preview and what printing uses', async () => {
  const { w, tab } = await open();
  await tab.click('#print');
  await shownPreview(tab);
  await tab.selectOption('#print-paper', 'letter');
  await tab.selectOption('#print-orientation', 'landscape');
  await tab.selectOption('#print-margins', '0');
  assert.equal(await info(tab), 'Letter, landscape · actual size · 1 page');
  assert.deepEqual(await lastPage(w), { paper: 'letter', landscape: true, margin: 0 });
  const sheet = await tab.$eval('#papers .sheet', (el) => [parseFloat(el.style.width), parseFloat(el.style.height)]);
  assert.ok(sheet[0] > sheet[1], String(sheet));
  assert.equal(await tab.evaluate(() => document.documentElement.classList.contains('print-economy')), false);
  await tab.uncheck('#print-bg');
  assert.equal(await tab.evaluate(() => document.documentElement.classList.contains('print-economy')), true);
});

test('a table wider than the paper is scaled to fit, unless the reader asks for its actual size; a long one takes pages', async () => {
  const wide = cssv('td, th { min-width: 300px; }', 'a,b,c,d,e', ...Array.from({ length: 80 }, (_, i) => `${i},${i},${i},${i},${i}`));
  const { w, tab } = await open(wide);
  await tab.click('#print');
  await shownPreview(tab);
  const text = await info(tab);
  assert.match(text, /^A4, portrait · scaled to \d+% · \d+ pages$/);
  const zoom = Number(await tab.evaluate(() => document.documentElement.style.getPropertyValue('--print-zoom')));
  assert.ok(zoom < 1, String(zoom));
  await tab.selectOption('#print-scale', 'actual');
  assert.match(await info(tab), /^A4, portrait · actual size · \d+ pages$/);
  assert.ok((await pages(tab)).length > 1);
  assert.ok((await w.calls('set_page')).length >= 2);
});

test('without column wrapping the pages lie side by side', async () => {
  const long = cssv(null, 'a', ...Array.from({ length: 120 }, (_, i) => `${i}`));
  const { tab } = await open(long, { noColumnWrap: true });
  await tab.click('#print');
  await shownPreview(tab);
  assert.match(await info(tab), /· [2-9] pages$/);
  const sheets = await tab.$$eval('#papers .sheet', (els) => els.map((el) => [parseFloat(el.style.left), parseFloat(el.style.top)]));
  assert.equal(sheets[1][1], 0);
  assert.ok(sheets[1][0] > 0);
});

test('the preview applies the file\'s print rules and not its screen rules, and repeats the header', async () => {
  const style = '@media screen { td { color: rgb(255, 0, 0); } }\n@media print { td { color: rgb(0, 0, 255); } }';
  const { tab } = await open(cssv(style, 'a', '1'));
  await tab.click('#print');
  await shownPreview(tab);
  assert.equal(await tab.$eval('#pages cssv-table', (t) => getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).color), 'rgb(0, 0, 255)');
  assert.equal(await tab.$eval('cssv-table', (t) => getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).color), 'rgb(255, 0, 0)');
  assert.equal(await tab.$eval('#pages cssv-table', (t) => getComputedStyle(t.table.tHead).breakInside), 'avoid');
});

test('a table its print rules hide previews as one blank page', async () => {
  const { tab } = await open(cssv('@media print { table { display: none; } }', 'a', '1'));
  await tab.click('#print');
  await shownPreview(tab);
  assert.equal(await info(tab), 'A4, portrait · actual size · 1 page');
});

test('plain view previews the data without its style block, in the chosen language', async () => {
  const { tab } = await open(cssv('td { color: rgb(255, 0, 0); }', 'a', '1234.5'));
  await tab.click('#numbers');
  await tab.click('.menu-item:has-text("German (Germany)")');
  await tab.click('#plain');
  await tab.waitForFunction(() => getComputedStyle(document.querySelector('cssv-table').table.tBodies[0].rows[0].cells[0]).color !== 'rgb(255, 0, 0)');
  await tab.click('#print');
  await shownPreview(tab);
  const cell = await tab.$eval('#pages cssv-table', (t) => [t.getAttribute('lang'), getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).color, t.table.tBodies[0].rows[0].cells[0].textContent]);
  assert.notEqual(cell[1], 'rgb(255, 0, 0)');
  assert.deepEqual([cell[0], cell[2]], ['de-DE', '1234,5']);
});

test('Print… prints, as does Ctrl+P with the preview open; Escape and Close close it, giving the focus back', async () => {
  const { tab } = await open();
  const keys = tab.page().keyboard;
  await tab.focus('#copy');
  await keys.press('Control+p');
  await shownPreview(tab);
  await tab.click('#print-go');
  await keys.press('Control+p');
  assert.equal(await tab.evaluate(() => window.printed), 2);
  // The other keys wait while it's open.
  await keys.press('Control+f');
  await keys.press('F3');
  assert.equal(await tab.$eval('#find', (el) => el.hidden), true);
  await keys.press('Escape');
  await tab.waitForFunction(() => document.getElementById('print-view').hidden);
  assert.equal(await tab.evaluate(() => document.activeElement.id), 'copy');
  await tab.click('#print');
  await shownPreview(tab);
  await tab.click('#print-close');
  await tab.waitForFunction(() => document.getElementById('print-view').hidden);
  // Escape with the preview closed is someone else's.
  await keys.press('Escape');
  assert.equal(await tab.$eval('#print-view', (el) => el.hidden), true);
});

test('the Save menu and the palette open the preview too, which doesn\'t open twice', async () => {
  const { w, tab } = await open();
  await tab.click('#export');
  await tab.click('.menu-item:has-text("Print or save as PDF")');
  await shownPreview(tab);
  const before = (await w.calls('set_page')).length;
  await tab.evaluate(() => paletteCommands().find((c) => c.label === 'Print or save as PDF…').run());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await w.calls('set_page')).length, before);
});

test('the preview fades in and out, with or without a transition to wait for', async () => {
  const { tab } = await open(BUDGET, { reducedMotion: 'no-preference' });
  await tab.click('#print');
  await shownPreview(tab);
  await tab.click('#print-close');
  await tab.waitForFunction(() => document.getElementById('print-view').hidden);
  // No transition to end: it hides after a while all the same.
  await tab.addStyleTag({ content: '.print-view { transition: none !important; }' });
  await tab.click('#print');
  await shownPreview(tab);
  await tab.click('#print-close');
  await tab.waitForFunction(() => document.getElementById('print-view').hidden, null, { timeout: 2000 });
});

test('closing the preview while it opens stops it, and opening it while it closes keeps it', async () => {
  const { tab } = await open(BUDGET, { reducedMotion: 'no-preference' });
  await tab.evaluate(() => {
    document.getElementById('print').click();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await tab.$eval('#print-view', (el) => el.classList.contains('open')), false);
  await tab.click('#print');
  await shownPreview(tab);
  await tab.evaluate(() => {
    document.getElementById('print-close').click();
    document.getElementById('print').click();
  });
  await shownPreview(tab);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await tab.$eval('#print-view', (el) => el.hidden), false);
  // Close pressed twice closes it once.
  await tab.evaluate(() => {
    document.getElementById('print-close').click();
    document.getElementById('print-close').click();
  });
  await tab.waitForFunction(() => document.getElementById('print-view').hidden);
});

// Ctrl+P twice in a row: the second arrives while the preview still lays
// out its pages. With `escape`, Escape follows at once.
const ctrlPTwice = (tab, { escape = false } = {}) => tab.evaluate((escape) => {
  const ctrlP = () => dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
  ctrlP();
  ctrlP();
  if (escape) dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}, escape);

test('Ctrl+P again while the preview opens prints once the pages are laid out and printing has the paper', async () => {
  const { tab } = await open();
  await tab.evaluate(() => {
    window.print = () => {
      window.printed++;
      window.paperSet = parent.__fake.calls.some((c) => c.cmd === 'set_page');
    };
  });
  await ctrlPTwice(tab);
  await tab.waitForFunction(() => window.printed === 1);
  assert.equal(await tab.evaluate(() => window.paperSet), true);
  assert.equal(await tab.$eval('#print-view', (el) => el.classList.contains('open')), true);
});

test('closing the preview before it has laid out the pages cancels a print asked for meanwhile', async () => {
  const { tab } = await open();
  await ctrlPTwice(tab, { escape: true });
  await tab.waitForFunction(() => document.getElementById('print-view').hidden);
  // The opening stops once its table has rendered.
  await tab.evaluate(async () => {
    await document.querySelector('#pages cssv-table').ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await tab.evaluate(() => window.printed), 0);
});

test('the preview waits for the table: before it has drawn, Print does nothing', async () => {
  ctx.server.disk(PATH, BUDGET);
  const w = await ctx.open();
  await w.tab();
  const tab = await w.openSlowTable(PATH);
  await tab.click('#print');
  assert.equal(await tab.$eval('#print-view', (el) => el.hidden), true);
});

test('a failed set_page leaves the preview as it is', async () => {
  const { w, tab } = await open();
  await w.fake((f) => { f.handlers.set_page = () => Promise.reject(new Error('no window')); });
  await tab.click('#print');
  await shownPreview(tab);
  assert.deepEqual(w.page.errors, []);
});

test('on a Mac, @page names the paper too', async () => {
  const { tab } = await open(BUDGET, { platform: 'MacIntel' });
  await tab.click('#print');
  await shownPreview(tab);
  await tab.selectOption('#print-orientation', 'landscape');
  const rule = await tab.evaluate(() => [...document.styleSheets].map((s) => s.ownerNode.textContent).find((t) => t?.startsWith('@page')));
  assert.equal(rule, '@page { size: A4 landscape; margin: 12mm; }');
  await tab.selectOption('#print-orientation', 'portrait');
  assert.equal(await tab.evaluate(() => [...document.styleSheets].map((s) => s.ownerNode.textContent).find((t) => t?.startsWith('@page'))), '@page { size: A4 portrait; margin: 12mm; }');
});

test('a preview opened while a change that doesn\'t split is read shows the text as it is', async () => {
  const { w, tab } = await open();
  await tab.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      await new Promise((r) => setTimeout(r, 1000));
      return digest(...args);
    };
  });
  const id = await w.page.$eval('#frames iframe', (f) => f.dataset.tab);
  ctx.server.disk(PATH, '---\nno closing fence\n');
  await w.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await tab.waitForFunction(() => document.getElementById('source-code').textContent.includes('no closing fence'));
  await tab.click('#print');
  await until(() => tab.$eval('#pages cssv-table', (t) => !!t).catch(() => false));
  await until(async () => (await tab.$eval('#print-view', (el) => !el.hidden)));
});
