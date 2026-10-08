// The window (tabs.js): where files open, the tab strip and its keys,
// dragging, dropped files, the Open dialog, and the window's title and theme.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, cssv, setup, until } from './harness.js';

const ctx = setup();

const A = '/home/ana/a.cssv';
const B = '/home/ana/b.cssv';
const C = '/home/ana/c.cssv';
const D = '/home/ana/d.cssv';

function files() {
  for (const path of [A, B, C, D]) ctx.server.disk(path, cssv(null, 'x,y', '1,2'));
  ctx.server.disk('/home/ana/budget.cssv', BUDGET);
}

const names = async (w) => (await w.tabs()).map((t) => (t.selected ? `[${t.name}]` : t.name));

// A key, then the shown tab's page once it has loaded (a tab's page loads
// when the tab is first shown, and takes keys only then).
async function press(w, key) {
  await w.page.keyboard.press(key);
  if ((await w.tabs()).length) await w.tab();
}

async function click(w, selector, options) {
  await w.page.click(selector, options);
  if ((await w.tabs()).length) await w.tab();
}

// Keys go to the window's page itself when nothing in a tab has the focus.
async function blur(w) {
  await w.page.evaluate(() => document.activeElement?.blur());
}

test('a window started without files shows the home, titled after the viewer', async () => {
  const w = await ctx.open();
  await w.tab();
  assert.deepEqual(await w.tabs(), [{ name: 'Home', path: 'Home', selected: true }]);
  assert.equal(await w.page.title(), 'CSSV Viewer');
  assert.deepEqual(await w.fake((f) => f.windowCalls.filter(([c]) => c === 'setTitle').at(-1)), ['setTitle', 'CSSV Viewer']);
});

test('a home asked for (None on the Rust side) opens as a tab', async () => {
  const w = await ctx.open({ opens: [null] });
  await w.tab();
  assert.deepEqual(await names(w), ['[Home]']);
});

test('the files the window is asked to open open in tabs, showing the last, named after their titles', async () => {
  files();
  const w = await ctx.open({ opens: [A, '/home/ana/budget.cssv'] });
  await w.file();
  assert.deepEqual(await names(w), ['a.cssv', '[Household budget]']);
  assert.equal(await w.page.title(), 'Household budget — CSSV Viewer');
  assert.deepEqual(await w.fake((f) => f.windowCalls.filter(([c]) => c === 'setTitle').at(-1)), ['setTitle', 'Household budget — CSSV Viewer']);
  // A tab's page loads when the tab is first shown.
  assert.equal(await w.page.$eval('#frames iframe', (f) => f.getAttribute('src')), null);
});

test('a file asked for again shows its tab; a new file opens after the current tab, or in it when it shows the home', async () => {
  files();
  const w = await ctx.open();
  await w.tab();
  await w.fake((f) => { f.opens.push('/home/ana/a.cssv'); f.emit('cssv-open'); });
  await until(async () => (await names(w)).join() === '[a.cssv]'); // the home became a.cssv
  await w.fake((f) => { f.opens.push('/home/ana/b.cssv', '/home/ana/c.cssv'); f.emit('cssv-open'); });
  await until(async () => (await names(w)).join() === 'a.cssv,b.cssv,[c.cssv]');
  await click(w, '#tabs .tab:nth-child(1)');
  await w.fake((f) => { f.opens.push('/home/ana/d.cssv'); f.emit('cssv-open'); });
  await until(async () => (await names(w)).join() === 'a.cssv,[d.cssv],b.cssv,c.cssv');
  await w.fake((f) => { f.opens.push('/home/ana/b.cssv'); f.emit('cssv-open'); });
  await until(async () => (await names(w)).join() === 'a.cssv,d.cssv,[b.cssv],c.cssv');
  // Told of more files when there are none (another window took them): nothing changes.
  await w.fake((f) => f.emit('cssv-open'));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await names(w), ['a.cssv', 'd.cssv', '[b.cssv]', 'c.cssv']);
});

