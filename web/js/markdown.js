/**
 * A small Markdown renderer for what people say in the chat.
 *
 * Two rules shape it:
 *
 *  1. **It builds DOM nodes, never HTML strings.** Every piece of model output
 *     lands via `textContent`, so there is no path by which a stray `<script>`
 *     in an answer becomes markup. The only attribute we ever set from the text
 *     is `href`, and that is checked against a scheme allow-list first.
 *  2. **A link shows its title, not its address.** Answers that cite sources are
 *     otherwise 80% raw URL by volume, which is unreadable. `[제목](주소)`
 *     renders as 제목; a bare URL falls back to its domain, since that is the
 *     only honest short name we have for it. The full address stays on hover
 *     and in the status bar, so nothing is hidden — it just isn't shouted.
 *
 * Deliberately not supported: raw HTML, reference links, footnotes, images.
 * None of them show up in what these sessions write, and each one is a way for
 * text to become markup.
 */

const SAFE_SCHEME = /^(?:https?:|mailto:)/i;

/** Only ever produce an href we can vouch for. */
function safeHref(url) {
  const s = String(url).trim();
  if (SAFE_SCHEME.test(s)) return s;
  // Bare `example.com/x` is written far more often than `http://example.com/x`.
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return `https://${s}`;
  return null;
}

/** The short name to show when the text gave us no title of its own. */
export function linkLabel(url) {
  try {
    const u = new URL(safeHref(url) ?? url);
    if (u.protocol === 'mailto:') return u.pathname;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return String(url);
  }
}

function anchor(label, url) {
  const href = safeHref(url);
  if (!href) return document.createTextNode(label);
  const a = document.createElement('a');
  a.href = href;
  a.textContent = label;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = href; // the address is one hover away, never in the way
  return a;
}

/*
 * One pass over a line, longest-lived syntax first. Code spans come first on
 * purpose: `**` inside backticks is a literal, not emphasis.
 */
