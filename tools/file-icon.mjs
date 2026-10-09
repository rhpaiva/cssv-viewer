// Makes the icon of .cssv files from its two drawings in src-tauri/icons/file/:
// cssv-file-small.svg up to 32 px, cssv-file.svg above. It writes the PNGs the
// Linux packages and the AppImage install into hicolor's mimetypes folders,
// cssv-file.ico for Windows and cssv-file.icns for macOS, next to the drawings.
//
//   node tools/file-icon.mjs
//
// Chromium draws them: the one at CHROME_PATH when it is set, else Playwright's.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dir = join(import.meta.dirname, '../src-tauri/icons/file');
const drawing = (name) => `data:image/svg+xml;base64,${readFileSync(join(dir, name)).toString('base64')}`;
const small = drawing('cssv-file-small.svg');
const large = drawing('cssv-file.svg');

const executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
/** A PNG of a drawing at a size. */
async function render(src, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}">`);
  await page.$eval('img', (img, src) => new Promise((done) => { img.onload = done; img.src = src; }), src);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const drawn = (size) => render(size <= 32 ? small : large, size);

// Linux: one PNG per hicolor size.
const png = {};
for (const size of [16, 22, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  png[size] = await drawn(size);
  if (size < 1024) writeFileSync(join(dir, `${size}x${size}.png`), png[size]);
}
// macOS draws a 16 or 32 pt icon at twice the pixels on a Retina screen: the small drawing still.
const smallRetina = { 32: png[32], 64: await render(small, 64) };
await browser.close();

// Windows: an .ico of PNGs, which Windows reads since Vista.
const icoSizes = [16, 24, 32, 48, 64, 256];
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((size, i) => {
  const entry = 6 + 16 * i;
  header.writeUInt8(size % 256, entry); // 0 means 256
  header.writeUInt8(size % 256, entry + 1);
  header.writeUInt16LE(1, entry + 4); // planes
  header.writeUInt16LE(32, entry + 6); // bits per pixel
  header.writeUInt32LE(png[size].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png[size].length;
});
writeFileSync(join(dir, 'cssv-file.ico'), Buffer.concat([header, ...icoSizes.map((size) => png[size])]));

// macOS: an .icns of PNGs, one per type.
const icnsTypes = [
  ['icp4', png[16]], ['ic11', smallRetina[32]],
  ['icp5', png[32]], ['ic12', smallRetina[64]],
  ['ic07', png[128]], ['ic13', png[256]],
  ['ic08', png[256]], ['ic14', png[512]],
  ['ic09', png[512]], ['ic10', png[1024]],
];
const chunks = icnsTypes.map(([type, data]) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(8 + data.length, 4);
  return Buffer.concat([head, data]);
});
const icnsHead = Buffer.alloc(8);
icnsHead.write('icns', 0, 'ascii');
icnsHead.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
writeFileSync(join(dir, 'cssv-file.icns'), Buffer.concat([icnsHead, ...chunks]));