test('Ctrl+T and the + button open a new home tab at the end', async () => {
  files();
  const w = await ctx.open({ opens: [A, B] });
  await w.file();
  await click(w, '#tabs .tab:nth-child(1)');
  await press(w, 'Control+t');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[Home]']);
  await click(w, '#new-tab');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', 'Home', '[Home]']);
  assert.equal(await w.page.title(), 'CSSV Viewer');
  // Alt with the keys leaves them to the page.
  await press(w, 'Control+Alt+t');
  assert.equal((await w.tabs()).length, 4);
});

test('Ctrl+W, the close button and the middle button close a tab, then the next one shows', async () => {
  files();
  const w = await ctx.open({ opens: [A, B, C, D] });
  await w.file();
  await click(w, '#tabs .tab:nth-child(2)');
  await press(w, 'Control+w');
  assert.deepEqual(await names(w), ['a.cssv', '[c.cssv]', 'd.cssv']);
  // Closing another tab leaves the current one shown.
  await click(w, '#tabs .tab:nth-child(3) .tab-close');
  assert.deepEqual(await names(w), ['a.cssv', '[c.cssv]']);
  await click(w, '#tabs .tab:nth-child(1)', { button: 'middle' });
  assert.deepEqual(await names(w), ['[c.cssv]']);
  // The other buttons don't close it.
  await click(w, '#tabs .tab:nth-child(1)', { button: 'right' });
  assert.deepEqual(await names(w), ['[c.cssv]']);
  const closed = (await w.calls('close_tab')).length;
  assert.equal(closed, 3);
  // The last tab closes the window.
  await press(w, 'Control+w');
  assert.deepEqual(await names(w), []);
  assert.deepEqual(await w.fake((f) => f.windowCalls.filter(([c]) => c === 'close')), [['close']]);
});

test('a tab closed twice (its button pressed as it goes) is closed once, and a failed close_tab is ignored', async () => {
  files();
  const w = await ctx.open({ opens: [A, B] });
  await w.file();
  await w.fake((f) => { f.handlers.close_tab = () => Promise.reject(new Error('gone')); });
  await w.page.evaluate(() => {
    const button = document.querySelector('#tabs .tab:nth-child(1) .tab-close');
    button.click();
    button.click();
  });
  assert.deepEqual(await names(w), ['[b.cssv]']);
  assert.equal((await w.calls('close_tab')).length, 1);
  assert.deepEqual(w.page.errors, []);
});

test('Ctrl+Shift+T reopens the last closed file in its place, or shows it where it is open again', async () => {
  files();
  const w = await ctx.open({ opens: [A, B, C] });
  await w.file();
  // Nothing closed yet: nothing to reopen.
  await press(w, 'Control+Shift+t');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[c.cssv]']);
  await click(w, '#tabs .tab:nth-child(2)');
  await press(w, 'Control+w');
  await press(w, 'Control+Shift+t');
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]', 'c.cssv']);
  // A closed home isn't remembered.
  await press(w, 'Control+t');
  await press(w, 'Control+w');
  await click(w, '#tabs .tab:nth-child(1)');
  await press(w, 'Control+w');
  await w.fake((f) => { f.opens.push('/home/ana/a.cssv'); f.emit('cssv-open'); });
  await until(async () => (await names(w)).join() === 'b.cssv,[a.cssv],c.cssv');
  await click(w, '#tabs .tab:nth-child(1)');
  await press(w, 'Control+Shift+t');
  assert.deepEqual(await names(w), ['b.cssv', '[a.cssv]', 'c.cssv']);
});

