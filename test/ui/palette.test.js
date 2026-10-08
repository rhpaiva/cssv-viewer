// The command palette (palette.js, opened by tabs.js): the recent files, the
// window's commands and the current tab's, filtered as the reader types.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, cssv, setup, until } from './harness.js';

const ctx = setup();

const A = '/home/ana/a.cssv';
const B = '/home/ana/b.cssv';
const BUDGET_PATH = '/home/ana/money/budget.cssv';

function files() {
  ctx.server.disk(A, cssv(null, 'x,y', '1,2'));
  ctx.server.disk(B, cssv(null, 'x,y', '3,4'));
  ctx.server.disk(BUDGET_PATH, BUDGET);
}

const names = async (w) => (await w.tabs()).map((t) => (t.selected ? `[${t.name}]` : t.name));
const isOpen = (w) => w.page.$eval('#palette', (el) => el.classList.contains('open'));

// The palette's rows: headings as "# title", items as their text with the
// marked letters in [brackets], the active one starred.
function rows(w) {
  return w.page.$$eval('#palette-list > *', (els) => els.map((el) => {
    if (el.classList.contains('palette-heading')) return `# ${el.textContent}`;
    if (el.classList.contains('palette-empty')) return el.textContent;
    const label = [...el.querySelector('.palette-label').childNodes]
      .map((n) => (n.nodeName === 'MARK' ? `[${n.textContent}]` : n.textContent)).join('');
    const group = el.querySelector('.palette-group')?.textContent;
    const detail = el.querySelector('.palette-detail')?.textContent;
    const kbd = el.querySelector('kbd')?.textContent;
    const mark = el.querySelector('.palette-mark');
    const icon = mark.querySelector('svg') ? '📄 ' : mark.textContent ? `${mark.textContent} ` : '';
    const active = el.getAttribute('aria-selected') === 'true' ? '*' : '';
    return `${active}${icon}${group ? `${group}: ` : ''}${label}${detail ? ` (${detail})` : ''}${kbd ? ` <${kbd}>` : ''}`;
  }));
}

async function openPalette(w) {
  await w.page.keyboard.press('Control+k');
  await until(() => isOpen(w));
}

async function run(w, query) {
  await openPalette(w);
  await w.page.fill('#palette-input', query);
  await w.page.keyboard.press('Enter');
  assert.equal(await isOpen(w), false);
}

test('Ctrl+K lists the recent files but the shown one, then the window\'s and the tab\'s commands with their shortcuts', async () => {
  files();
  const w = await ctx.open({ opens: [A, BUDGET_PATH], storage: { recent: [B, A] } });
  await w.file();
  await openPalette(w);
  assert.equal(await w.page.evaluate(() => document.activeElement.id), 'palette-input');
  const list = await rows(w);
  assert.deepEqual(list.slice(0, 5), [
    '# Recent files',
    '*📄 b.cssv (/home/ana)',
    '📄 a.cssv (/home/ana)',
    '# Commands',
    'Open a file… <Ctrl+O>',
  ]);
  for (const row of [
    'New tab <Ctrl+T>', 'Close tab <Ctrl+W>', 'Next tab <Ctrl+Tab>', 'Previous tab <Ctrl+Shift+Tab>',
    'Move tab left <Ctrl+Shift+PgUp>', 'Quit <Ctrl+Q>', 'Find in the values <Ctrl+F>', 'Show the source <Ctrl+U>',
    'Plain view: the data without its styles', 'Print or save as PDF… <Ctrl+P>', 'Copy the table for spreadsheets',
    'Reload the file <Ctrl+R>', 'Save as: Data as CSV…', '• Light or dark: Match the system',
    '• Numbers in: System language (en-GB) (-1,234,567.89)',
  ]) {
    assert.ok(list.some((r) => r.replace(/^\*/, '') === row), `${row} in ${list.join('\n')}`);
  }
  // The current tab is the last: it can't move right, and no tab was closed.
  assert.ok(!list.some((r) => /Move tab right|Reopen/.test(r)));
  // Disabled items aren't offered: nothing is selected to copy.
  assert.ok(!list.some((r) => /Copy selected cells/.test(r)));
});

