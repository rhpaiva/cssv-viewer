// The toolbar's pop-up menus (menu.js): opening and closing, the keys, the
// mouse, and where a menu goes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, setup, until } from './harness.js';

const ctx = setup();
const PATH = '/home/ana/budget.cssv';

async function open(options = {}) {
  ctx.server.disk(PATH, BUDGET);
  const w = await ctx.open({ opens: [PATH], ...options });
  const tab = await w.file();
  return { w, tab };
}

// The open menu's items: "label [role, state]" for buttons, "---" for
// separators and "# heading" for headings.
const items = (tab) => tab.$$eval('.menu.open > *', (els) => els.map((el) => {
  if (el.classList.contains('menu-sep')) return '---';
  if (el.classList.contains('menu-heading')) return `# ${el.textContent}`;
  const flags = [el.getAttribute('role'), el.getAttribute('aria-checked') === 'true' && 'checked', el.getAttribute('aria-disabled') && 'disabled'].filter(Boolean);
  return `${el.querySelector('.menu-mark').textContent}${el.querySelector('.menu-label').firstChild.textContent} [${flags.join(', ')}]${el.querySelector('kbd') ? ` ${el.querySelector('kbd').textContent}` : ''}`;
}));
const focused = (tab) => tab.evaluate(() => document.activeElement.querySelector('.menu-label')?.firstChild.textContent ?? document.activeElement.id);
const menus = (tab) => tab.$$eval('.menu', (els) => els.map((el) => el.classList.contains('open')));

test('a toolbar button opens its menu under it, and a second click closes it', async () => {
  const { tab } = await open();
  await tab.click('#theme');
  assert.equal(await tab.$eval('#theme', (b) => b.getAttribute('aria-expanded')), 'true');
  assert.equal(await tab.$eval('.menu.open', (m) => m.getAttribute('aria-label')), 'Light or dark');
  assert.deepEqual(await items(tab), ['•Match the system [menuitemradio, checked]', 'Light [menuitemradio]', 'Dark [menuitemradio]']);
  const button = await tab.$eval('#theme', (b) => b.getBoundingClientRect().toJSON());
  const menu = await tab.$eval('.menu.open', (m) => m.getBoundingClientRect().toJSON());
  assert.equal(menu.top, button.bottom + 4);
  assert.equal(await tab.$eval('.menu.open', (m) => m.classList.contains('above')), false);
  // The menu itself has the focus, not an item.
  assert.equal(await tab.evaluate(() => document.activeElement.getAttribute('role')), 'menu');
  await tab.click('#theme');
  assert.equal(await tab.$eval('#theme', (b) => b.getAttribute('aria-expanded')), 'false');
  assert.deepEqual(await menus(tab), [false]);
  // A menu closed before goes when another opens.
  await tab.click('#export');
  await tab.click('#copy');
  assert.deepEqual(await menus(tab), [true]);
});

test('a menu\'s items say what they are: shortcuts, details, disabled items, separators and headings', async () => {
  const { tab } = await open({ storage: { recent: ['/home/ana/other.cssv'] } });
  await tab.click('#copy');
  assert.deepEqual(await items(tab), [
    'Copy selected cells [menuitem, disabled] Ctrl+C',
    '---',
    'Copy the table for spreadsheets [menuitem]',
    'Copy the table as Markdown [menuitem]',
    'Copy the data as CSV [menuitem]',
  ]);
  await tab.click('#open-more');
  assert.deepEqual(await items(tab), ['# Recent files', 'other.cssv [menuitem]', '---', 'Clear recent files [menuitem]']);
  assert.equal(await tab.$eval('.menu.open .menu-item', (b) => b.title), '/home/ana');
  assert.equal(await tab.$eval('.menu.open .menu-detail', (d) => d.textContent), '/home/ana');
});

test('Down, Enter or Space on a button opens its menu with the first item focused; other keys don\'t', async () => {
  const { tab } = await open();
  for (const key of ['ArrowDown', 'Enter', ' ']) {
    await tab.focus('#theme');
    await tab.page().keyboard.press(key);
    assert.equal(await focused(tab), 'Match the system', key);
    await tab.page().keyboard.press('Escape');
  }
  await tab.focus('#theme');
  await tab.page().keyboard.press('ArrowUp');
  assert.deepEqual(await menus(tab), [false]);
});

test('in a menu, Up and Down move between the enabled items, going round, and Home and End jump', async () => {
  const { tab } = await open();
  const keys = tab.page().keyboard;
  await tab.click('#copy');
  // From the menu itself, Up goes to the last item.
  await keys.press('ArrowUp');
  assert.equal(await focused(tab), 'Copy the data as CSV');
  await keys.press('ArrowDown');
  assert.equal(await focused(tab), 'Copy the table for spreadsheets'); // the disabled first item is skipped
  await keys.press('ArrowUp');
  assert.equal(await focused(tab), 'Copy the data as CSV');
  await keys.press('Home');
  assert.equal(await focused(tab), 'Copy the table for spreadsheets');
  await keys.press('End');
  assert.equal(await focused(tab), 'Copy the data as CSV');
  await keys.press('x'); // not a menu key
  assert.equal(await focused(tab), 'Copy the data as CSV');
  // Escape closes it back to its button; Tab just closes it.
  await keys.press('Escape');
  assert.equal(await focused(tab), 'copy');
  assert.deepEqual(await menus(tab), [false]);
  await tab.click('#copy');
  await keys.press('ArrowDown');
  await keys.press('Tab');
  assert.deepEqual(await menus(tab), [false]);
});

