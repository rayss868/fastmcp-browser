import assert from 'node:assert/strict';
import test from 'node:test';
import { createNetworkMonitor } from '../src/network-monitor.js';

function createEvents() {
  const listeners = new Set();
  const registrations = [];
  return {
    registrations,
    addListener(listener, filter, extraInfoSpec) { listeners.add(listener); registrations.push({ filter, extraInfoSpec }); },
    fire(details) { for (const listener of listeners) listener(details); }
  };
}

function createWebRequest() {
  return {
    onBeforeRequest: createEvents(),
    onBeforeSendHeaders: createEvents(),
    onSendHeaders: createEvents(),
    onAuthRequired: createEvents(),
    onHeadersReceived: createEvents(),
    onCompleted: createEvents(),
    onErrorOccurred: createEvents(),
    onBeforeRedirect: createEvents()
  };
}

test('network monitor stores request start and completion details per tab', () => {
  const webRequest = createWebRequest();
  const monitor = createNetworkMonitor(webRequest, 2);
  webRequest.onBeforeRequest.fire({ requestId: 'a', tabId: 7, url: 'https://example.com/api', method: 'GET', type: 'xmlhttprequest', timeStamp: 1000 });
  webRequest.onCompleted.fire({ requestId: 'a', tabId: 7, statusCode: 204, timeStamp: 1045 });

  assert.deepEqual(monitor.get(7), [{ requestId: 'a', url: 'https://example.com/api', method: 'GET', type: 'xmlhttprequest', startedAt: 1000, statusCode: 204, durationMs: 45 }]);
  assert.deepEqual(monitor.get(8), []);
});

test('network monitor requests upload body and header observation from the browser API', () => {
  const webRequest = createWebRequest();
  createNetworkMonitor(webRequest);

  assert.deepEqual(webRequest.onBeforeRequest.registrations[0].extraInfoSpec, ['requestBody']);
  assert.deepEqual(webRequest.onBeforeSendHeaders.registrations[0].extraInfoSpec, ['requestHeaders']);
  assert.deepEqual(webRequest.onHeadersReceived.registrations[0].extraInfoSpec, ['responseHeaders']);
});

