// Turning a page into something an agent can read cheaply: find the main
// content, then serialize it as structured markdown (headings, lists, links,
// tables) instead of a flat innerText blob. Research backing:
//   - Cloudflare "Markdown for Agents": HTML -> markdown cut one article from
//     16,180 to 3,150 tokens (~80%).
//   - VibeBrowser MCP benchmark: markdown beat HTML by 41% aggregate tokens,
//     while a raw accessibility tree only won 15%.
//   - dom-to-semantic-markdown / Dripper / Trafilatura: main-content detection
//     is what removes nav, footer, and ad boilerplate before conversion.
// Pure functions over a DOM-like node, so they unit-test without a browser.

const READABLE_DROP_HINTS = [
  'nav', 'menu', 'sidebar', 'footer', 'header', 'banner', 'breadcrumb', 'pagination',
  'comment', 'share', 'social', 'related', 'recommend', 'promo', 'advert', 'cookie',
  'consent', 'newsletter', 'subscribe', 'modal', 'popup', 'overlay', 'toolbar',
  'skip-link', 'search-form', 'widget', 'sponsor'
];

const READABLE_KEEP_HINTS = [
  'article', 'content', 'post', 'entry', 'story', 'body-text', 'main-content',
  'markdown', 'prose', 'documentation', 'doc-content'
];

function readableTag(node) {
  return String(node?.tagName ?? '').toUpperCase();
}

