const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie']);
const MAX_BODY_BYTES = 8192;
const MAX_RESPONSE_BYTES = 65536;

function sanitizeHeaders(headers) {
  return headers.filter(header => !SENSITIVE_HEADERS.has(header.name.toLowerCase()));
}

function serializeRequestBody(requestBody) {
  if (requestBody.formData) return JSON.stringify(requestBody.formData).slice(0, MAX_BODY_BYTES);
  if (!requestBody.raw) return undefined;
  let remaining = MAX_BODY_BYTES;
  const parts = [];
  for (const part of requestBody.raw) {
    if (!part.bytes) {
      parts.push(part.file ? { file: true } : null);
      continue;
    }
    const bytes = new Uint8Array(part.bytes).subarray(0, remaining);
    parts.push(Array.from(bytes));
    remaining -= bytes.length;
    if (remaining <= 0) break;
  }
  return parts;
}

export function createNetworkMonitor(webRequest, maxPerTab = 200, options = {}) {
  const requests = new Map();
  const pending = new Map();

  webRequest?.onBeforeRequest?.addListener(details => {
    if (details.tabId < 0) return;
    const entry = {
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      type: details.type,
      startedAt: details.timeStamp,
      statusCode: null,
      durationMs: null,
      requestBody: details.requestBody ? serializeRequestBody(details.requestBody) : undefined
    };
    if (options.filterResponseData && details.tabId >= 0) {
      const filter = options.filterResponseData(details.requestId);
      let remaining = MAX_RESPONSE_BYTES;
      const chunks = [];
      let captureResponse = false;
      filter.ondata = event => {
        const bytes = new Uint8Array(event.data);
        if (captureResponse && remaining > 0) {
          const captured = bytes.subarray(0, remaining);
          if (captured.length) chunks.push(captured);
          remaining -= captured.length;
        }
        filter.write(event.data);
      };
      filter.onstop = () => {
        if (captureResponse && chunks.length) {
          const body = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
          entry.responseBody = new TextDecoder().decode(body);
        }
        filter.disconnect();
      };
      filter.onerror = () => filter.disconnect();
      entry.filterResponse = contentType => {
        captureResponse = /^(text\/|application\/(json|.+\+json|xml|.+\+xml|javascript|x-www-form-urlencoded))/i.test(contentType);
      };
    }
    let tabRequests = requests.get(details.tabId);
    if (!tabRequests) requests.set(details.tabId, tabRequests = []);
    tabRequests.push(entry);
    if (tabRequests.length > maxPerTab) {
      const removed = tabRequests.splice(0, tabRequests.length - maxPerTab);
      for (const oldEntry of removed) {
        for (const [requestId, pendingEntry] of pending) {
          if (pendingEntry === oldEntry) pending.delete(requestId);
        }
      }
    }
    pending.set(details.requestId, entry);
  }, { urls: ['<all_urls>'] }, ['requestBody']);

  webRequest?.onBeforeSendHeaders?.addListener(details => {
    const entry = pending.get(details.requestId);
    if (entry) entry.requestHeaders = sanitizeHeaders(details.requestHeaders ?? []);
  }, { urls: ['<all_urls>'] }, ['requestHeaders']);

  webRequest?.onHeadersReceived?.addListener(details => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.responseHeaders = sanitizeHeaders(details.responseHeaders ?? []);
    const contentType = (details.responseHeaders ?? []).find(header => header.name.toLowerCase() === 'content-type')?.value ?? '';
    entry.filterResponse?.(contentType);
  }, { urls: ['<all_urls>'] }, ['responseHeaders']);

  webRequest?.onBeforeRedirect?.addListener(details => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.statusCode = details.statusCode;
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAt));
    entry.redirectUrl = details.redirectUrl;
    pending.delete(details.requestId);
  }, { urls: ['<all_urls>'] });

  webRequest?.onCompleted?.addListener(details => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.statusCode = details.statusCode;
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAt));
    pending.delete(details.requestId);
  }, { urls: ['<all_urls>'] });

  webRequest?.onErrorOccurred?.addListener(details => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.error = details.error;
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAt));
    pending.delete(details.requestId);
  }, { urls: ['<all_urls>'] });

  return {
    get(tabId, limit = 50) {
      const tabRequests = requests.get(tabId) ?? [];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, maxPerTab));
      return tabRequests.slice(-safeLimit).map(entry => ({
        requestId: entry.requestId,
        url: entry.url,
        method: entry.method,
        type: entry.type,
        startedAt: entry.startedAt,
        statusCode: entry.statusCode,
        durationMs: entry.durationMs,
        ...(entry.redirectUrl ? { redirectUrl: entry.redirectUrl } : {}),
        ...(entry.requestHeaders ? { requestHeaders: entry.requestHeaders } : {}),
        ...(entry.responseHeaders ? { responseHeaders: entry.responseHeaders } : {}),
        ...(entry.responseBody !== undefined ? { responseBody: entry.responseBody } : {}),
        ...(entry.requestBody ? { requestBody: entry.requestBody } : {}),
        ...(entry.error ? { error: entry.error } : {})
      }));
    },
    clearTab(tabId) {
      requests.delete(tabId);
      for (const [requestId, entry] of pending) {
        if (entry.tabId === tabId) pending.delete(requestId);
      }
    }
  };
}
