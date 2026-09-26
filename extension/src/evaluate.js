const MAX_EXPRESSION_LENGTH = 10000;
const MAX_RESULT_BYTES = 1000000;
const REF_ATTRIBUTE = 'data-fastmcp-eval-ref';

function evaluationError(message, code = 'INVALID_ARGUMENT', retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

export function createPageEvaluator({ scripting, inject, attribute = REF_ATTRIBUTE, maxResultBytes = MAX_RESULT_BYTES } = {}) {
  async function refToken(tabId, ref, revision) {
    await inject(tabId);
    let results;
    try {
      results = await scripting.executeScript({
        target: { tabId },
        func: (refArg, revisionArg, attr) => {
          try {
            const engine = globalThis.__fastMcp;
            if (!engine) return { ok: false, error: { code: 'TAB_NOT_ACCESSIBLE', message: 'Page engine unavailable' } };
            const element = engine.resolve(refArg, revisionArg);
            const token = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
            element.setAttribute(attr, token);
            return { ok: true, token };
          } catch (error) {
            return { ok: false, error: { code: error?.code ?? 'INVALID_ARGUMENT', message: error?.message ?? String(error) } };
          }
        },
        args: [ref, revision ?? null, attribute]
      });
    } catch (error) {
      throw evaluationError(`Evaluation failed: ${error?.message ?? String(error)}`);
    }
    const outcome = results?.[0]?.result;
    if (!outcome?.ok) {
      const code = outcome?.error?.code ?? 'TAB_NOT_ACCESSIBLE';
      throw evaluationError(outcome?.error?.message ?? 'Unable to resolve the requested ref.', code, code === 'STALE_REF' || code === 'ELEMENT_NOT_FOUND');
    }
    return outcome.token;
  }

  function serialize(value) {
    let serialized;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch (error) {
      throw evaluationError(`Result is not serializable: ${error?.message ?? String(error)}`, 'ACTION_TIMEOUT');
    }
    if (serialized.length > maxResultBytes) throw evaluationError('Result exceeds 1 MB.', 'ACTION_TIMEOUT');
    return JSON.parse(serialized);
  }

  return {
    async evaluate(params = {}) {
      const tabId = Number(params?.tabId);
      if (!Number.isInteger(tabId)) throw evaluationError('tabId is required for browser_evaluate.');
      const expression = String(params?.expression ?? '').trim();
      if (!expression || expression.length > MAX_EXPRESSION_LENGTH) throw evaluationError('Expression must contain 1-10000 characters.');

      const ref = typeof params?.ref === 'string' && params.ref ? params.ref : null;
      // The ref store lives in the isolated world next to the content engine,
      // but eval only works in the page MAIN world, so the resolved element is
      // handed across worlds through a temporary DOM attribute.
      const token = ref ? await refToken(tabId, ref, params?.revision) : null;

      let results;
      try {
        results = await scripting.executeScript({
          target: { tabId },
          // MAIN world: extension CSP forbids unsafe-eval in the isolated world,
          // so eval/Function only work under the target page's CSP here.
          world: 'MAIN',
          func: (expr, attr, tokenArg, bindElement) => {
            const element = bindElement && tokenArg ? document.querySelector(`[${attr}="${tokenArg}"]`) : null;
            try {
              const evaluated = eval(expr);
              return bindElement && typeof evaluated === 'function' ? evaluated(element) : evaluated;
            } finally {
              if (element) element.removeAttribute(attr);
            }
          },
          args: [expression, attribute, token, Boolean(ref)]
        });
      } catch (error) {
        throw evaluationError(`Evaluation failed: ${error?.message ?? String(error)}`);
      }

      return serialize(results?.[0]?.result ?? null);
    },

    async inspect(params = {}) {
      const tabId = Number(params?.tabId);
      if (!Number.isInteger(tabId)) throw evaluationError('tabId is required for browser_inspect.');
      const ref = typeof params?.ref === 'string' && params.ref ? params.ref : null;
      const token = ref ? await refToken(tabId, ref, params?.revision) : null;

      let results;
      try {
        results = await scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (attr, tokenArg, bindElement, pathArg) => {
            const element = bindElement && tokenArg ? document.querySelector(`[${attr}="${tokenArg}"]`) : null;
            try {
              if (!element) return { ok: false, error: 'No element bound; pass a ref.' };
              const summary = { ok: true, tag: element.tagName ? element.tagName.toLowerCase() : null };
              const keys = Object.keys(element);
              const fiberKey = keys.find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
              const propsKey = keys.find(key => key.startsWith('__reactProps$'));
              if (fiberKey) {
                summary.framework = 'react';
                const components = [];
                let node = element[fiberKey];
                for (let depth = 0; node && depth < 30; depth += 1) {
                  const type = node.type;
                  const label = typeof type === 'function'
                    ? (type.displayName || type.name)
                    : (type && typeof type === 'object' ? (type.displayName || type.name) : null);
                  if (label) components.push(label);
                  node = node.return;
                }
                summary.components = [...new Set(components)].slice(0, 10);
              }
              if (propsKey) summary.props = element[propsKey];
              if (keys.some(key => key.startsWith('__vueParentComponent'))) summary.framework = 'vue';
              if (keys.some(key => key.startsWith('__ngContext__'))) summary.framework = 'angular';
              if (pathArg) {
                let value = element;
                for (const segment of String(pathArg).split('.').filter(Boolean)) {
                  value = value == null ? undefined : value[segment];
                }
                summary.value = value;
              }
              return summary;
            } finally {
              if (element) element.removeAttribute(attr);
            }
          },
          args: [attribute, token, Boolean(ref), params?.path ?? null]
        });
      } catch (error) {
        throw evaluationError(`Inspection failed: ${error?.message ?? String(error)}`);
      }
      return serialize(results?.[0]?.result ?? null);
    }
  };
}
