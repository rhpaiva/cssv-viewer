// The command palette (Ctrl+K): the recent files and the commands, each with
// its shortcut, filtered as the reader types. tabs.js gives the items: the
// window's own commands and those of the current tab's page (viewer.js). An
// item is { label, run, group, detail, shortcut, checked, file }.

const $ = (id) => document.getElementById(id);
const FILE_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>';

const isWordStart = (text, i) => i === 0 || /[\s\-_./\\:(]/.test(text[i - 1]);

// Whether the letters of `query` come in `text` in order, ignoring case and
// spaces: a score and the matched places, or null. The query as one piece
// scores highest, at the start of a word more; otherwise letters that start
// words or follow the last match score more than letters inside words.
export function fuzzy(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return { score: 0, at: [] };
  const whole = t.indexOf(q);
  if (whole >= 0) {
    return { score: 1000 + (isWordStart(t, whole) ? 500 : 0) - whole, at: [...q].map((_, i) => whole + i) };
  }
  // Each letter at the next start of a word that has it, when the letter
  // doesn't follow the last match; that can leave later letters without a
  // place, so plainly in order is the fallback.
  const walk = (preferStarts) => {
    const at = [];
    let from = 0;
    for (const ch of q) {
      let i = t.indexOf(ch, from);
      if (i < 0) return null;
      if (preferStarts && i !== at.at(-1) + 1) {
        for (let j = i; j >= 0; j = t.indexOf(ch, j + 1)) {
          if (isWordStart(t, j)) {
            i = j;
            break;
          }
        }
      }
      at.push(i);
      from = i + 1;
    }
    return at;
  };
  const at = walk(true) ?? walk(false);
  if (!at) return null;
  let score = 0;
  at.forEach((i, n) => {
    if (isWordStart(t, i)) score += 10;
    else if (n > 0 && i === at[n - 1] + 1) score += 5;
    else score -= 1;
  });
  return { score, at };
}

/** `sections()` gives [{ title, items }] when the palette opens; `onClose()` runs when it closes. */
export function createPalette({ sections, onClose }) {
  const root = $('palette');
  const input = $('palette-input');
  const list = $('palette-list');
  let offered = []; // the sections, as they were when the palette opened
  let shown = []; // the items listed, in order
  let active = 0;

  const span = (className, text) => Object.assign(document.createElement('span'), { className, textContent: text ?? '' });

  // The label, with the matched letters marked.
  function label(text, at) {
    const out = span('palette-label');
    const marked = new Set(at);
    let run = '';
    let inMark = false;
    const flush = () => {
      if (!run) return;
      out.append(inMark ? Object.assign(document.createElement('mark'), { textContent: run }) : run);
      run = '';
    };
    [...text].forEach((ch, i) => {
      if (marked.has(i) !== inMark) {
        flush();
        inMark = !inMark;
      }
      run += ch;
    });
    flush();
    return out;
  }

  function row(item, at, index) {
    const el = document.createElement('div');
    el.className = 'palette-item';
    el.id = `palette-item-${index}`;
    el.setAttribute('role', 'option');
    const mark = span('palette-mark', item.file ? '' : item.checked ? '•' : '');
    if (item.file) mark.innerHTML = FILE_ICON;
    const text = span('palette-text');
    if (item.group) text.append(span('palette-group', item.group));
    text.append(label(item.label, at));
    if (item.detail) text.append(span('palette-detail', item.detail));
    el.append(mark, text);
    if (item.shortcut) el.append(Object.assign(document.createElement('kbd'), { textContent: item.shortcut }));
    el.addEventListener('mousemove', () => select(index, { scroll: false }));
    el.addEventListener('click', () => run(index));
    return el;
  }

  // An item matches by its label, or else, scoring less and marking
  // nothing, when each word typed is in its group, label or detail ("num
  // ger" for Numbers in German, a folder's name for the files in it). Whole
  // words, as letters scattered over a long folder would match anything.
  function rank(query, item) {
    const own = fuzzy(query, item.label);
    if (own) return own;
    const text = [item.group, item.label, item.detail].filter(Boolean).join(' ').toLowerCase();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((word) => text.includes(word)) ? { score: -500, at: [] } : null;
  }

  function render() {
    const query = input.value.trim();
    const rows = [];
    shown = [];
    for (const { title, items } of offered) {
      const found = items
        .map((item, order) => ({ item, order, match: rank(query, item) }))
        .filter((x) => x.match);
      if (query) found.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
      if (!found.length) continue;
      rows.push(span('palette-heading', title));
      for (const { item, match } of found) {
        rows.push(row(item, match.at, shown.length));
        shown.push(item);
      }
    }
    if (!shown.length) rows.push(span('palette-empty', 'Nothing matches.'));
    list.replaceChildren(...rows);
    select(0);
  }

  function select(index, { scroll = true } = {}) {
    if (!shown.length) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    active = (index + shown.length) % shown.length;
    for (const el of list.querySelectorAll('.palette-item')) el.setAttribute('aria-selected', String(el.id === `palette-item-${active}`));
    input.setAttribute('aria-activedescendant', `palette-item-${active}`);
    if (scroll) $(`palette-item-${active}`).scrollIntoView({ block: 'nearest' });
  }

  function run(index) {
    const item = shown[index];
    if (!item) return;
    close();
    item.run();
  }

  const isOpen = () => root.classList.contains('open');

  function open() {
    if (isOpen()) return;
    offered = sections();
    input.value = '';
    root.classList.add('open'); // comes in (tabs.css)
    render();
    input.focus();
  }

  function close() {
    if (!isOpen()) return;
    root.classList.remove('open');
    onClose?.();
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') select(active + 1);
    else if (event.key === 'ArrowUp') select(active - 1);
    else if (event.key === 'PageDown') select(Math.min(active + 8, shown.length - 1));
    else if (event.key === 'PageUp') select(Math.max(active - 8, 0));
    else if (event.key === 'Enter') run(active);
    else if (event.key === 'Escape') close();
    else if (event.key !== 'Tab') return; // Tab stays in the box
    event.preventDefault();
    event.stopPropagation();
  });
  // A press outside the box closes it.
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });

  return { open, close, isOpen, toggle: () => (isOpen() ? close() : open()) };
}