test('Enter or a click runs an item, closes the menu and gives the focus back to its button; a disabled item does nothing', async () => {
  const { tab } = await open();
  await tab.click('#theme');
  await tab.click('.menu-item:has-text("Dark")');
  assert.deepEqual(await menus(tab), [false]);
  assert.equal(await focused(tab), 'theme');
  assert.equal(await tab.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await tab.focus('#theme');
  await tab.page().keyboard.press('Enter');
  await tab.page().keyboard.press('Enter');
  assert.equal(await tab.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  await tab.click('#copy');
  await tab.click('.menu-item[aria-disabled="true"]', { force: true });
  assert.deepEqual(await menus(tab), [true]);
});

test('pointing at an enabled item focuses it; separators, headings and disabled items take nothing', async () => {
  const { tab } = await open();
  await tab.click('#copy');
  await tab.hover('.menu-item:has-text("Markdown")');
  assert.equal(await focused(tab), 'Copy the table as Markdown');
  await tab.page().mouse.move(...(await center(tab, '.menu-item:has-text("Markdown")')).map((v) => v + 1));
  assert.equal(await focused(tab), 'Copy the table as Markdown');
  await tab.hover('.menu-sep');
  await tab.hover('.menu-item[aria-disabled="true"]');
  assert.equal(await focused(tab), 'Copy the table as Markdown');
});

async function center(tab, selector) {
  const box = await (await tab.$(selector)).boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
}

test('a press outside the menu and its button closes it, as do resizing and leaving the page', async () => {
  const { w, tab } = await open();
  await tab.click('#numbers');
  await tab.click('.menu-sep', { force: true }); // inside: stays
  assert.deepEqual(await menus(tab), [true]);
  await tab.click('#file-name');
  assert.deepEqual(await menus(tab), [false]);
  await tab.click('#numbers');
  await w.page.setViewportSize({ width: 1000, height: 700 });
  await until(async () => (await menus(tab)).every((m) => !m));
  await tab.click('#numbers');
  await w.page.focus('#new-tab'); // the window's page takes the focus
  await until(async () => (await menus(tab)).every((m) => !m));
});

test('a menu with no room below its button opens above it, inside the window; under a right-to-left button it lines up with its right edge', async () => {
  const { w, tab } = await open();
  await w.page.setViewportSize({ width: 1000, height: 260 });
  await tab.click('#numbers');
  const menu = await tab.$eval('.menu.open', (m) => ({ top: m.getBoundingClientRect().top, above: m.classList.contains('above') }));
  assert.deepEqual(menu, { top: 8, above: true });
  await tab.page().keyboard.press('Escape');
  await w.page.setViewportSize({ width: 1000, height: 700 });
  await tab.$eval('#theme', (b) => { b.style.direction = 'rtl'; });
  await tab.click('#theme');
  const right = await tab.evaluate(() => [document.querySelector('.menu.open').getBoundingClientRect().right, document.getElementById('theme').getBoundingClientRect().right]);
  assert.ok(Math.abs(right[0] - right[1]) < 1, String(right));
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/viewer.css"></head>
<body><button id="anchor">Menu</button>
<script type="module">window.menu = await import('/menu.js');</script></body></html>`;

test('openMenu() shows check boxes, items without an action, and a menu whose anchor went away', async () => {
  ctx.server.file('/__test/menu.html', PAGE, { type: 'text/html' });
  const w = await ctx.open({ page: '/__test/menu.html' });
  await w.page.waitForFunction(() => window.menu);
  await w.page.evaluate(() => menu.closeMenu()); // nothing open
  await w.page.evaluate(() => {
    window.ran = [];
    menu.openMenu(document.getElementById('anchor'), [
      { label: 'Wrap', checked: true, run: () => ran.push('wrap') },
      { label: 'Bold', checked: false },
      { label: 'Nothing' },
    ]);
  });
  const roles = await w.page.$$eval('.menu.open .menu-item', (els) => els.map((el) => [el.getAttribute('role'), el.getAttribute('aria-checked'), el.querySelector('.menu-mark').textContent]));
  assert.deepEqual(roles, [['menuitemcheckbox', 'true', '✓'], ['menuitemcheckbox', 'false', ''], ['menuitem', null, '']]);
  await w.page.click('.menu-item:has-text("Nothing")');
  assert.deepEqual(await w.page.$$eval('.menu', (els) => els.map((el) => el.classList.contains('open'))), [false]);
  // An anchor removed while its menu is open doesn't take the focus back.
  await w.page.evaluate(() => {
    window.gone = document.createElement('button');
    document.body.append(gone);
    menu.openMenu(gone, [{ label: 'Wrap', checked: true, run: () => ran.push('wrap') }]);
    gone.remove();
  });
  await w.page.click('.menu.open .menu-item');
  // The item ran; the focus is wherever the page puts it, not on the anchor.
  assert.deepEqual(await w.page.evaluate(() => [ran, document.activeElement !== gone, gone.getAttribute('aria-expanded')]), [['wrap'], true, 'false']);
  // A menu of disabled items has nothing to focus first.
  await w.page.evaluate(() => menu.openMenu(document.getElementById('anchor'), [{ label: 'Off', disabled: true }], { focusFirst: true }));
  assert.equal(await w.page.evaluate(() => document.activeElement.closest('.menu.open')), null);
  assert.equal(await w.page.$eval('#anchor', (a) => a.getAttribute('aria-expanded')), 'true');
});