test('typing keeps the items whose label has the letters in order, best first, with the letters marked', async () => {
  files();
  const w = await ctx.open({ opens: [A] });
  await w.file();
  await openPalette(w);
  await w.page.fill('#palette-input', 'ntb');
  const list = await rows(w);
  assert.equal(list[0], '# Commands');
  assert.equal(list[1], '*[N]ew [t]a[b] <Ctrl+T>');
  // A whole word typed scores above letters scattered.
  await w.page.fill('#palette-input', 'quit');
  assert.equal((await rows(w))[1], '*[Quit] <Ctrl+Q>');
  // Spaces don't count.
  await w.page.fill('#palette-input', 'q u');
  assert.equal((await rows(w))[1], '*[Qu]it <Ctrl+Q>');
  // Equal scores keep the menus' order.
  await w.page.fill('#palette-input', 'tab');
  assert.deepEqual((await rows(w)).slice(1, 3), ['*New [tab] <Ctrl+T>', 'Close [tab] <Ctrl+W>']);
});

test('words typed also find an item by its group and detail, below the label matches', async () => {
  files();
  const w = await ctx.open({ opens: [A], storage: { recent: ['/home/ana/money/budget.cssv'] } });
  await w.file();
  await openPalette(w);
  await w.page.fill('#palette-input', 'num ger');
  assert.deepEqual(await rows(w), ['# Commands', '*Numbers in: German (Germany) (-1.234.567,89)']);
  // A folder's name finds the files in it.
  await w.page.fill('#palette-input', 'money');
  assert.deepEqual(await rows(w), ['# Recent files', '*📄 budget.cssv (/home/ana/money)']);
  await w.page.fill('#palette-input', 'zzzz');
  assert.deepEqual(await rows(w), ['Nothing matches.']);
  assert.equal(await w.page.$eval('#palette-input', (el) => el.hasAttribute('aria-activedescendant')), false);
  // Enter with nothing listed does nothing.
  await w.page.keyboard.press('Enter');
  assert.equal(await isOpen(w), true);
});

test('the arrow keys, PgUp and PgDn choose an item, going round at the ends; the mouse chooses one by pointing', async () => {
  files();
  const w = await ctx.open({ opens: [A] });
  await w.file();
  await openPalette(w);
  const active = async () => (await rows(w)).find((r) => r.startsWith('*'));
  assert.equal(await active(), '*Open a file… <Ctrl+O>');
  await w.page.keyboard.press('ArrowUp');
  assert.match(await active(), /^\*Numbers in: /);
  await w.page.keyboard.press('ArrowDown');
  assert.equal(await active(), '*Open a file… <Ctrl+O>');
  await w.page.keyboard.press('PageDown');
  const eighth = await active();
  await w.page.keyboard.press('PageUp');
  assert.equal(await active(), '*Open a file… <Ctrl+O>');
  for (let i = 0; i < 20; i++) await w.page.keyboard.press('PageDown');
  assert.match(await active(), /^\*Numbers in: /); // stops at the last
  assert.notEqual(eighth, await active());
  await w.page.hover('#palette-item-2');
  assert.equal(await w.page.$eval('#palette-item-2', (el) => el.getAttribute('aria-selected')), 'true');
  // Tab stays in the box; other keys type.
  await w.page.keyboard.press('Tab');
  assert.equal(await w.page.evaluate(() => document.activeElement.id), 'palette-input');
});

test('Enter or a click runs the chosen item and closes the palette; Escape, Ctrl+K and a click outside close it', async () => {
  files();
  const w = await ctx.open({ opens: [A] });
  const tab = await w.file();
  await run(w, 'find in');
  await until(() => tab.$eval('#find', (el) => !el.hidden));
  await openPalette(w);
  await w.page.fill('#palette-input', 'show the source');
  await w.page.click('#palette-item-0');
  assert.equal(await isOpen(w), false);
  await until(() => tab.$eval('#source-pane', (el) => !el.hidden));
  // The palette closes back to the tab's page.
  await openPalette(w);
  await w.page.keyboard.press('Escape');
  assert.equal(await isOpen(w), false);
  assert.equal(await w.page.evaluate(() => document.activeElement.tagName), 'IFRAME');
  await openPalette(w);
  await w.page.keyboard.press('Control+k');
  assert.equal(await isOpen(w), false);
  await openPalette(w);
  await w.page.click('.palette-box .palette-foot');
  assert.equal(await isOpen(w), true);
  await w.page.mouse.click(5, 700);
  assert.equal(await isOpen(w), false);
});

