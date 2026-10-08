// Syntax colors for the source pane: a CSSV file, its style block and its
// data. A copy of the CSSV part of the website's site/highlight.js, so the
// viewer needs nothing outside desktop/.

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/; // SPEC 6.1
const FENCE = /^﻿?---[ \t]*\r?\n?$/;      // SPEC 3.4
const HOOK = /(data-(?:col|row|key)|\.(?:number|negative|positive|zero)\b)/;
const CSS_TOKEN = /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|[{};:]|[^{};:"'/]+|\//g;
const NESTING_AT_RULE = /^\s*@(?:media|supports|layer|container|keyframes|scope|document)\b/;

export function span(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

// Selectors, with the table model's hooks (data-* and the four classes) marked.
function selector(text, out) {
  text.split(HOOK).forEach((part, i) => {
    if (part) out.append(span(i % 2 ? 't-hook' : 't-sel', part));
  });
}

// A style block, a stylesheet or a few lines of one.
export function highlightCss(css, out = document.createDocumentFragment()) {
  const stack = ['rules'];
  let prelude = '';
  let inValue = false;
  for (const [tok] of css.matchAll(CSS_TOKEN)) {
    const isString = tok[0] === '"' || tok[0] === "'";
    if (tok.startsWith('/*')) { out.append(span('t-comment', tok)); continue; }
    if (tok === '{' || tok === '}' || tok === ';') {
      if (tok === '{') stack.push(stack.at(-1) === 'rules' && NESTING_AT_RULE.test(prelude) ? 'rules' : 'decls');
      if (tok === '}' && stack.length > 1) stack.pop();
      prelude = '';
      inValue = false;
      out.append(span('t-punct', tok));
      continue;
    }
    if (stack.at(-1) === 'rules') {
      prelude += tok;
      if (isString) out.append(span('t-str', tok));
      else if (prelude.trimStart().startsWith('@')) {
        tok.split(/(@[\w-]+)/).forEach((part, i) => { if (part) out.append(span(i % 2 ? 't-at' : 't-atp', part)); });
      } else selector(tok, out);
      continue;
    }
    if (tok === ':' && !inValue) { inValue = true; out.append(span('t-punct', tok)); continue; }
    if (isString) { out.append(span('t-str', tok)); continue; }
    if (inValue) { out.append(span('t-val', tok)); continue; }
    const name = tok.trim();
    out.append(span(name.startsWith('--cssv-') ? 't-cssv' : name.startsWith('--') ? 't-var' : 't-prop', tok));
  }
  return out;
}

function highlightCsv(data, out) {
  // SPEC 5.1: the delimiter is whichever of , and ; the header uses more.
  let quoted = false, commas = 0, semicolons = 0;
  for (const ch of data) {
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '\n' || ch === '\r') break;
    else if (ch === ',') commas++;
    else if (ch === ';') semicolons++;
  }
  const delimiter = semicolons > commas ? ';' : ',';
  let pos = 0, record = 0, lineHasField = false;
  while (pos < data.length) {
    const ch = data[pos];
    if (ch === delimiter) { out.append(span('t-delim', ch)); pos++; lineHasField = true; continue; }
    if (ch === '\r' || ch === '\n') {
      const end = data.startsWith('\r\n', pos) ? pos + 2 : pos + 1;
      out.append(data.slice(pos, end));
      if (lineHasField) record++;
      lineHasField = false;
      pos = end;
      continue;
    }
    let end = pos;
    if (ch === '"') {
      end++;
      while (end < data.length) {
        if (data[end] !== '"') end++;
        else if (data[end + 1] === '"') end += 2;
        else { end++; break; }
      }
    }
    while (end < data.length && data[end] !== delimiter && data[end] !== '\n' && data[end] !== '\r') end++;
    const field = data.slice(pos, end);
    const cls = record === 0 ? 't-head' : ch === '"' ? 't-quoted' : NUMBER.test(field) ? 't-num' : 't-text';
    out.append(span(cls, field));
    lineHasField = true;
    pos = end;
  }
}

export function highlightCssv(text) {
  const out = document.createDocumentFragment();
  const lines = text.split(/(?<=\n)/);
  let i = 0;
  if (lines.length && FENCE.test(lines[0])) {
    out.append(span('t-fence', lines[i++]));
    let css = '';
    while (i < lines.length && !FENCE.test(lines[i])) css += lines[i++];
    highlightCss(css, out);
    if (i < lines.length) out.append(span('t-fence', lines[i++]));
  }
  highlightCsv(lines.slice(i).join(''), out);
  return out;
}
