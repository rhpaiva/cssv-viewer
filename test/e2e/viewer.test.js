// The real viewer, from its start to its end (harness.js): what only the
// window can do, and the Rust side of every command the pages call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { desktop, launch, plain, until } from './harness.js';

const BUDGET = `---
/* cssv:title Budget */
@import "brand.css";
---
Item,Cost
Rent,1200
`;

/** Writes the tables the tests open into a folder of the home. */
function tables(desk) {
  const dir = path.join(desk.home, 'tables');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'budget.cssv'), BUDGET);
  fs.writeFileSync(path.join(dir, 'brand.css'), 'td { color: rgb(1, 2, 3); }\n');
  fs.writeFileSync(path.join(dir, 'other.cssv'), '---\n/* cssv:title Other */\n---\nA\n1\n');
  return dir;
}

/** Runs `script` in the page of the tab shown, then goes back to the window. */
async function inTab(session, script) {
  await session.frame('iframe:not([hidden])');
  try {
    return await session.run(script);
  } finally {
    await session.top();
  }
}

/** Waits for `script` to return something truthy in the page of the tab shown. */
const untilInTab = (session, script, what = script) => until(() => inTab(session, script).catch(() => false), { what });

/** Clicks the item named `label` in the menu the page shows. */
const menuItem = (label) => `[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`;

/** The first column of the tab's table, once it's ready. */
const firstColumn = `const t = document.querySelector('cssv-table'); return t && t.ready.then(() => [...t.table.tBodies[0].rows].map((r) => r.cells[0].textContent))`;

describe('a viewer started with a file', () => {
  let desk, dir, session;
  before(async () => {
    // Started as an AppImage: it offers to open .cssv files from the desktop.
    const appimage = path.join(process.env.TMPDIR ?? '/tmp', `cssv-e2e-${process.pid}.AppImage`);
    fs.writeFileSync(appimage, '');
    desk = await desktop({ APPIMAGE: appimage });
    dir = tables(desk);
    session = await launch(desk, [path.join(dir, 'budget.cssv')]);
  });

  after(async () => {
    // Closing the last tab closes the window, and with it the viewer.
    for (;;) {
      const left = await session.run(`const close = document.querySelector('.tab-close'); close?.click(); return document.querySelectorAll('.tab').length`).catch(() => 0);
      if (!left) break;
    }
    await session.ended();
    fs.rmSync(desk.env.APPIMAGE, { force: true });
    await desk.stop();
  });

  it("names the window and the tab after the file's title", async () => {
    await until(async () => (await session.title()) === 'Budget — CSSV Viewer', { what: "the file's title" });
    assert.equal(await session.run(`return document.querySelector('.tab-name').textContent`), 'Budget');
  });

  it('shows the table, with the stylesheet beside the file (the cssv: protocol)', async () => {
    assert.deepEqual(await untilInTab(session, firstColumn, 'the table'), ['Rent']);
    const seen = await inTab(session, `const t = document.querySelector('cssv-table'); return [t.errors.length, getComputedStyle(t.table.tBodies[0].rows[0].cells[0]).color]`);
    assert.deepEqual(seen, [0, 'rgb(1, 2, 3)']);
  });

  it('shows a new version of the file when it changes on disk', async () => {
    fs.writeFileSync(path.join(dir, 'budget.cssv'), BUDGET.replace('Rent,1200', 'Rent,1200\nFood,300'));
    await until(async () => (await inTab(session, firstColumn).catch(() => null))?.join() === 'Rent,Food', { what: 'the new version' });
  });

  it("saves the data as CSV, in the file's folder unless the reader picks another", async () => {
    await session.frame('iframe:not([hidden])');
    await session.click('#export');
    await session.run(menuItem('Data as CSV'));
    await session.top();
    const dialog = await desk.dialog('^Save File$');
    desk.xdotool('key', '--window', dialog, 'Return');
    const csv = path.join(dir, 'budget.csv');
    await until(() => fs.existsSync(csv) && fs.readFileSync(csv, 'utf8'), { what: 'budget.csv' });
    assert.match(fs.readFileSync(csv, 'utf8'), /^Item,Cost\r?\nRent,1200\r?\nFood,300\r?\n$/);
  });

  it('saves only bytes, and nothing when the reader cancels', async () => {
    const invoke = (body, headers = {}) => `window.__TAURI__.core.invoke('save_file', ${body}, { headers: ${JSON.stringify(headers)} })`;
    assert.equal(await session.run(`return ${invoke('{}')}.catch(String)`), "Expected the file's bytes.");
    // From a tab without a file, the dialog opens where GTK likes. The
    // answer comes when it closes.
    await session.run(`${invoke('new Uint8Array([97])', { 'x-name': 'x.csv', 'x-kind': 'CSV', 'x-ext': 'csv', 'x-tab': 'gone' })}.then((path) => { window.saved = String(path); })`);
    desk.xdotool('key', '--window', await desk.dialog('^Save File$'), 'Escape');
    assert.equal(await until(() => session.run('return window.saved'), { what: 'the answer' }), 'null');
  });

  it('opens a file in a new tab when the viewer is started again with it', async () => {
    await desk.again([path.join(dir, 'other.cssv')]);
    await until(async () => (await session.title()) === 'Other — CSSV Viewer', { what: 'the second file' });
    assert.deepEqual(await session.run(`return [...document.querySelectorAll('.tab-name')].map((n) => n.textContent)`), ['Budget', 'Other']);
  });

  it('shows the home, with previews of the recent files, when started again without one', async () => {
    await desk.again([]);
    await until(async () => (await session.title()) === 'CSSV Viewer', { what: 'the home' });
    // Each card shows the file's title once its preview has read the file.
    const cards = await untilInTab(
      session,
      `const cards = [...document.querySelectorAll('#recent-cards > *')].map((c) => c.textContent);
       return cards.some((c) => c.includes('Budget')) && cards.some((c) => c.includes('Other')) && cards`,
      'previews of the two recent files',
    );
    assert.equal(cards.length, 2);
  });

  it('sets an AppImage up to open .cssv files from the desktop, and takes that back', async () => {
    const entry = path.join(desk.env.XDG_DATA_HOME, 'applications', 'cssv-viewer.desktop');
    await untilInTab(session, `return !document.getElementById('setup').hidden`, 'the offer');
    await inTab(session, `document.getElementById('setup-yes').click()`);
    await until(() => fs.existsSync(entry), { what: 'the menu entry' });
    assert.match(fs.readFileSync(entry, 'utf8'), new RegExp(`^TryExec=${desk.env.APPIMAGE}$`, 'm'));
    await untilInTab(session, `return document.getElementById('setup').hidden`, 'the offer to go');

    await session.frame('iframe:not([hidden])');
    await session.click('#open-more');
    await session.run(menuItem('Stop opening .cssv files'));
    await session.top();
    await until(() => !fs.existsSync(entry), { what: 'the menu entry to go' });
  });
});