test('while the palette is open, the window\'s other keys wait', async () => {
  files();
  const w = await ctx.open({ opens: [A] });
  await w.file();
  await openPalette(w);
  await w.page.keyboard.press('Control+t');
  await w.page.keyboard.press('Control+Alt+k');
  await w.page.keyboard.type('qu');
  assert.equal(await isOpen(w), true);
  assert.equal((await w.tabs()).length, 1);
  assert.equal(await w.page.$eval('#palette-input', (el) => el.value), 'qu');
});

test('the window\'s commands run from the palette', async () => {
  files();
  const w = await ctx.open({ opens: [A, B], storage: { recent: [BUDGET_PATH] } });
  await w.file();
  await run(w, 'previous tab');
  await w.tab();
  assert.deepEqual(await names(w), ['[a.cssv]', 'b.cssv']);
  await run(w, 'next tab');
  await w.tab();
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]']);
  await run(w, 'move tab left');
  assert.deepEqual(await names(w), ['[b.cssv]', 'a.cssv']);
  await run(w, 'move tab right');
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]']);
  await run(w, 'close tab');
  await w.tab();
  assert.deepEqual(await names(w), ['[a.cssv]']);
  await run(w, 'reopen b');
  await w.tab();
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]']);
  await run(w, 'new tab');
  await w.tab();
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[Home]']);
  await run(w, 'budget');
  await w.file();
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[Household budget]']);
  await w.fake((f) => { f.dialog = null; });
  await run(w, 'open a file');
  await until(async () => (await w.calls('dialog.open')).length === 1);
  await run(w, 'quit');
  await until(async () => (await w.calls('quit')).length === 1);
});

test('before the window has a tab, the palette offers the window\'s commands alone', async () => {
  const w = await ctx.open({ holdTake: true, storage: { recent: ['/home/ana/a.cssv'] } });
  await w.page.waitForFunction(() => window.shell);
  await openPalette(w);
  const list = await rows(w);
  assert.deepEqual(list.slice(0, 2), ['# Recent files', '*📄 a.cssv (/home/ana)']);
  assert.ok(list.includes('Quit <Ctrl+Q>'));
  assert.ok(!list.some((r) => /Next tab|Find/.test(r)));
  await w.page.keyboard.press('Escape');
  assert.equal(await isOpen(w), false);
  assert.deepEqual(w.page.errors, []);
});

test('a tab whose page hasn\'t loaded yet adds no commands', async () => {
  files();
  ctx.server.disk('/home/ana/slow.cssv', cssv(null, 'x', '1'));
  const w = await ctx.open({ opens: [A] });
  await w.file();
  // The new tab's page never comes, so it has no commands.
  await w.page.route('**/viewer.html', () => {});
  await w.page.click('#new-tab');
  await w.page.evaluate(() => document.activeElement.blur());
  await openPalette(w);
  const list = await rows(w);
  assert.ok(list.includes('Quit <Ctrl+Q>'));
  assert.ok(!list.some((r) => /Light or dark/.test(r)));
});

test('on a Mac the shortcuts name Command and Shift', async () => {
  files();
  const w = await ctx.open({ opens: [A, B], platform: 'MacIntel' });
  await w.file();
  await w.page.keyboard.press('Meta+w');
  await w.tab();
  await w.page.keyboard.press('Meta+k');
  await until(() => isOpen(w));
  const list = await rows(w);
  assert.ok(list.includes('Open a file… <⌘O>'), list.join('\n'));
  assert.ok(list.includes('Reopen b.cssv <⇧⌘T>'));
  assert.ok(list.some((r) => /Find in the values <⌘F>/.test(r)));
  // Command+K closes it again; Ctrl+K is the page's on a Mac.
  await w.page.keyboard.press('Control+k');
  assert.equal(await isOpen(w), true);
  await w.page.keyboard.press('Meta+k');
  assert.equal(await isOpen(w), false);
});

