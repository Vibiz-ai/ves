// A small markdown renderer for card.md: headings, paragraphs, lists, blockquotes, pipe tables,
// fenced code, inline code, bold, italic and links. All text is HTML-escaped first; link targets
// are restricted to http(s), mailto and in-page anchors.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeHref(h: string): string | null {
  const t = h.trim();
  if (/^(https?:|mailto:)/i.test(t) || t.startsWith('#')) return t;
  return null;
}

export function inline(src: string): string {
  // pull code spans out first so their contents are not formatted
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_, c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => {
    const h = safeHref(href.replace(/&amp;/g, '&'));
    return h ? `<a href="${esc(h)}" rel="noreferrer">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|\W)_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

const isTableSep = (l: string | undefined) => !!l && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
};

export function slug(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(h[1].length + 1, 6); // card h1 renders as h2 under the page title
      out.push(`<h${lvl} id="card-${slug(h[2])}">${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) body.push(cells(lines[i++]));
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          `</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr />'); i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s+)/.test(lines[i]) && !(lines[i].trim().startsWith('|') && isTableSep(lines[i + 1]))) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}
