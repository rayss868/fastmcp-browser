// Pure diff/refresh policy for post-action reporting. Kept out of engine.js so
// it can be unit-tested without a DOM: engine.js runs DOM work at import time.

export const AUTO_REFRESH_CHURN = 12;

export function catalogKey(item) {
  return `${item.role}|${item.name}`;
}

function asItem(entry) {
  return entry && entry.item ? entry.item : entry;
}

// `after` is a list of { item, element } entries so every added/changed key can
// be turned into a usable ref. Reporting `button "Checkout" appeared` without a
// ref was useless: the model knew something changed but had to re-snapshot
// before it could click it — that round-trip is the complaint we are fixing.
// `before` may be plain items (it never needs refs) or entries.
export function computeDiff(before, after, refs) {
  const beforeItems = before.map(asItem);
  const afterEntries = after.map(entry => (entry && entry.item ? entry : { item: entry, element: null }));
  const afterItems = afterEntries.map(entry => entry.item);

  const beforeCounts = new Map();
  for (const item of beforeItems) beforeCounts.set(catalogKey(item), (beforeCounts.get(catalogKey(item)) ?? 0) + 1);
  const afterCounts = new Map();
  const elementByKey = new Map();
  for (const item of afterItems) afterCounts.set(catalogKey(item), (afterCounts.get(catalogKey(item)) ?? 0) + 1);
  for (const entry of afterEntries) {
    if (!entry.element) continue;
    const key = catalogKey(entry.item);
    if (!elementByKey.has(key)) elementByKey.set(key, entry.element);
  }

  // Keys are `role|name` and the name itself may contain `|`, so split once.
  const describe = key => {
    const separator = key.indexOf('|');
    const role = separator === -1 ? key : key.slice(0, separator);
    const name = separator === -1 ? '' : key.slice(separator + 1);
    const element = elementByKey.get(key);
    if (!element) return { role, name };
    return { ref: refs.refFor(element, 'e', { role, name, index: 0 }), role, name };
  };

  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, count] of afterCounts) {
    if (count > (beforeCounts.get(key) ?? 0)) added.push(describe(key));
  }
  for (const [key, count] of beforeCounts) {
    if (count > (afterCounts.get(key) ?? 0)) removed.push(describe(key));
  }

  const previousValues = new Map(beforeItems.map(item => [catalogKey(item), item.value]));
  const seen = new Set();
  for (const item of afterItems) {
    const key = catalogKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (previousValues.has(key) && previousValues.get(key) !== item.value) {
      changed.push({ ...describe(key), from: previousValues.get(key), to: item.value });
    }
  }

  const capped = list => list.slice(0, 20);
  return { added: capped(added), removed: capped(removed), changed: capped(changed) };
}

// How much page state should ride back with an action. The diff alone is enough
// while the page held still and the acted-on element is still there; anything
// else means the model is now looking at a page it has never seen.
export function shouldRefresh({ mode = 'auto', navigated = false, targetGone = false, churn = 0 } = {}) {
  if (mode === 'snapshot') return true;
  if (mode === 'none') return false;
  if (mode !== 'auto') throw Object.assign(new Error(`Unsupported refresh mode: ${mode}`), { code: 'INVALID_ARGUMENT' });
  return navigated || targetGone || churn >= AUTO_REFRESH_CHURN;
}
