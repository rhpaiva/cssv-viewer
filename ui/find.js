// Find: searches the values as the file has them, column names included,
// not their formatted display, and marks the cells that hold them. Adapted
// from the web editor's find (site/editor/sheet.js); the viewer doesn't edit,
// so there is no replace.
import { tableRows } from './export.js';

const $ = (id) => document.getElementById(id);
const MARKS = 2000;

/**
 * `stage` scrolls the table; `marks` is a layer inside it. `host()` and
 * `model()` return the current <cssv-table> and the file's parsed model.
 */
export function createFind({ stage, marks, host, model }) {
  const box = $('find');
  const input = $('find-text');
  const count = $('find-count');
  const matchCase = $('find-case');
  const whole = $('find-whole');
  let matches = [];
  let index = -1;

  function search() {
    const query = input.value;
    const m = model();
    if (!query || !m) return [];
    const exact = matchCase.checked;
    const needle = exact ? query : query.toLocaleLowerCase();
    const out = [];
    tableRows(m).forEach((row, r) => row.forEach((value, c) => {
      const v = exact ? value : value.toLocaleLowerCase();
      if (whole.checked ? v === needle : v.includes(needle)) out.push({ r, c });
    }));
    return out;
  }

  function cell({ r, c }) {
    const table = host()?.table;
    if (!table) return null;
    return (r === 0 ? table.tHead?.rows[0] : table.tBodies[0]?.rows[r - 1])?.cells[c] ?? null;
  }

  function showCount() {
    count.textContent = !input.value ? '' : matches.length ? `${index + 1} of ${matches.length}` : 'No matches';
    count.classList.toggle('none', !!input.value && !matches.length);
  }

  // Marks sit in the stage's scrolled content, so they move with the table.
  // A cell the style block hides has no box: it counts, but gets no mark.
  function draw() {
    if (box.hidden || !matches.length) {
      marks.replaceChildren();
      return;
    }
    const origin = stage.getBoundingClientRect();
    const boxes = [];
    matches.slice(0, MARKS).forEach((m, i) => {
      const r = cell(m)?.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return;
      const mark = document.createElement('div');
      mark.className = i === index ? 'mark current' : 'mark';
      Object.assign(mark.style, {
        left: `${r.left - origin.left + stage.scrollLeft}px`,
        top: `${r.top - origin.top + stage.scrollTop}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      boxes.push(mark);
    });
    marks.replaceChildren(...boxes);
  }

  function go(i) {
    if (!matches.length) return;
    index = (i + matches.length) % matches.length;
    cell(matches[index])?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showCount();
    draw();
  }

  function run({ jump = true } = {}) {
    matches = search();
    index = matches.length ? Math.min(Math.max(index, 0), matches.length - 1) : -1;
    if (jump) index = matches.length ? 0 : -1;
    showCount();
    if (jump && index >= 0) go(index);
    else draw();
  }

  function open() {
    if (!model()) return;
    box.hidden = false;
    input.focus();
    input.select();
    if (input.value) run({ jump: false });
  }

  function close() {
    box.hidden = true;
    draw();
  }

  input.addEventListener('input', () => run());
  for (const toggle of [matchCase, whole]) toggle.addEventListener('change', () => run());
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && e.target === input) go(index + (e.shiftKey ? -1 : 1));
    else return;
    e.preventDefault();
  });
  $('find-next').addEventListener('click', () => go(index + 1));
  $('find-prev').addEventListener('click', () => go(index - 1));
  $('find-close').addEventListener('click', close);
  new ResizeObserver(() => draw()).observe(stage);

  return {
    open,
    close,
    /** After the table rendered again: the same search, on the new values. */
    refresh: () => { if (!box.hidden) run({ jump: false }); },
    next: (dir) => (box.hidden ? open() : go(index + dir)),
  };
}
