import { browserApi } from './compatibility.js';
import { createFirefoxAdapter } from './runtime.js';

export function createAdapter(api = browserApi()) {
  return createFirefoxAdapter(api);
}
