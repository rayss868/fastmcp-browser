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
      if (expectedRevision !== revision) {
        throw Object.assign(new Error('Snapshot is outdated.'), { code: 'STALE_REF', retryable: true });
      }
      const element = refs.get(ref);
      if (!element || !element.isConnected) {
        throw Object.assign(new Error('Element not found.'), { code: 'ELEMENT_NOT_FOUND', retryable: true });
      }
      return element;
    },
    clear() {
      refs.clear();
    }
  };
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