test('Ctrl+Tab and Ctrl+PgDn show the next tab, Ctrl+Shift+Tab and Ctrl+PgUp the previous, around the ends', async () => {
  files();
  const w = await ctx.open({ opens: [A, B, C] });
  await w.file();
  await press(w, 'Control+Tab');
  assert.deepEqual(await names(w), ['[a.cssv]', 'b.cssv', 'c.cssv']);
  await press(w, 'Control+PageDown');
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]', 'c.cssv']);
  await press(w, 'Control+Shift+Tab');
  assert.deepEqual(await names(w), ['[a.cssv]', 'b.cssv', 'c.cssv']);
  await press(w, 'Control+PageUp');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[c.cssv]']);
  // WebKitGTK names Shift+Tab "Unidentified"; its code is still Tab.
  await blur(w);
  await w.page.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', code: 'Tab', ctrlKey: true, shiftKey: true, bubbles: true })));
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]', 'c.cssv']);
});

test('Ctrl+Shift+PgUp and PgDn move the tab along the strip, stopping at the ends', async () => {
  files();
  const w = await ctx.open({ opens: [A, B, C] });
  await w.file();
  await press(w, 'Control+Shift+PageUp');
  assert.deepEqual(await names(w), ['a.cssv', '[c.cssv]', 'b.cssv']);
  await press(w, 'Control+Shift+PageUp');
  await press(w, 'Control+Shift+PageUp');
  assert.deepEqual(await names(w), ['[c.cssv]', 'a.cssv', 'b.cssv']);
  await press(w, 'Control+Shift+PageDown');
  assert.deepEqual(await names(w), ['a.cssv', '[c.cssv]', 'b.cssv']);
  // The frames stay where they are: a moved frame would reload.
  const order = await w.page.$$eval('#frames iframe', (fs) => fs.map((f) => f.title));
  assert.deepEqual(order, ['a.cssv', 'b.cssv', 'c.cssv']);
});

test('Ctrl+1 to Ctrl+8 show that tab and Ctrl+9 the last; a number past the tabs does nothing', async () => {
  files();
  const w = await ctx.open({ opens: [A, B, C] });
  await w.file();
  await press(w, 'Control+1');
  assert.deepEqual(await names(w), ['[a.cssv]', 'b.cssv', 'c.cssv']);
  await press(w, 'Control+2');
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]', 'c.cssv']);
  await press(w, 'Control+9');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[c.cssv]']);
  await press(w, 'Control+5');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[c.cssv]']);
  // Other keys with Ctrl are the page's.
  await blur(w);
  await press(w, 'Control+j');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[c.cssv]']);
});

test('in the strip, the arrow keys, Home and End move between tabs and keep the focus on them', async () => {
  files();
  const w = await ctx.open({ opens: [A, B, C] });
  await w.file();
  await w.page.focus('#tabs .tab[aria-selected="true"]');
  await press(w, 'ArrowLeft');
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]', 'c.cssv']);
  assert.equal(await w.page.evaluate(() => document.activeElement.querySelector('.tab-name').textContent), 'b.cssv');
  await press(w, 'Home');
  await press(w, 'ArrowLeft'); // no tab before the first
  assert.deepEqual(await names(w), ['[a.cssv]', 'b.cssv', 'c.cssv']);
  await press(w, 'End');
  await press(w, 'ArrowRight');
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[c.cssv]']);
  await press(w, 'ArrowLeft');
  await press(w, 'ArrowRight');
  await press(w, 'x'); // not the strip's
  assert.deepEqual(await names(w), ['a.cssv', 'b.cssv', '[c.cssv]']);
});

test('a mouse wheel scrolls a full strip sideways', async () => {
  const w = await ctx.open();
  await w.tab();
  for (let i = 0; i < 30; i++) await click(w, '#new-tab');
  await w.page.evaluate(() => { document.getElementById('tabs').scrollLeft = 0; });
  await w.page.hover('#tabs .tab:nth-child(2)');
  await w.page.mouse.wheel(0, 200);
  const down = await w.page.$eval('#tabs', (el) => el.scrollLeft);
  assert.ok(down > 0, `scrolled to ${down}`);
  // A sideways wheel scrolls as it does anyway.
  const before = await w.page.$eval('#tabs', (el) => el.scrollLeft);
  await w.page.evaluate(() => {
    const event = new WheelEvent('wheel', { deltaX: 100, deltaY: 10, bubbles: true, cancelable: true });
    document.getElementById('tabs').dispatchEvent(event);
    window.__wheelPrevented = event.defaultPrevented;
  });
  assert.equal(await w.page.evaluate(() => window.__wheelPrevented), false);
  assert.equal(await w.page.$eval('#tabs', (el) => el.scrollLeft), before);
});

