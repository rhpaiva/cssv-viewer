// Print preview: the table on paper, as the printer gets it. Adapted from the
// web editor's (site/editor/sheet.js). The preview renders a copy of the file
// in which the style block's @media print rules apply and its screen rules
// don't, on white paper; width-based media queries still see the window, not
// the paper. Its pages are columns one page high, so the browser splits the
// table between them as it does between printed pages. Printing prints the
// window's own table (viewer.css) at the paper, scale and margins chosen here.
import { rewriteCssUrls, splitFile } from './core.js';

const { core } = parent.__TAURI__; // the window's, as a tab is a frame (viewer.js)
const $ = (id) => document.getElementById(id);
const PAPER = { a4: ['A4', 210, 297], letter: ['Letter', 215.9, 279.4] };
const PX = 96 / 25.4; // CSS pixels per millimeter
const GAP = 32; // between sheets
const WRAP = CSS.supports('column-wrap', 'wrap') && CSS.supports('column-height', '1px');
const LINUX = /Linux/.test(navigator.platform);
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// Resolves when `el`'s opacity has finished its transition (viewer.css), or
// at once when the reader asks for less motion.
function faded(el) {
  return new Promise((resolve) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return resolve();
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('transitionend', end);
      resolve();
    };
    const end = (e) => e.target === el && e.propertyName === 'opacity' && done();
    const timer = setTimeout(done, 500);
    el.addEventListener('transitionend', end);
  });
}

// Printing repeats the header row on every page where the engine does;
// columns repeat it only when it can't break, so the preview's copy says so,
// in a layer that the file's own rules override.
const REPEAT_HEADER = '\n@layer cssv-viewer-preview { thead { break-inside: avoid; } }\n';

// @media print rules apply and screen rules don't.
const asPrinted = (css) => css.replace(/@media\b[^{;]*/gi, (prelude) => prelude
  .replace(/\bprint\b/gi, '\0').replace(/\bscreen\b/gi, 'print').replace(/\0/g, 'all'));

function printText(text, { plain, base }) {
  let style;
  let data;
  try {
    ({ style, data } = splitFile(text));
  } catch {
    return text; // the window shows why it doesn't parse
  }
  const css = plain || style === null ? '' : asPrinted(rewriteCssUrls(style, base));
  return `---\n${css}${REPEAT_HEADER}---\n${data}`;
}

/**
 * `tab` is the tab's id; `host()` is its <cssv-table>; `source()` gives the
 * file's text, whether the tab shows it plain, and its URL.
 */
export function createPrint({ tab, host, source }) {
  const view = $('print-view');
  let table = null; // the preview's <cssv-table>, new each time it opens
  const size = $('print-paper');
  const orientation = $('print-orientation');
  const scale = $('print-scale');
  const margins = $('print-margins');
  const bg = $('print-bg');
  const pageRule = document.head.appendChild(document.createElement('style'));
  size.value = /-(US|CA|MX|PH)$/.test(navigator.language) ? 'letter' : 'a4';
  let returnFocus = null;
  let shown = false; // opening or open, not closing
  let turn = 0; // the latest open() or close(); an older one stops

  function layout() {
    const [name, w0, h0] = PAPER[size.value];
    const landscape = orientation.value === 'landscape';
    const [w, h] = (landscape ? [h0, w0] : [w0, h0]).map((mm) => mm * PX);
    const margin = Number(margins.value) * PX;
    const width = w - 2 * margin;
    const height = h - 2 * margin;
    // One column per page: a page's printable box, at the page's margins.
    Object.assign($('pages').style, {
      left: `${margin}px`, top: `${margin}px`, width: `${width}px`, columnWidth: `${width}px`,
      ...(WRAP
        ? { columnHeight: `${height}px`, columnWrap: 'wrap', rowGap: `${2 * margin + GAP}px`, height: '' }
        : { height: `${height}px`, columnGap: `${2 * margin + GAP}px` }),
    });
    table.style.zoom = '1';
    const natural = table.table?.getClientRects()[0]?.width ?? width;
    const zoom = scale.value === 'fit' && natural > width + 0.5 ? width / natural : 1;
    table.style.zoom = String(zoom);
    const pages = Math.max(1, table.getClientRects().length);
    const at = (i) => (WRAP ? { left: 0, top: i * (h + GAP) } : { left: i * (w + GAP), top: 0 });
    $('papers').innerHTML = Array.from({ length: pages }, (_, i) => {
      const { left, top } = at(i);
      return `<div class="sheet" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px"><span>Page ${i + 1} of ${pages}</span></div>`;
    }).join('');
    Object.assign($('sheets').style, {
      width: `${WRAP ? w : pages * w + (pages - 1) * GAP}px`,
      height: `${WRAP ? pages * h + (pages - 1) * GAP : h}px`,
      marginBottom: '28px',
    });
    const scaled = zoom < 1 ? `scaled to ${Math.round(zoom * 100)}%` : 'actual size';
    $('print-info').textContent = `${name}, ${landscape ? 'landscape' : 'portrait'} · ${scaled} · ${pages} ${pages === 1 ? 'page' : 'pages'}`;
    // What printing uses (viewer.css, and the print dialog on Linux).
    document.documentElement.style.setProperty('--print-zoom', String(zoom));
    document.documentElement.classList.toggle('print-economy', !bg.checked);
    // WebKitGTK takes the paper from the print dialog, which the Rust side
    // sets up with it; a size in @page as well turns a landscape page blank.
    const paper = LINUX ? '' : `size: ${name} ${landscape ? 'landscape' : 'portrait'}; `;
    pageRule.textContent = `@page { ${paper}margin: ${Number(margins.value)}mm; }`;
    core.invoke('set_page', { tab, page: { paper: size.value, landscape, margin: Number(margins.value) } }).catch(() => {});
  }

  // The preview is laid out while still transparent, then comes in, so its
  // paper doesn't appear after it. `laidOut` settles once the latest
  // opening has laid out the pages and told printing about the paper, or
  // has stopped.
  let laidOut = Promise.resolve();
  function open() {
    if (!host()?.table || shown) return laidOut;
    shown = true;
    const mine = ++turn;
    returnFocus = document.activeElement;
    view.hidden = false;
    // The window's language for numbers, set before the table is in the page:
    // WebKit doesn't match :lang() in a table whose host gets lang later.
    table = document.createElement('cssv-table');
    const lang = host().getAttribute('lang');
    if (lang) table.setAttribute('lang', lang);
    $('pages').replaceChildren(table);
    laidOut = (async () => {
      await table.update(printText(...source()));
      await frame();
      if (mine !== turn) return;
      layout();
      view.classList.add('open');
      $('print-go').focus();
    })();
    return laidOut;
  }

  // Printing waits for the preview: before it has laid out the pages, the
  // print dialog would get neither the paper nor the file's name. Closed
  // meanwhile, it doesn't print.
  async function print() {
    await laidOut;
    if (shown) window.print();
  }

  async function close() {
    if (!shown) return;
    shown = false;
    const mine = ++turn;
    view.classList.remove('open');
    returnFocus?.focus?.();
    await faded(view);
    if (mine === turn) view.hidden = true;
  }

  for (const control of [size, orientation, scale, margins, bg]) control.addEventListener('change', layout);
  $('print-close').addEventListener('click', close);
  $('print-go').addEventListener('click', print);
  // Escape closes the preview, wherever the focus is.
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !shown) return;
    e.preventDefault();
    close();
  });

  return {
    open,
    isOpen: () => shown,
    /** Ctrl+P: the preview first, then from the preview the print dialog. */
    request: () => (shown ? print() : open()),
  };
}