test('network monitor captures request and response headers plus upload body metadata', () => {
  const webRequest = createWebRequest();
  const monitor = createNetworkMonitor(webRequest);
  webRequest.onBeforeRequest.fire({ requestId: 'headers', tabId: 7, url: 'https://example.com/api', method: 'POST', type: 'xmlhttprequest', timeStamp: 10, requestBody: { raw: [{ bytes: new Uint8Array([123, 125]).buffer }] } });
  webRequest.onBeforeSendHeaders.fire({ requestId: 'headers', tabId: 7, requestHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cookie', value: 'session=abc' }] });
  webRequest.onHeadersReceived.fire({ requestId: 'headers', tabId: 7, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Set-Cookie', value: 'session=abc' }] });
  webRequest.onCompleted.fire({ requestId: 'headers', tabId: 7, statusCode: 201, timeStamp: 15 });

  assert.deepEqual(monitor.get(7), [{ requestId: 'headers', url: 'https://example.com/api', method: 'POST', type: 'xmlhttprequest', startedAt: 10, statusCode: 201, durationMs: 5, requestHeaders: [{ name: 'Content-Type', value: 'application/json' }], responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], requestBody: [[123, 125]] }]);
  assert.equal(monitor.get(7)[0].requestHeaders.some(header => header.name.toLowerCase() === 'cookie'), false);
  assert.equal(monitor.get(7)[0].responseHeaders.some(header => header.name.toLowerCase() === 'set-cookie'), false);
});

test('network monitor captures text response without Content-Length', () => {
  const webRequest = createWebRequest();
  const filterResponseData = () => {
    filterResponseData.lastFilter = { write() {}, disconnect() {}, close() {}, ondata: null, onstop: null };
    return filterResponseData.lastFilter;
  };
  const monitor = createNetworkMonitor(webRequest, 200, { filterResponseData });
  webRequest.onBeforeRequest.fire({ requestId: 'chunked', tabId: 7, url: 'https://example.com/api', method: 'GET', type: 'xmlhttprequest', timeStamp: 10 });
  webRequest.onHeadersReceived.fire({ requestId: 'chunked', tabId: 7, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }] });
  const filter = filterResponseData.lastFilter;
  filter.ondata({ data: new TextEncoder().encode('chunked response').buffer });
  filter.onstop();

  assert.equal(monitor.get(7)[0].responseBody, 'chunked response');
});

test('network monitor installs Firefox response filter during onBeforeRequest', () => {
  const webRequest = createWebRequest();
  const filterResponseData = () => {
    filterResponseData.lastFilter = { write() {}, disconnect() {}, close() {}, ondata: null, onstop: null };
    return filterResponseData.lastFilter;
  };
  createNetworkMonitor(webRequest, 200, { filterResponseData });
  webRequest.onBeforeRequest.fire({ requestId: 'body', tabId: 7, url: 'https://example.com/api', method: 'GET', type: 'xmlhttprequest', timeStamp: 10 });

  assert.equal(typeof filterResponseData.lastFilter?.ondata, 'function');
});

test('network monitor passes through the entire response while capturing at most 64 KB', () => {
  const webRequest = createWebRequest();
  const filterResponseData = () => {
    filterResponseData.lastFilter = {
      output: [],
      write(data) { this.output.push(new Uint8Array(data)); },
      disconnect() {},
      close() {},
      ondata: null,
      onstop: null
    };
    return filterResponseData.lastFilter;
  };
  const monitor = createNetworkMonitor(webRequest, 200, { filterResponseData });
  webRequest.onBeforeRequest.fire({ requestId: 'body', tabId: 7, url: 'https://example.com/api', method: 'GET', type: 'xmlhttprequest', timeStamp: 10 });
  webRequest.onHeadersReceived.fire({ requestId: 'body', tabId: 7, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
  const filter = filterResponseData.lastFilter;
  const first = new TextEncoder().encode('{"ok":true}');
  const second = new Uint8Array(70000).fill(97);
  filter.ondata({ data: first.buffer });
  filter.ondata({ data: second.buffer });
  filter.onstop();

  const passedThrough = new Uint8Array(filter.output.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of filter.output) { passedThrough.set(chunk, offset); offset += chunk.length; }
  assert.deepEqual(passedThrough, new Uint8Array([...first, ...second]));
  assert.equal(new TextEncoder().encode(monitor.get(7)[0].responseBody).length, 65536);
});

test('network monitor finalizes redirect hops before recording the next URL', () => {
  const webRequest = createWebRequest();
  const monitor = createNetworkMonitor(webRequest, 2);
  webRequest.onBeforeRequest.fire({ requestId: 'redirect', tabId: 7, url: 'http://example.com', method: 'GET', type: 'main_frame', timeStamp: 10 });
  webRequest.onBeforeRedirect.fire({ requestId: 'redirect', tabId: 7, statusCode: 302, redirectUrl: 'https://example.com', timeStamp: 20 });
  webRequest.onBeforeRequest.fire({ requestId: 'redirect', tabId: 7, url: 'https://example.com', method: 'GET', type: 'main_frame', timeStamp: 25 });
  webRequest.onCompleted.fire({ requestId: 'redirect', tabId: 7, statusCode: 200, timeStamp: 40 });

  assert.deepEqual(monitor.get(7), [
    { requestId: 'redirect', url: 'http://example.com', method: 'GET', type: 'main_frame', startedAt: 10, statusCode: 302, durationMs: 10, redirectUrl: 'https://example.com' },
    { requestId: 'redirect', url: 'https://example.com', method: 'GET', type: 'main_frame', startedAt: 25, statusCode: 200, durationMs: 15 }
  ]);
});

test('network monitor truncates form data to the 8 KB limit', () => {
  const webRequest = createWebRequest();
  const monitor = createNetworkMonitor(webRequest);
  const formData = { field: ['x'.repeat(9000)] };
  webRequest.onBeforeRequest.fire({ requestId: 'form', tabId: 7, url: 'https://example.com/api', method: 'POST', type: 'xmlhttprequest', timeStamp: 10, requestBody: { formData } });

  assert.equal(monitor.get(7)[0].requestBody.length, 8192);
});

test('network monitor bounds each tab buffer and reports failed requests', () => {
  const webRequest = createWebRequest();
  const monitor = createNetworkMonitor(webRequest, 2);
  for (let index = 0; index < 3; index++) {
    webRequest.onBeforeRequest.fire({ requestId: String(index), tabId: 7, url: `https://example.com/${index}`, method: 'GET', type: 'image', timeStamp: index * 10 });
  }
  webRequest.onErrorOccurred.fire({ requestId: '2', tabId: 7, error: 'net::ERR_FAILED', timeStamp: 35 });

  assert.deepEqual(monitor.get(7), [
    { requestId: '1', url: 'https://example.com/1', method: 'GET', type: 'image', startedAt: 10, statusCode: null, durationMs: null },
    { requestId: '2', url: 'https://example.com/2', method: 'GET', type: 'image', startedAt: 20, statusCode: null, durationMs: 15, error: 'net::ERR_FAILED' }
  ]);
});