test('dragging a tab moves it past each tab whose middle the pointer crosses', async () => {
  files();
  const w = await ctx.open({ opens: [A, B, C, D] });
  await w.file();
  const box = async (n) => (await w.page.$(`#tabs .tab:nth-child(${n})`)).boundingBox();
  const a = await box(1);
  const c = await box(3);
  await w.page.mouse.move(a.x + 10, a.y + a.height / 2);
  await w.page.mouse.down();
  assert.deepEqual(await names(w), ['[a.cssv]', 'b.cssv', 'c.cssv', 'd.cssv']); // pressing shows it
  await w.page.mouse.move(c.x + c.width / 2 + 5, a.y + a.height / 2, { steps: 4 });
  await w.page.mouse.up();
  assert.deepEqual(await names(w), ['b.cssv', 'c.cssv', '[a.cssv]', 'd.cssv']);
  // Moving after the button is up moves nothing.
  await w.page.mouse.move(a.x + 2, a.y + a.height / 2, { steps: 3 });
  assert.deepEqual(await names(w), ['b.cssv', 'c.cssv', '[a.cssv]', 'd.cssv']);
  // And back, all the way to the start.
  const now = await box(3);
  await w.page.mouse.move(now.x + 10, now.y + now.height / 2);
  await w.page.mouse.down();
  await w.page.mouse.move(1, now.y + now.height / 2, { steps: 3 });
  await w.page.mouse.up();
  assert.deepEqual(await names(w), ['[a.cssv]', 'b.cssv', 'c.cssv', 'd.cssv']);
  // A cancelled drag (the system took the pointer) ends it too.
  const b = await box(2);
  await w.page.mouse.move(b.x + 10, b.y + b.height / 2);
  await w.page.mouse.down();
  await w.page.$eval('#tabs .tab:nth-child(2)', (el) => el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
  await w.page.mouse.move((await box(4)).x + 50, b.y + b.height / 2, { steps: 3 });
  await w.page.mouse.up();
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]', 'c.cssv', 'd.cssv']);
});

test('files dropped on the window open in tabs, with a hint while they are over it', async () => {
  files();
  const w = await ctx.open();
  await w.tab();
  const hidden = () => w.page.$eval('#drop', (el) => el.hidden);
  await w.fake((f) => f.drop({ type: 'enter', paths: ['/home/ana/a.cssv'] }));
  assert.equal(await hidden(), false);
  await w.fake((f) => f.drop({ type: 'over', position: { x: 1, y: 1 } }));
  assert.equal(await hidden(), false);
  await w.fake((f) => f.drop({ type: 'leave' }));
  assert.equal(await hidden(), true);
  await w.fake((f) => f.drop({ type: 'drop', paths: [] }));
  assert.deepEqual(await names(w), ['[Home]']);
  await w.fake((f) => f.drop({ type: 'drop', paths: ['/home/ana/a.cssv', '/home/ana/b.cssv'] }));
  assert.equal(await hidden(), true);
  assert.deepEqual(await names(w), ['a.cssv', '[b.cssv]']);
});

