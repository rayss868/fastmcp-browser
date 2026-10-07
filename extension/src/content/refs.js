export function createReferenceStore() {
  const refs = new Map();
  const descriptors = new Map();
  let revision = 1;

  return {
    get revision() {
      return revision;
    },
    reset() {
      refs.clear();
      revision += 1;
      return revision;
    },
    refFor(element, prefix = 'e', descriptor) {
      for (const [ref, target] of refs) {
        if (target === element) return ref;
      }
      const ref = `${prefix}${refs.size + 1}`;
      refs.set(ref, element);
      if (descriptor) descriptors.set(ref, descriptor);
      return ref;
    },
    descriptorFor(ref) {
      return descriptors.get(ref);
    },
    resolve(ref, expectedRevision) {
      const element = refs.get(ref);
      // Refs are keyed by element identity, so a connected element is still the
      // exact node the caller saw. A page with a live timer (promo countdown,
      // carousel) mutates every second and the revision drifts even though nothing
      // moved, so the revision is only reported once the node is actually gone.
      if (element && element.isConnected) return element;
      if (expectedRevision !== revision) {
        throw Object.assign(new Error('Snapshot is outdated.'), { code: 'STALE_REF', retryable: true });
      }
      throw Object.assign(new Error('Element not found.'), { code: 'ELEMENT_NOT_FOUND', retryable: true });
    },
    clear() {
      refs.clear();
    }
  };
}

export function recoverRef(candidates, roleOf, nameOf, descriptor) {
  if (!descriptor) return null;
  const matches = [];
  for (const element of candidates) {
    if (roleOf(element) === descriptor.role && nameOf(element) === descriptor.name) matches.push(element);
  }
  if (matches.length === 1) return matches[0];
  // Duplicates (Google Forms Likert radios all named "4"): without a stored
  // index any pick is a guess — clicking the first one silently acted on the
  // wrong question, so refuse instead of mis-clicking. Callers then surface
  // ELEMENT_NOT_FOUND and a fresh snapshot exposes the new refs.
  if (matches.length > 1) return descriptor.index != null ? (matches[descriptor.index] ?? null) : null;
  return null;
}

export function boundingBox(element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}
