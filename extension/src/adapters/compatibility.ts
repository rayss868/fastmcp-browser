export function browserApi(): typeof chrome {
  return globalThis.chrome;
}

export function callApi<T>(call: (callback: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try { call(resolve); } catch (error) { reject(error); }
  });
}
