// The source pane: the file's text, read-only and colored, next to the
// table, with line numbers so a problem can point at its line. Its width is
// dragged from the divider and remembered.
import { highlightCssv } from './highlight.js';
import * as prefs from './prefs.js';

const $ = (id) => document.getElementById(id);
const COLORED = 2_000_000; // longer files show plain text: coloring them would stall the window

export function createSource({ onToggle }) {
  const pane = $('source-pane');
  const scroller = $('source-scroll');
  const code = $('source-code');
  const gutter = $('source-gutter');
  const band = $('source-band');
  const divider = $('source-divider');
  let text = '';

  function render(next) {
    if (next === text && code.childNodes.length) return;
    text = next;
    const lines = text.split('\n').length;
    code.replaceChildren(text.length <= COLORED ? highlightCssv(text) : text);
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    $('source-info').textContent = `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'}`;
  }

  function show(open) {
    pane.hidden = !open;
    divider.hidden = !open;
    prefs.set('source-open', open);
    onToggle(open);
  }

  /** Scrolls to line `n` and marks it for a moment. */
  function jump(n) {
    show(true);
    const height = parseFloat(getComputedStyle(code).lineHeight);
    const top = parseFloat(getComputedStyle(code).paddingTop) + (n - 1) * height;
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
    band.style.top = `${top}px`;
    band.style.height = `${height}px`;
    band.hidden = false;
    band.classList.remove('flash');
    void band.offsetWidth; // restart the animation
    band.classList.add('flash');
  }

  const width = prefs.get('source-width', null);
  if (width) pane.style.width = `${width}px`;
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const room = pane.parentElement.getBoundingClientRect();
      const w = Math.min(Math.max(room.right - ev.clientX, 240), room.width - 240);
      pane.style.width = `${w}px`;
    };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      prefs.set('source-width', parseFloat(pane.style.width) || null);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up, { once: true });
  });
  // The keyboard moves the divider too.
  divider.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    pane.style.width = `${Math.max(240, pane.getBoundingClientRect().width + step)}px`;
    prefs.set('source-width', parseFloat(pane.style.width));
  });

  return { render, show, jump, isOpen: () => !pane.hidden, toggle: () => show(pane.hidden) };
}
