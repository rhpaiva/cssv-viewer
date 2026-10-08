// The source pane (source.js) and its colors (highlight.js): the file's
// text with line numbers, jumping to a line, and the divider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, cssv, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/budget.cssv';

async function open(text = BUDGET, options = {}) {
  ctx.server.disk(PATH, text);
  const w = await ctx.open({ opens: [PATH], ...options });
  const tab = await w.file();
  return { w, tab };
}

const paneWidth = (tab) => tab.$eval('#source-pane', (el) => parseFloat(el.style.width) || el.getBoundingClientRect().width);

test('the source shows the file\'s text with its line numbers, and remembers being open', async () => {
  const { tab } = await open();
  await tab.click('#source');
  assert.equal(await tab.$eval('#source-pane', (el) => el.hidden), false);
  assert.equal(await tab.$eval('#source-divider', (el) => el.hidden), false);
  assert.equal(await tab.textContent('#source-code'), BUDGET);
  assert.equal(await tab.textContent('#source-gutter'), '1\n2\n3\n4\n5\n6\n7\n8\n9');
  assert.equal(await tab.textContent('#source-info'), '9 lines');
  assert.equal(await tab.evaluate(() => localStorage.getItem('cssv-viewer:source-open')), 'true');
  await tab.click('#source');
  assert.equal(await tab.evaluate(() => localStorage.getItem('cssv-viewer:source-open')), 'false');
});

test('a one-line file says "1 line"; a change shows the new text; the same text isn\'t drawn again', async () => {
  const { w, tab } = await open('a');
  await tab.click('#source');
  assert.equal(await tab.textContent('#source-info'), '1 line');
  const id = await w.page.$eval('#frames iframe', (f) => f.dataset.tab);
  await tab.evaluate(() => { document.getElementById('source-code').firstChild.marker = 1; });
  // A change to the file's time alone: the same text.
  await w.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await tab.waitForFunction(() => /^Updated /.test(document.getElementById('status').textContent));
  assert.equal(await tab.evaluate(() => document.getElementById('source-code').firstChild.marker), 1);
  ctx.server.disk(PATH, 'a\nb');
  await w.fake((f, tab) => f.emit('cssv-file-changed', tab), id);
  await until(async () => (await tab.textContent('#source-info')) === '2 lines');
});

test('a file too long to color shows as plain text', async () => {
  const { tab } = await open(cssv(`/* ${'x'.repeat(2_000_001)} */`, 'n', '1'));
  await tab.click('#source');
  assert.deepEqual(await tab.$eval('#source-code', (el) => [el.childNodes.length, el.firstChild.nodeType]), [1, 3]);
  assert.equal(await tab.textContent('#source-info'), '6 lines');
});

