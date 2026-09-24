function runPageScript(api, tabId, mode, value) {
  return api.scripting.executeScript({
    target: { tabId },
    func: async (action, position) => {
      if (action === 'measure') {
        return {
          pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
          viewportHeight: window.innerHeight,
          scrollY: window.scrollY,
          dpr: window.devicePixelRatio || 1,
          viewportWidth: window.innerWidth
        };
      }
      window.scrollTo(0, position);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.scrollY;
    },
    args: [mode, value]
  }).then(results => results?.[0]?.result);
}

async function decodeImage(dataUrl) {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export async function captureFullPage(api, tabId) {
  const target = await api.tabs.get(tabId);
  const [previousActive] = await api.tabs.query({ active: true, windowId: target.windowId });
  await api.tabs.update(tabId, { active: true });
  let originalScrollY;
  try {
    const dimensions = await runPageScript(api, tabId, 'measure');
    originalScrollY = dimensions.scrollY;
    const width = dimensions.viewportWidth;
    const scale = dimensions.dpr;
    const maxCanvasDimension = 32767;
    const scaleFactor = Math.min(1, maxCanvasDimension / (width * scale), maxCanvasDimension / (dimensions.pageHeight * scale));
    const canvas = new OffscreenCanvas(Math.ceil(width * scale * scaleFactor), Math.ceil(dimensions.pageHeight * scale * scaleFactor));
    const context = canvas.getContext('2d');
    for (let top = 0; top < dimensions.pageHeight;) {
      const actualTop = await runPageScript(api, tabId, 'scroll', top);
      const image = await decodeImage(await api.tabs.captureVisibleTab(target.windowId, { format: 'png' }));
      const sourceTop = top - actualTop;
      const visibleHeight = Math.min(dimensions.viewportHeight - sourceTop, dimensions.pageHeight - top);
      context.drawImage(image, 0, Math.round(sourceTop * scale), image.width, Math.round(visibleHeight * scale), 0, Math.round(top * scale * scaleFactor), canvas.width, Math.round(visibleHeight * scale * scaleFactor));
      image.close();
      top += visibleHeight;
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { dataUrl: await toDataUrl(blob), width: canvas.width, height: canvas.height, scrollY: originalScrollY };
  } finally {
    if (originalScrollY !== undefined) await runPageScript(api, tabId, 'scroll', originalScrollY);
    if (previousActive && previousActive.id !== tabId) await api.tabs.update(previousActive.id, { active: true });
  }
}