test('Ctrl+O asks for files and opens those chosen; cancelling opens nothing', async () => {
  files();
  const w = await ctx.open();
  await w.tab();
  await press(w, 'Control+o');
  await until(async () => (await w.calls('dialog.open')).length === 1);
  const [{ args }] = await w.calls('dialog.open');
  assert.equal(args.multiple, true);
  assert.deepEqual(args.filters.map((f) => f.extensions), [['cssv'], ['csv'], ['*']]);
  assert.deepEqual(await names(w), ['[Home]']);
  await w.fake((f) => { f.dialog = '/home/ana/a.cssv'; });
  await press(w, 'Control+o');
  await until(async () => (await names(w)).join() === '[a.cssv]');
  await w.fake((f) => { f.dialog = ['/home/ana/b.cssv', '/home/ana/c.cssv']; });
  await press(w, 'Control+o');
  await until(async () => (await names(w)).join() === 'a.cssv,b.cssv,[c.cssv]');
});

test('Ctrl+Q quits', async () => {
  const w = await ctx.open();
  await w.tab();
  await press(w, 'Control+q');
  await until(async () => (await w.calls('quit')).length === 1);
});

test('a tab takes its file\'s title when its page reads one, and its file name without', async () => {
  files();
  const w = await ctx.open({ opens: [A] });
  await w.file();
  const id = await w.page.$eval('#frames iframe', (f) => f.dataset.tab);
  await w.page.evaluate((tab) => shell.titled(tab, 'Ana\'s numbers'), id);
  assert.deepEqual(await names(w), ['[Ana\'s numbers]']);
  assert.equal(await w.page.$eval('#tabs .tab .tab-close', (b) => b.getAttribute('aria-label')), 'Close Ana\'s numbers');
  await w.page.evaluate((tab) => shell.titled(tab, 'Ana\'s numbers'), id); // the same: nothing to do
  await w.page.evaluate(() => shell.titled('no-such-tab', 'X'));
  await w.page.evaluate((tab) => shell.titled(tab, null), id);
  assert.deepEqual(await names(w), ['[a.cssv]']);
});

test('a tab whose page goes to another file takes that file\'s name', async () => {
  files();
  ctx.server.disk('/home/ana/rec.cssv', cssv(null, 'r', '1'));
  const w = await ctx.open({ storage: { recent: ['/home/ana/rec.cssv'] } });
  const home = await w.home();
  // The page navigates by itself, as a reload or allowing remote content does.
  await home.evaluate(() => { location.search = '?file=%2Fhome%2Fana%2Frec.cssv'; });
  await until(async () => (await names(w)).join() === '[rec.cssv]');
});

test('the window\'s colors follow the theme a tab chooses', async () => {
  const w = await ctx.open();
  const tab = await w.tab();
  const theme = () => w.page.evaluate(() => document.documentElement.dataset.theme ?? null);
  await tab.click('#theme');
  await tab.click('.menu-item:has-text("Dark")');
  await until(async () => (await theme()) === 'dark');
  await tab.click('#theme');
  await tab.click('.menu-item:has-text("Light")');
  await until(async () => (await theme()) === 'light');
  await tab.click('#theme');
  await tab.click('.menu-item:has-text("Match the system")');
  await until(async () => (await theme()) === null);
});

test('on a Mac the window\'s keys take Command, and the + button says so', async () => {
  files();
  const w = await ctx.open({ opens: [A], platform: 'MacIntel' });
  await w.file();
  assert.match(await w.page.$eval('#new-tab', (b) => b.title), /⌘T/);
  await press(w, 'Control+t');
  assert.equal((await w.tabs()).length, 1);
  await press(w, 'Meta+t');
  assert.deepEqual(await names(w), ['a.cssv', '[Home]']);
  // Ctrl+Tab stays Ctrl+Tab, as on other systems.
  await press(w, 'Control+Tab');
  assert.deepEqual(await names(w), ['[a.cssv]', 'Home']);
});

test('the window has no errors through all of this', async () => {
  files();
  const w = await ctx.open({ opens: [A, B] });
  await w.file();
  await press(w, 'Control+w');
  await press(w, 'Control+t');
  assert.deepEqual(w.page.errors, []);
});