const INLINE_SRC = [
  /(`+)([\s\S]*?)\1/,                                   // `code`
  /\*\*([\s\S]+?)\*\*/,                                 // **bold**
  /__([\s\S]+?)__/,                                     // __bold__
  /~~([\s\S]+?)~~/,                                     // ~~strike~~
  /(?<![\w*])\*([^*\n]+?)\*(?![\w*])/,                  // *italic*
  /(?<![\w_])_([^_\n]+?)_(?![\w_])/,                    // _italic_
  /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/,     // [title](url)
  /<((?:https?|mailto):[^>\s]+)>/,                      // <url>
  /\bhttps?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?]/, // bare url
].map((r) => r.source).join('|');

/**
 * A fresh matcher per call, deliberately.
 *
 * `inline()` recurses — emphasis can hold emphasis — and a shared /g regex
 * carries `lastIndex` across those nested calls. The inner call would rewind
 * the outer loop's cursor and the same match would be found forever. One
 * allocation per line is a small price for a parser that terminates.
 */
function matcher() {
  return new RegExp(INLINE_SRC, 'g');
}

function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @returns {DocumentFragment} */
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = matcher();
  let at = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > at) frag.appendChild(document.createTextNode(text.slice(at, m.index)));
    const [whole, , code, bold1, bold2, strike, it1, it2, linkText, linkUrl, angleUrl] = m;

    if (code !== undefined) frag.appendChild(el('code', code));
    else if (bold1 ?? bold2) frag.appendChild(wrap('strong', bold1 ?? bold2));
    else if (strike) frag.appendChild(wrap('s', strike));
    else if (it1 ?? it2) frag.appendChild(wrap('em', it1 ?? it2));
    else if (linkUrl) frag.appendChild(anchor(linkText.trim() || linkLabel(linkUrl), linkUrl));
    else if (angleUrl) frag.appendChild(anchor(linkLabel(angleUrl), angleUrl));
    else frag.appendChild(anchor(linkLabel(whole), whole));

    at = m.index + whole.length;
    // A zero-width match would leave the cursor where it is; nudge it past.
    if (!whole.length) re.lastIndex += 1;
  }
  if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
  return frag;
}

/** Emphasis can contain more emphasis, so its body goes back through inline(). */
function wrap(tag, text) {
  const n = document.createElement(tag);
  n.appendChild(inline(text));
  return n;
}

const H = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ROW = /^\s*\|(.+)\|\s*$/;
const RULE_ROW = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function cells(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/**
 * @param {string} src
 * @returns {DocumentFragment}
 */
export function renderMarkdown(src) {
  const out = document.createDocumentFragment();
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // fenced code — taken verbatim, including anything that looks like markup
    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence (or the end of a still-streaming block)
      const pre = el('pre');
      const code = el('code', body.join('\n'));
      if (fence[1].trim()) code.dataset.lang = fence[1].trim();
      pre.appendChild(code);
      out.appendChild(pre);
      continue;
    }

    if (HR.test(line)) { out.appendChild(el('hr')); i += 1; continue; }

    const h = line.match(H);
    if (h) {
      const node = el(`h${h[1].length}`);
      node.appendChild(inline(h[2]));
      out.appendChild(node);
      i += 1;
      continue;
    }

    // table: a row, then a |---|---| rule under it
    if (ROW.test(line) && i + 1 < lines.length && RULE_ROW.test(lines[i + 1])) {
      const table = el('table');
      const thead = el('thead');
      const hr = el('tr');
      for (const c of cells(line)) { const th = el('th'); th.appendChild(inline(c)); hr.appendChild(th); }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      i += 2;
      while (i < lines.length && ROW.test(lines[i])) {
        const tr = el('tr');
        for (const c of cells(lines[i])) { const td = el('td'); td.appendChild(inline(c)); tr.appendChild(td); }
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);
      const scroller = el('div');
      scroller.className = 'md-table';
      scroller.appendChild(table);
      out.appendChild(scroller);
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(lines[i].match(QUOTE)[1]); i += 1; }
      const bq = el('blockquote');
      bq.appendChild(renderMarkdown(body.join('\n')));
      out.appendChild(bq);
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const [list, next] = takeList(lines, i);
      out.appendChild(list);
      i = next;
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    // A pipe-row that had no |---| under it is *not* a block — it falls through
    // to here as ordinary text, and this loop must be willing to eat it or the
    // whole parse stalls on that line.
    const body = [];
    while (
      i < lines.length && lines[i].trim()
      && !H.test(lines[i]) && !FENCE.test(lines[i]) && !HR.test(lines[i])
      && !BULLET.test(lines[i]) && !NUMBER.test(lines[i]) && !QUOTE.test(lines[i])
    ) { body.push(lines[i]); i += 1; }
    if (!body.length) { body.push(lines[i]); i += 1; } // never stand still
    const p = el('p');
    body.forEach((l, n) => {
      if (n) p.appendChild(el('br'));
      p.appendChild(inline(l));
    });
    out.appendChild(p);
  }

  return out;
}

/**
 * A list and everything nested under it. Nesting is by indentation — the first
 * item sets the level, and anything indented past it belongs to a child list.
 */
function takeList(lines, start) {
  const first = lines[start].match(BULLET) ?? lines[start].match(NUMBER);
  const ordered = !BULLET.test(lines[start]);
  const indent = first[1].length;
  const list = el(ordered ? 'ol' : 'ul');
  if (ordered) {
    const n = Number(lines[start].match(NUMBER)[2]);
    if (n !== 1) list.start = n;
  }

  let i = start;
  let item = null;
  while (i < lines.length) {
    const line = lines[i];
    const b = line.match(BULLET);
    const o = line.match(NUMBER);
    if (!b && !o) {
      // a plain line indented under the current item continues it
      if (item && line.trim() && line.match(/^\s*/)[0].length > indent) {
        item.appendChild(document.createTextNode(' '));
        item.appendChild(inline(line.trim()));
        i += 1;
        continue;
      }
      break;
    }
    const here = (b ?? o)[1].length;
    if (here < indent) break;
    if (here > indent) {
      const [child, next] = takeList(lines, i);
      (item ?? list).appendChild(child);
      i = next;
      continue;
    }
    if ((!!b) === ordered) break; // the list changed kind — that is a new list
    item = el('li');
    item.appendChild(inline(b ? b[2] : o[3]));
    list.appendChild(item);
    i += 1;
  }
  return [list, i];
}
