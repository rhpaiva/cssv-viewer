// Copying the table and saving it in other forms. Copies carry the values as
// the file has them (what the source pane shows), not their formatted
// display, so a spreadsheet gets 1234.5 rather than "1,234.50".
import { DEFAULT_CSS, readCssString, rewriteCssUrls, splitFile } from './core.js';

const { core } = window.__TAURI__;

// --- Copying ------------------------------------------------------------------

/** The header and every record, each as a list of the columns' values. */
export function tableRows(model) {
  return [model.columns, ...model.rows.map((r) => model.columns.map((_, c) => r.fields[c] ?? ''))];
}

// Tab-separated, as spreadsheets paste it: a value with a tab, a line break
// or a quote is quoted, its quotes doubled.
const tsvField = (v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const tsv = (rows) => `${rows.map((r) => r.map(tsvField).join('\t')).join('\n')}\n`;

function cellAt(node, offset, table) {
  if (node.nodeType === Node.ELEMENT_NODE && node.childNodes.length) {
    node = node.childNodes[Math.min(offset, node.childNodes.length - 1)];
  }
  const cell = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('td, th');
  return cell && table.contains(cell) ? cell : null;
}

/**
 * The block of cells a selection spans, as { rows: [first, last], cols:
 * [first, last] } in tableRows() terms, or null when it doesn't span cells.
 * Like a spreadsheet, it takes every row and column between the first cell
 * and the last. The table lives in two shadow roots, which only
 * getComposedRanges() sees into.
 */
export function selectedBlock(host) {
  const table = host?.table;
  const selection = getSelection();
  if (!table || !selection.rangeCount || !selection.getComposedRanges) return null;
  const shadowRoots = [];
  for (let root = table.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) shadowRoots.push(root);
  // The selection's own isCollapsed is true for any selection in a shadow root (WebKit).
  const [range] = selection.getComposedRanges({ shadowRoots });
  if (!range || range.collapsed) return null;
  const a = cellAt(range.startContainer, range.startOffset, table);
  const b = cellAt(range.endContainer, range.endOffset, table);
  if (!a || !b || a === b) return null; // within one cell, the selected text is the copy
  const at = (cell) => [cell.closest('thead') ? 0 : cell.parentElement.sectionRowIndex + 1, cell.cellIndex];
  const [[r0, c0], [r1, c1]] = [at(a), at(b)];
  return { rows: [Math.min(r0, r1), Math.max(r0, r1)], cols: [Math.min(c0, c1), Math.max(c0, c1)] };
}

export function blockRows(model, { rows, cols }) {
  return tableRows(model).slice(rows[0], rows[1] + 1).map((r) => r.slice(cols[0], cols[1] + 1));
}

// --- Saving -------------------------------------------------------------------

/**
 * Asks where to save `bytes` and writes them there; the dialog runs on the
 * Rust side, so the page can only write where the reader chose. Returns the
 * path, or null if the reader cancelled.
 */
export function save(bytes, { name, kind, ext }) {
  const headers = { 'x-name': encodeURIComponent(name), 'x-kind': encodeURIComponent(kind), 'x-ext': ext };
  return core.invoke('save_file', bytes, { headers });
}

export const encode = (text) => new TextEncoder().encode(text);

// --- Images -------------------------------------------------------------------

// Comments go first, so an @import or url() in one isn't fetched.
function stripComments(css) {
  let out = '';
  for (let i = 0; i < css.length;) {
    if (css[i] === '"' || css[i] === "'") {
      const end = readCssString(css, i)?.[1] ?? css.length;
      out += css.slice(i, end);
      i = end;
    } else if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
    } else out += css[i++];
  }
  return out;
}

