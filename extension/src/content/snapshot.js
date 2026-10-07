import { boundingBox } from './refs.js';

const MAX_RESPONSE_BYTES = 1000000;
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch',
  'tab', 'option', 'menuitem', 'searchbox', 'slider', 'spinbutton'
]);

function bounded(result) {
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('Content response exceeds 1 MB.'), { code: 'ACTION_TIMEOUT', retryable: false });
  }
  return result;
}

export function createSnapshotEngine({ documentRef, refs, semantics, windowRef }) {
  function inViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < windowRef.innerHeight && rect.left < windowRef.innerWidth;
  }

  function contains(root, element) {
    return root === element || (typeof root.contains === 'function' && root.contains(element));
  }

  function matchesScope(element, options) {
    if (options.selector) {
      const roots = documentRef.querySelectorAll(options.selector);
      let contained = false;
      for (const root of roots) {
        if (contains(root, element)) { contained = true; break; }
      }
      if (!contained) return false;
    }
    if (options.scope === 'viewport') {
      if (!inViewport(element)) return false;
    } else if (options.scope === 'dialog') {
      const dialog = typeof documentRef.querySelector === 'function'
        ? documentRef.querySelector('[role="dialog"],[aria-modal="true"],dialog[open]')
        : null;
      if (!dialog || !contains(dialog, element)) return false;
    } else if (options.scope === 'form') {
      if (typeof element.closest !== 'function' || !element.closest('form')) return false;
    }
    if (options.maxDepth !== undefined) {
      let depth = 0;
      let node = element.parentElement;
      while (node) { depth += 1; node = node.parentElement; }
      if (depth > Number(options.maxDepth)) return false;
    }
    if (options.interactiveOnly && !INTERACTIVE_ROLES.has(semantics.role(element))) return false;
    return true;
  }

  // Rank candidates against what the caller is actually trying to do. DOM order
  // is the worst possible order for a long page: the header and nav sit first and
  // a `limit` then truncates away the form at the bottom, so the model never sees
  // its target. Scoring lets `limit` cut from the most relevant end instead.
  function relevanceScorer(options) {
    const raw = options.goal
      ?? (Array.isArray(options.keywords) ? options.keywords.join(' ') : options.keywords ?? '');
    const terms = String(raw).toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 2);
    if (terms.length === 0) return null;
    // Only rank-break interactive controls that already matched: awarding the
    // bonus unconditionally would give every button a non-zero score and make
    // relevantOnly keep the whole page.
    return element => {
      const role = semantics.role(element);
      const name = semantics.name(element).toLowerCase();
      const tag = element.tagName.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 6;
        else if (name.includes(term)) score += 4;
        if (role === term) score += 3;
        else if (role.includes(term)) score += 1;
        if (tag === term) score += 1;
      }
      if (score > 0 && INTERACTIVE_ROLES.has(role)) score += 0.5;
      return score;
    };
  }

  function orderedCandidates(options) {
    const elements = [];
    for (const element of semantics.candidates()) {
      if (!matchesScope(element, options)) continue;
      elements.push(element);
    }
    const score = relevanceScorer(options);
    if (!score) return elements;
    let scored = elements.map(element => ({ element, score: score(element) }));
    if (options.relevantOnly) {
      const kept = scored.filter(entry => entry.score > 0);
      // A wording miss must not yield an empty tree: fall back to DOM order.
      if (kept.length > 0) scored = kept;
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(entry => entry.element);
  }

  function snapshot(options = {}) {
    // keepRefs lets an action attach a post-action snapshot without invalidating
    // every ref the caller already holds; a plain browser_snapshot still resets.
    if (!options.keepRefs) refs.reset();
    const limit = Number(options.limit) || 0;
    const elements = [];
    const seenCounts = new Map();
    for (const element of orderedCandidates(options)) {
      const tag = element.tagName.toLowerCase();
      const role = semantics.role(element);
      const name = semantics.name(element);
      // Position among earlier candidates with the same role+name lets a stale
      // ref recover to the right duplicate (e.g. which Likert radio "4") instead
      // of always landing on the first match.
      const index = seenCounts.get(`${role}|${name}`) ?? 0;
      seenCounts.set(`${role}|${name}`, index + 1);
      const item = {
        ref: refs.refFor(element, 'e', { role, name, index }),
        role,
        name,
        visible: true,
        tag
      };
      const isInput = element instanceof windowRef.HTMLInputElement || tag === 'input';
      const isButton = element instanceof windowRef.HTMLButtonElement || tag === 'button';
      if (isInput) {
        item.type = element.type;
        item.required = element.required;
        item.disabled = element.disabled;
        item.checked = element.checked;
        item.value = element.type === 'password' ? '[REDACTED]' : element.value;
      } else if (isButton) item.disabled = element.disabled;
      if (options.boundingBox) item.boundingBox = boundingBox(element);
      elements.push(item);
      if (limit > 0 && elements.length >= limit) break;
    }
    if (options.format === 'compact') {
      // One line per element carries the same data with far fewer tokens than a
      // JSON object array; the model can read `role "name" [ref=eN]` directly.
      const lines = elements.map(item => {
        const pieces = [`- ${item.role} "${item.name}" [ref=${item.ref}]`];
        if (item.value !== undefined && item.value !== '') pieces.push(`value="${item.value}"`);
        return pieces.join(' ');
      });
      return bounded({
        tabId: null,
        url: windowRef.location.href,
        title: documentRef.title,
        revision: refs.revision,
        elementCount: elements.length,
        text: lines.join('\n')
      });
    }
    return bounded({
      tabId: null,
      url: windowRef.location.href,
      title: documentRef.title,
      revision: refs.revision,
      elements
    });
  }

  // Entries keep the element alongside its descriptor so callers can hand out a
  // ref for a specific node (a diff's "added" entries) instead of only naming
  // it. `catalog()` stays descriptor-only for callers that only compare keys.
  function catalogEntries(options = {}) {
    const limit = Number(options.limit) || 400;
    const entries = [];
    for (const element of orderedCandidates(options)) {
      if (entries.length >= limit) break;
      const tag = element.tagName.toLowerCase();
      const item = { role: semantics.role(element), name: semantics.name(element) };
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        item.value = tag === 'input' && element.type === 'password' ? '[REDACTED]' : element.value;
      }
      entries.push({ item, element });
    }
    return entries;
  }

  function catalog(options = {}) {
    return catalogEntries(options).map(entry => entry.item);
  }

  function describePath(element, depth = 4) {
    const parts = [];
    let node = element.parentElement;
    while (node && parts.length < depth) {
      const role = semantics.role(node);
      const name = semantics.name(node);
      parts.unshift(name ? `${role} "${name}"` : role);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // Locate one element on a large page without paying for the whole snapshot.
  // Returns only the matching nodes plus where they sit in the tree, so the
  // model pays for what it asked for instead of the entire document.
  function find(options = {}) {
    const hasText = typeof options.text === 'string' && options.text.trim().length > 0;
    const hasRegex = typeof options.regex === 'string' && options.regex.trim().length > 0;
    if (hasText === hasRegex) {
      throw Object.assign(new Error('Provide exactly one of text or regex.'), { code: 'INVALID_ARGUMENT', retryable: false });
    }
    let matcher;
    if (hasText) {
      const needle = options.text.trim().toLowerCase();
      matcher = hay => hay.includes(needle);
    } else {
      let expression;
      try {
        // No `g` flag: a stateful lastIndex would make .test() skip matches.
        expression = new RegExp(options.regex, options.caseSensitive === true ? '' : 'i');
      } catch (error) {
        throw Object.assign(new Error(`Invalid regex: ${options.regex} (${error?.message ?? ''})`), { code: 'INVALID_ARGUMENT', retryable: false });
      }
      matcher = hay => expression.test(hay);
    }
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));
    const matches = [];
    let total = 0;
    for (const element of orderedCandidates(options)) {
      const role = semantics.role(element);
      const name = semantics.name(element);
      if (!matcher(`${role} ${name}`.toLowerCase())) continue;
      total += 1;
      if (matches.length >= limit) continue;
      matches.push({
        ref: refs.refFor(element, 'e', { role, name, index: 0 }),
        role,
        name,
        path: describePath(element)
      });
    }
    return bounded({
      query: hasText ? { text: options.text } : { regex: options.regex },
      total,
      matches,
      truncated: total > matches.length,
      url: windowRef.location.href,
      title: documentRef.title,
      revision: refs.revision
    });
  }

  function inventory(options = {}) {
    refs.reset();
    const groups = { forms: [], buttons: [], links: [], text: [], headings: [] };
    const filter = options.filter ?? 'all';
    // Same relevance ordering as snapshot, so `goal` shortens this too.
    for (const element of orderedCandidates(options)) {
      const currentRole = semantics.role(element);
      const tag = element.tagName.toLowerCase();
      const isForm = element instanceof windowRef.HTMLFormElement || tag === 'form';
      const category = currentRole === 'textbox' || currentRole === 'combobox' || isForm
        ? 'forms'
        : currentRole === 'button'
          ? 'buttons'
          : currentRole === 'link'
            ? 'links'
            : currentRole === 'heading'
              ? 'headings'
              : 'text';
      if (filter === 'viewport') {
        const rect = element.getBoundingClientRect();
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < windowRef.innerHeight && rect.left < windowRef.innerWidth;
        if (!inViewport) continue;
      }
      if (filter !== 'all' && filter !== 'interactive' && filter !== 'viewport' && filter !== category && !(filter === 'section' && ['headings', 'text'].includes(category))) continue;
      if (filter === 'interactive' && !['forms', 'buttons', 'links'].includes(category)) continue;
      const item = {
        ref: refs.refFor(element, currentRole === 'heading' ? 'h' : currentRole === 'textbox' ? 'f' : 'e'),
        role: currentRole,
        text: semantics.name(element),
        visible: true
      };
      if (options.boundingBox) item.boundingBox = boundingBox(element);
      groups[category].push(item);
    }
    return bounded({
      url: windowRef.location.href,
      title: documentRef.title,
      revision: refs.revision,
      ...groups
    });
  }

  return { snapshot, inventory, catalog, catalogEntries, find };
}
