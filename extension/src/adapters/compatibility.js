export function browserApi() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api) throw new Error('WebExtension API is unavailable.');
  return api;
}

export function callApi(call) {
  return new Promise((resolve, reject) => {
    try {
      const result = call();
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
        return;
      }
      resolve(result);
    } catch (error) {
      reject(error);
    }
  });
}

export function callbackApi(call) {
  return new Promise((resolve, reject) => {
    try {
      call(value => {
        const error = browserApi().runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function invoke(method, ...args) {
  return callApi(() => method(...args));
}
