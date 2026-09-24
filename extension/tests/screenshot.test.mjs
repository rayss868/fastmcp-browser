import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFullPage } from '../src/screenshot.js';

function createEnvironment({ pageHeight = 180, viewportHeight = 100 } = {}) {
  const calls = [];
  const api = {
    tabs: {
      get: async tabId => ({ id: tabId, windowId: 2 }),
      query: async query => {
        calls.push(['query', query]);
        return [{ id: 5, windowId: 2, active: true }];
      },
      update: async (tabId, properties) => calls.push(['update', tabId, properties]),
      captureVisibleTab: async (windowId, options) => {
        calls.push(['capture', windowId, options]);
        return `data:image/png;base64,frame${calls.filter(([name]) => name === 'capture').length}`;
      }
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        calls.push(['script', args]);
        if (args?.[0] === 'measure') return [{ result: { pageHeight, viewportHeight, viewportWidth: 100, scrollY: 17, dpr: 1 } }];
        if (args?.[0] === 'scroll') return [{ result: Math.min(args[1], pageHeight - viewportHeight) }];
        return [{ result: undefined }];
      }
    }
  };
  return { api, calls };
}

test('full-page capture stitches viewport images and restores the original scroll position', async () => {
  const { api, calls } = createEnvironment();
  const previousCanvas = globalThis.OffscreenCanvas;
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; this.context = { drawImage: (...args) => calls.push(['drawImage', ...args.slice(1)]) }; }
    getContext() { return this.context; }
    convertToBlob() { return Promise.resolve(new Blob(['png'], { type: 'image/png' })); }
  }
  globalThis.OffscreenCanvas = Canvas;
  globalThis.createImageBitmap = async blob => ({ width: 100, height: 100, blob, close() {} });
  try {
    const result = await captureFullPage(api, 8);
    assert.equal(result.width, 100);
    assert.equal(result.height, 180);
    assert.equal(result.scrollY, 17);
    assert.equal(calls.filter(([name]) => name === 'capture').length, 2);
    assert.deepEqual(calls.filter(([name, args]) => name === 'script' && args[0] === 'scroll').map(([, args]) => args[1]), [0, 100, 17]);
    assert.match(result.dataUrl, /^data:image\/png;base64,/);
  } finally {
    globalThis.OffscreenCanvas = previousCanvas;
    globalThis.createImageBitmap = previousCreateImageBitmap;
  }
});