const IMPORT = /@import\s+(?:url\(\s*)?(["'])(.*?)\1\s*\)?\s*([^;]*);/gi;
const URL_VALUE = /url\(\s*(["']?)(.*?)\1\s*\)/gi;

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const dataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/**
 * A style block with everything it loads inside it: imports inlined (with
 * their conditions as @media, @supports or @layer around them) and url()s as
 * data: URLs, because an SVG image loads nothing. What can't be fetched, such
 * as remote content the reader hasn't allowed, is left out.
 */
async function selfContained(css, base, depth = 0) {
  css = stripComments(rewriteCssUrls(css, base));
  const imports = [];
  css = css.replace(IMPORT, (_, q, url, conditions) => {
    imports.push({ url, conditions: conditions.trim() });
    return '';
  });
  let out = '';
  for (const { url, conditions } of imports) {
    if (depth > 8) break;
    try {
      let inner = await selfContained(await (await fetchOk(url)).text(), url, depth + 1);
      const layer = /\blayer(?:\(\s*([^)]*)\))?/i.exec(conditions);
      const supports = /\bsupports\((.*)\)/i.exec(conditions);
      const media = conditions.replace(/\blayer(?:\([^)]*\))?|\bsupports\(.*\)/gi, '').trim();
      if (media) inner = `@media ${media} {\n${inner}\n}`;
      if (supports) inner = `@supports (${supports[1]}) {\n${inner}\n}`;
      if (layer) inner = `@layer ${layer[1] ?? ''} {\n${inner}\n}`;
      out += `${inner}\n`;
    } catch {
      // not loaded in the window either
    }
  }
  const urls = [...new Set([...css.matchAll(URL_VALUE)].map((m) => m[2]).filter((u) => !/^data:/i.test(u)))];
  const embedded = new Map();
  await Promise.all(urls.map(async (url) => {
    try {
      embedded.set(url, await dataUrl(await (await fetchOk(url)).blob()));
    } catch {
      // left as it is: the image shows without it
    }
  }));
  out += css.replace(URL_VALUE, (whole, q, url) => (embedded.has(url) ? `url("${embedded.get(url)}")` : whole));
  return out;
}

const escapeXml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// What the table inherits from the window (SPEC 8.1): its font and color.
const inherited = (cs, width) => [
  `width:${width}px`, 'contain:paint', `color:${cs.color}`, `font-family:${cs.fontFamily}`,
  `font-size:${cs.fontSize}`, `line-height:${cs.lineHeight}`, `font-weight:${cs.fontWeight}`,
  `font-style:${cs.fontStyle}`, `direction:${cs.direction}`,
].join(';');

/**
 * A copy of the table whose CSS animations start where the window's are
 * now: each animated element gets a negative animation-delay, the time its
 * animation has run. `paused` holds them there, for a still picture.
 * Animations on ::before and ::after can't be reached this way and start
 * from their beginning.
 */
function atThisMoment(table, paused) {
  const copy = table.cloneNode(true);
  const originals = document.createTreeWalker(table, NodeFilter.SHOW_ELEMENT);
  const copies = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT);
  for (let el = originals.currentNode, twin = copies.currentNode; el && twin; el = originals.nextNode(), twin = copies.nextNode()) {
    const running = el.getAnimations().filter((a) => a instanceof CSSAnimation && a.effect?.target === el && !a.effect.pseudoElement);
    if (!running.length) continue;
    const cs = getComputedStyle(el);
    const delays = cs.animationDelay.split(/,\s*/);
    const names = cs.animationName.split(/,\s*/);
    twin.style.animationDelay = names.map((name, i) => {
      const animation = running.find((a) => a.animationName === name);
      if (!animation || animation.currentTime === null) return delays[i % delays.length];
      return `${(animation.effect.getTiming().delay - animation.currentTime) / 1000}s`;
    }).join(', ');
    if (paused) twin.style.animationPlayState = 'paused';
  }
  return copy;
}

/**
 * The table as it shows, as an SVG: its markup with the default styles and
 * the file's style block in a <foreignObject>, at the table's size, on the
 * window's background. Its animations go on from where they are; `paused`
 * stops them there.
 */
export async function svgOf(host, { text, plain, base, paused = false }) {
  const table = host.table;
  const box = table.getBoundingClientRect();
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);
  const style = plain ? null : splitFile(text).style;
  // The style block's :host is the element around the table; in the SVG
  // that's the .frame div.
  const author = style ? (await selfContained(style, base)).replace(/:host(?![\w(-])/g, '.frame') : '';
  const freeze = paused ? '\n*::before, *::after { animation-play-state: paused !important; }' : '';
  const outer = getComputedStyle(host);
  const page = getComputedStyle(document.body).backgroundColor;
  const markup = new XMLSerializer().serializeToString(atThisMoment(table, paused));
  const css = `${DEFAULT_CSS}\n${author}${freeze}`.replace(/]]>/g, ']]]]><![CDATA[>');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="${page}"/>
<foreignObject width="${width}" height="${height}">
<div xmlns="http://www.w3.org/1999/xhtml" class="frame" style="${escapeXml(inherited(outer, width))}">
<style><![CDATA[
${css}
]]></style>
${markup}
</div>
</foreignObject>
</svg>
`;
  return { svg, width, height };
}

/**
 * The same picture as a PNG, held still, at twice the size where it fits in
 * a canvas. WebKit paints an SVG image without 3D transforms (as it paints
 * its own snapshots of a page), so a table drawn in 3D comes out flat; the
 * SVG itself keeps them for a browser that opens it.
 */
export async function pngOf(host, options) {
  const { svg, width, height } = await svgOf(host, { ...options, paused: true });
  const scale = Math.min(2, 16384 / width, 16384 / height, Math.sqrt(120e6 / (width * height)));
  const image = new Image();
  // A data: URL, since WebKit won't let a canvas that drew a blob: SVG be read.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