// The palette on its own page: its parts that the window doesn't reach.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/viewer.css"><link rel="stylesheet" href="/tabs.css"></head>
<body><div class="palette" id="palette"><div class="palette-box"><input class="palette-input" id="palette-input"><div class="palette-list" id="palette-list"></div></div></div>
<script type="module">window.palette = await import('/palette.js');</script></body></html>`;

test('fuzzy() scores the query as one piece highest, at a word\'s start more, and letters at word starts over letters inside words', async () => {
  ctx.server.file('/__test/palette.html', PAGE, { type: 'text/html' });
  const w = await ctx.open({ page: '/__test/palette.html' });
  await w.page.waitForFunction(() => window.palette);
  const fuzzy = (q, t) => w.page.evaluate(([q, t]) => palette.fuzzy(q, t), [q, t]);
  assert.deepEqual(await fuzzy('', 'Anything'), { score: 0, at: [] });
  assert.deepEqual(await fuzzy('tab', 'New tab'), { score: 1496, at: [4, 5, 6] });
  assert.deepEqual(await fuzzy('ab', 'New tab'), { score: 995, at: [5, 6] });
  assert.deepEqual(await fuzzy('nt', 'New tab'), { score: 20, at: [0, 4] });
  // Letters inside words, one after another.
  assert.deepEqual(await fuzzy('ewa', 'New tab'), { score: 3, at: [1, 2, 5] });
  // Taking the next word's start for "a" would leave "b" without a place,
  // so the letters go plainly in order.
  assert.deepEqual(await fuzzy('ab', 'za xb a'), { score: -2, at: [1, 4] });
  assert.deepEqual(await fuzzy('ax', 'zab a x'), { score: 20, at: [4, 6] });
  assert.deepEqual(await fuzzy('ba', 'zab'), null);
  assert.deepEqual(await fuzzy('ay', 'zab a x'), null);
  assert.deepEqual(await fuzzy('bx', 'zab ax'), { score: -2, at: [2, 5] });
});

test('a palette made on its own opens once, closes once, toggles, and runs an item with Enter', async () => {
  ctx.server.file('/__test/palette.html', PAGE, { type: 'text/html' });
  const w = await ctx.open({ page: '/__test/palette.html' });
  await w.page.waitForFunction(() => window.palette);
  await w.page.evaluate(() => {
    window.ran = [];
    window.p = palette.createPalette({
      sections: () => [
        { title: 'Things', items: [{ label: 'Bold', checked: true, run: () => ran.push('bold') }, { label: 'Plain', checked: false, detail: 'no marks', run: () => ran.push('plain') }] },
        { title: 'Empty', items: [] },
      ],
    });
  });
  const open = () => w.page.evaluate(() => p.isOpen());
  await w.page.evaluate(() => p.close()); // not open: nothing to do
  assert.equal(await open(), false);
  await w.page.evaluate(() => p.toggle());
  assert.equal(await open(), true);
  await w.page.fill('#palette-input', 'pl');
  await w.page.evaluate(() => p.open()); // already open: keeps the query
  assert.equal(await w.page.$eval('#palette-input', (el) => el.value), 'pl');
  await w.page.fill('#palette-input', '');
  assert.deepEqual(await w.page.$$eval('#palette-list > *', (els) => els.map((el) => el.textContent)), ['Things', '•Bold', 'Plainno marks']);
  await w.page.evaluate(() => p.toggle());
  assert.equal(await open(), false);
  await w.page.evaluate(() => p.open());
  await w.page.keyboard.press('ArrowDown');
  await w.page.keyboard.press('Enter');
  assert.deepEqual(await w.page.evaluate(() => ran), ['plain']);
  assert.equal(await open(), false);
});