describe('a viewer run as a reader runs it', () => {
  let desk, dir, viewer;
  before(async () => {
    desk = await desktop();
    dir = tables(desk);
    viewer = plain(desk, [path.join(dir, 'budget.cssv')]);
  });

  after(async () => {
    viewer.kill(); // only if a test failed before it quit
    await desk.stop();
  });

  it("prints the table to a PDF named after the file, beside it, on the preview's paper", async () => {
    const window = await desk.window();
    await until(() => desk.xdotool('getwindowname', window).startsWith('Budget'), { what: 'the file' });
    desk.xdotool('windowfocus', '--sync', window);
    desk.xdotool('mousemove', '--window', window, '500', '400', 'click', '1');
    // Ctrl+P shows the print preview, which gives its Print button the
    // focus once it has laid the pages out, so Return prints from then on.
    await desk.keys('ctrl+p');
    await until(
      async () => {
        await desk.keys('Return');
        return until(() => desk.open('^Print$'), { timeout: 5000 }).catch(() => false);
      },
      { what: 'the print dialog', timeout: 60000 },
    );
    const dialog = await desk.dialog('^Print$');
    // "Print to File", the only printer here, then Print.
    desk.xdotool('key', '--window', dialog, 'Down');
    await new Promise((resolve) => setTimeout(resolve, 300));
    desk.xdotool('key', '--window', dialog, 'Return');
    const pdf = path.join(dir, 'budget.pdf');
    await until(() => fs.existsSync(pdf) && fs.statSync(pdf).size > 0 && !desk.open('^Print$'), { what: 'budget.pdf' });
    // A4 portrait, in points.
    assert.deepEqual(fs.readFileSync(pdf, 'latin1').match(/MediaBox \[0 0 (\d+) (\d+)\]/).slice(1), ['595', '842']);
  });

  it('quits with Ctrl+Q', async () => {
    desk.xdotool('windowfocus', '--sync', await desk.window());
    await desk.keys('ctrl+q');
    assert.equal(await viewer.exited, 0);
  });
});
