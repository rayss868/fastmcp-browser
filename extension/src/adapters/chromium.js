import { browserApi } from './compatibility.js';
import { createChromiumAdapter } from './runtime.js';

export function createAdapter(api = browserApi()) {
  return createChromiumAdapter(api);
}