function readableAttr(node, name) {
  try {
    return node?.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

// class + id + a few ARIA hints, lowercased, used only for hint matching.
function readableHints(node) {
  const parts = [
    readableAttr(node, 'class'),
    readableAttr(node, 'id'),
    readableAttr(node, 'role'),
    readableAttr(node, 'aria-label')
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function readableText(node) {
  const raw = node?.innerText ?? node?.textContent ?? '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function readableChildren(node) {
  if (Array.isArray(node?.children)) return node.children;
  const nodes = node?.childNodes;
  if (!nodes) return [];
  return Array.from(nodes).filter(child => child?.nodeType === undefined || child.nodeType === 1);
}

// A cheap link-density measure: a nav or a footer is mostly links, an article
// body is mostly prose. Readability uses the same signal to separate the two.
function readableLinkDensity(node) {
  const text = readableText(node);
  if (!text) return 0;
  let linkChars = 0;
  const links = typeof node?.querySelectorAll === 'function' ? node.querySelectorAll('a') : [];
  for (const link of links) linkChars += readableText(link).length;
  return linkChars / text.length;
}

// Score a candidate block the way Readability does: reward raw text length and
// punctuation (a proxy for real sentences), punish link density. A block that
// names itself article/content/post gets a large bonus; one that names itself
// nav/footer/sidebar gets a large penalty so it can never win.
function readableScore(node, hints) {
  const text = readableText(node);
  const length = text.length;
  if (length < 25) return -Infinity;
  const commas = (text.match(/[,،，]/g) ?? []).length;
  const sentences = (text.match(/[.!?。！？]/g) ?? []).length;
  let score = Math.min(Math.floor(length / 100), 3)
    + commas
    + sentences
    + Math.min(Math.floor(length / 100), 3) * 2;
  if (READABLE_KEEP_HINTS.some(hint => hints.includes(hint))) score += 25;
  if (READABLE_DROP_HINTS.some(hint => hints.includes(hint))) score -= 40;
  score *= (1 - Math.min(readableLinkDensity(node), 1));
  return score;
}

// Pick the block that most looks like the article body. Preference order: an
// explicit <article>/<main>, then the best-scoring <section>/<div>, then the
// largest text container, then <body>. This is what makes a page without a
// <main> element still read as its article rather than its whole chrome.
export function findReadableRoot(documentRef) {
  if (!documentRef) return null;
  const explicit = documentRef.querySelector?.('article, [role="main"], main');
  if (explicit && readableText(explicit).length >= 100) return explicit;

  const pool = typeof documentRef.querySelectorAll === 'function'
    ? Array.from(documentRef.querySelectorAll('article, section, div, td, main'))
    : [];
  let best = null;
  let bestScore = 0;
  for (const node of pool) {
    const score = readableScore(node, readableHints(node));
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  if (best) return best;

  // No block scored (a tiny or very unusual page): fall back to <body> so a read
  // never comes back empty and still behaves like the old main-or-body choice.
  return documentRef.body ?? documentRef.documentElement ?? null;
}

// Boilerplate the scored root may still contain: a nav or footer nested inside a
// <main>. Drop only elements that both look like chrome and are link-heavy or
// tiny, so a real content block whose class merely contains "comment" is kept.
export function isReadableNoise(node) {
  const tag = readableTag(node);
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') return true;
  const hints = readableHints(node);
  const looksLikeChrome = READABLE_DROP_HINTS.some(hint => hints.includes(hint));
  if (!looksLikeChrome) return false;
  return readableLinkDensity(node) > 0.5 || readableText(node).length < 80;
}

const READABLE_CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);

// Is this control part of the page chrome (header, nav, sidebar, footer) rather
// than the content the reader came for? Walks the ancestor chain so a button
// nested inside a `<nav>` counts, not just a `<nav>` itself. Shares the hint
// list with the content reader so both agree on what "chrome" means.
export function isChromeElement(element) {
  let node = element;
  let depth = 0;
  while (node && depth < 30) {
    const tag = readableTag(node);
    if (READABLE_CHROME_TAGS.has(tag)) return true;
    const role = readableAttr(node, 'role');
    if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary') return true;
    const hints = readableHints(node);
    if (hints && READABLE_DROP_HINTS.some(hint => hints.includes(hint))) return true;
    node = node.parentElement ?? null;
    depth += 1;
  }
  return false;
}

const READABLE_INLINE_TAGS = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'SPAN', 'SMALL', 'SUP', 'SUB', 'MARK', 'ABBR', 'TIME', 'U', 'S', 'DEL', 'INS', 'KBD', 'VAR', 'SAMP', 'BDI', 'BDO', 'WBR', 'Q', 'CITE', 'DFN', 'DATA', 'LABEL', 'BUTTON']);

function readableInline(node, depth) {
  if (node?.nodeType === 3) return String(node.nodeValue ?? '').replace(/\s+/g, ' ');
  const tag = readableTag(node);
  if (!tag) return '';
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') {
    const alt = readableAttr(node, 'alt');
    return alt ? `![${String(alt).trim()}]` : '';
  }
  if (tag === 'CODE' && readableTag(node.parentElement) !== 'PRE') {
    const code = String(node.textContent ?? '').replace(/\n/g, ' ').trim();
    return code ? `\`${code}\`` : '';
  }
  const inner = readableChildren(node).map(child => readableInline(child, depth)).join('');
  if (tag === 'A') {
    const href = readableAttr(node, 'href');
    const label = inner.replace(/\s+/g, ' ').trim();
    if (!label) return '';
    return href ? `[${label}](${href})` : label;
  }
  return inner;
}

function readableCollapse(text) {
  return text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Serialize a subtree as structured markdown. This is the read the research
// says an agent should get for a content page: headings, lists, links, and
// tables survive, so the model sees the page's shape instead of a text blob.
export function toMarkdown(root, options = {}) {
  if (!root) return '';
  const depthLimit = Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : 60;
  const lines = [];

  function walk(node, depth, listStack) {
    if (!node || depth > depthLimit) return;
    if (node.nodeType === 3) return;
    const tag = readableTag(node);
    if (!tag || isReadableNoise(node)) return;
    const children = readableChildren(node);

    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const text = readableCollapse(readableInline(node, depth)).replace(/\n+/g, ' ');
      if (text) lines.push('', `${'#'.repeat(level)} ${text}`, '');
      return;
    }
    if (tag === 'P') {
      const text = readableCollapse(readableInline(node, depth));
      if (text) lines.push('', text);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const text = readableCollapse(readableInline(node, depth));
      if (text) lines.push('', ...text.split('\n').map(line => `> ${line}`), '');
      return;
    }
    if (tag === 'PRE') {
      const code = String(node.textContent ?? '').replace(/^\n+|\n+$/g, '');
      if (code) lines.push('', '```', code, '```', '');
      return;
    }
    if (tag === 'HR') {
      lines.push('', '---', '');
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      const ordered = tag === 'OL';
      let index = Number(readableAttr(node, 'start')) || 1;
      for (const child of children) {
        if (readableTag(child) !== 'LI' || isReadableNoise(child)) continue;
        const marker = ordered ? `${index}. ` : '- ';
        index += 1;
        const inlineText = readableChildren(child)
          .filter(grand => !['UL', 'OL'].includes(readableTag(grand)))
          .map(grand => readableInline(grand, depth)).join('');
        const text = readableCollapse(inlineText).replace(/\n+/g, ' ');
        lines.push(`${'  '.repeat(listStack)}${marker}${text}`);
        for (const nested of readableChildren(child)) {
          const nestedTag = readableTag(nested);
          if (nestedTag === 'UL' || nestedTag === 'OL') walk(nested, depth + 1, listStack + 1);
        }
      }
      lines.push('');
      return;
    }
    if (tag === 'TABLE') {
      walkTable(node, depth);
      return;
    }
    if (tag === 'FIGCAPTION') {
      const text = readableCollapse(readableInline(node, depth));
      if (text) lines.push('', `*${text}*`);
      return;
    }
    if (READABLE_INLINE_TAGS.has(tag) && !children.some(child => READABLE_BLOCK_TAGS.has(readableTag(child)))) {
      const text = readableCollapse(readableInline(node, depth));
      if (text) lines.push(text);
      return;
    }
    for (const child of children) walk(child, depth + 1, listStack);
  }

  function walkTable(table, depth) {
    const rows = typeof table.querySelectorAll === 'function'
      ? Array.from(table.querySelectorAll('tr'))
      : [];
    if (rows.length === 0) return;
    const grid = rows.map(row => {
      const cells = Array.from(row.children ?? []).filter(cell => ['TD', 'TH'].includes(readableTag(cell)));
      return cells.map(cell => readableCollapse(readableInline(cell, depth)).replace(/\n+/g, ' ').replace(/\|/g, '\\|'));
    });
    const width = Math.max(...grid.map(row => row.length));
    if (width === 0) return;
    const pad = row => [...row, ...Array(width - row.length).fill('')];
    lines.push('');
    lines.push(`| ${pad(grid[0]).join(' | ')} |`);
    lines.push(`| ${Array(width).fill('---').join(' | ')} |`);
    for (const row of grid.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
    lines.push('');
  }

  walk(root, 0, 0);
  const markdown = readableCollapse(lines.join('\n'));
  // A root that is a bare text node (or an element the walker produced nothing
  // for) still has words worth returning, so fall back to its text rather than
  // handing back an empty read.
  return markdown || readableText(root);
}

// A compact heading outline (mini-TOC) so an agent can orient on a long page
// before paying for the full read.
export function headingOutline(root, options = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const limit = Number.isFinite(options.limit) ? Number(options.limit) : 50;
  const outline = [];
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
    if (isReadableNoise(heading)) continue;
    const text = readableText(heading);
    if (!text) continue;
    const explicit = readableAttr(heading, 'aria-level');
    const tag = readableTag(heading);
    const level = Number(explicit) || (/^H[1-6]$/.test(tag) ? Number(tag[1]) : 2);
    outline.push({ level, text: text.slice(0, 120) });
    if (outline.length >= limit) break;
  }
  return outline;
}

// Wrap untrusted page output so the model can tell data from instructions.
// OWASP's LLM prompt-injection guidance calls for a hard separation between
// trusted instructions and untrusted retrieved content; a per-call random
// marker means page text cannot forge the closing boundary.
export function wrapUntrusted(text, marker) {
  if (typeof text !== 'string') return text;
  return `<<<UNTRUSTED_PAGE_CONTENT ${marker}>>>\n${text}\n<<<END_UNTRUSTED_PAGE_CONTENT ${marker}>>>`;
}

export function contentMarker() {
  const random = Math.random().toString(36).slice(2, 10);
  return `mcp-${Date.now().toString(36)}-${random}`;
}