test('the divider resizes the source by dragging or with the arrow keys, within limits, and the width is remembered', async () => {
  const context = await ctx.context();
  const { tab } = await open(BUDGET, { context });
  await tab.click('#source');
  const page = tab.page();
  const grip = async () => {
    const box = await (await tab.$('#source-divider')).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const drag = async (to) => {
    const [x, y] = await grip();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(to, y, { steps: 3 });
    await page.mouse.up();
  };
  // A press and release without moving keeps the width as it was.
  const [x, y] = await grip();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  assert.equal(await tab.evaluate(() => localStorage.getItem('cssv-viewer:source-width')), 'null');
  await drag(x - 100);
  const dragged = await paneWidth(tab);
  assert.ok(Math.abs(dragged - (1100 - (x - 100))) < 30, String(dragged));
  // Never narrower than 240 pixels, nor leaving the table less than 240.
  await drag(1095);
  assert.equal(await paneWidth(tab), 240);
  await drag(2);
  const room = await tab.$eval('#source-pane', (el) => el.parentElement.getBoundingClientRect().width);
  assert.equal(await paneWidth(tab), room - 240);
  await tab.focus('#source-divider');
  const near = (a, b) => assert.ok(Math.abs(a - b) <= 2, `${a} vs ${b}`);
  await page.keyboard.press('ArrowRight');
  near(await paneWidth(tab), room - 240 - 24);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  near(await paneWidth(tab), room - 240 + 24);
  const kept = await paneWidth(tab);
  await page.keyboard.press('x');
  assert.equal(await paneWidth(tab), kept);
  assert.equal(Number(await tab.evaluate(() => localStorage.getItem('cssv-viewer:source-width'))), kept);
  // Narrowing stops at 240 too.
  await tab.evaluate(() => { document.getElementById('source-pane').style.width = '250px'; });
  await page.keyboard.press('ArrowRight');
  assert.equal(await paneWidth(tab), 240);
  // The next window starts with it.
  const next = await ctx.open({ context, opens: [PATH] });
  const again = await next.file();
  await again.click('#source');
  assert.equal(await paneWidth(again), 240);
});

test('the source colors a file\'s style block and data: fences, comments, rules, declarations, hooks and values', async () => {
  const w = await ctx.open();
  const tab = await w.tab();
  const colors = (text) => tab.evaluate(async (t) => {
    const { highlightCssv } = await import('/highlight.js');
    const out = document.createElement('div');
    out.append(highlightCssv(t));
    return [...out.childNodes].map((n) => (n.nodeType === 3 ? ['', n.data] : [n.className.replace('t-', ''), n.textContent]));
  }, text);
  const style = [
    '/* cssv:title A */',
    '@import "x.css" screen;',
    '@media (min-width: 1px) { .number, [data-col="a"] { color: red; } }',
    '@font-face { font-family: "F"; }',
    ':host { --cssv-key: Item; --gap: 2px; margin: \'a\'; }',
    '} /* stray brace */',
    'td::after { content: "open',
  ].join('\n');
  const out = await colors(`---\n${style}\n---\nItem;"A;B";n\n1;"say ""hi""" x;-2.5\r\n\nword;3;\n`);
  const kinds = (k) => out.filter(([c]) => c === k).map(([, t]) => t);
  assert.deepEqual(kinds('fence'), ['---\n', '---\n']);
  assert.deepEqual(kinds('comment'), ['/* cssv:title A */', '/* stray brace */']);
  assert.deepEqual(kinds('at'), ['@import', '@media', '@font-face']);
  assert.ok(kinds('atp').includes(' (min-width'));
  assert.deepEqual(kinds('str').slice(0, 3), ['"x.css"', '"a"', '"F"']);
  assert.deepEqual(kinds('hook'), ['.number', 'data-col']);
  assert.ok(kinds('sel').includes('host '));
  assert.deepEqual(kinds('cssv'), [' --cssv-key']);
  assert.deepEqual(kinds('var'), [' --gap']);
  assert.ok(kinds('prop').includes(' color') && kinds('prop').includes(' margin'));
  assert.ok(kinds('val').includes(' red'));
  assert.ok(kinds('str').includes('"open'));
  // The data, split by its own delimiter (;), the header first.
  assert.deepEqual(kinds('head'), ['Item', '"A;B"', 'n']);
  assert.deepEqual(kinds('quoted'), ['"say ""hi""" x']);
  assert.deepEqual(kinds('num'), ['1', '-2.5', '3']);
  assert.deepEqual(kinds('text'), ['word']);
  assert.equal(kinds('delim').length, 6);
  assert.deepEqual(out.filter(([c]) => c === '').map(([, t]) => t), ['\n', '\r\n', '\n', '\n']);

  // No style block: the data alone, commas winning a tie.
  const plain = await colors('a,b\n1,x\n');
  assert.deepEqual(plain.map(([c]) => c), ['head', 'delim', 'head', '', 'num', 'delim', 'text', '']);
  // A header with a quoted line break; a fence never closed colors the rest as CSS.
  const quoted = await colors('"a\nb",c;d\n');
  assert.equal(quoted[0][0], 'head');
  const open = await colors('﻿---\ntd { color: red; }\n');
  assert.equal(open[0][0], 'fence');
  assert.ok(!open.slice(1).some(([c]) => c === 'fence'));
  assert.deepEqual(await colors(''), []);
});
