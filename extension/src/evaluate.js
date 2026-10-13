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
          // MAIN world: the extension CSP forbids unsafe-eval in the isolated
          // world, so eval only works when the *page's* CSP allows it. A strict
          // page policy (nonce + strict-dynamic, no 'unsafe-eval') makes every eval
          // call throw, and executeScript then resolves with result: undefined --
          // indistinguishable from an expression that genuinely returned null.
          // Probe first so the caller gets an actionable error instead of a null.
          world: 'MAIN',
          func: (expr, attr, tokenArg, bindElement) => {
            const element = bindElement && tokenArg ? document.querySelector(`[${attr}="${tokenArg}"]`) : null;
            try {
              try {
                eval('0');
              } catch (error) {
                return { __fastmcpEvalBlocked: true, message: String(error?.message ?? error) };
              }
              let evaluated;
              try {
                evaluated = eval(expr);
              } catch (error) {
                return { __fastmcpEvalThrew: true, message: String(error?.message ?? error) };
              }
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

      const outcome = results?.[0]?.result;
      if (outcome && typeof outcome === 'object' && outcome.__fastmcpEvalBlocked) {
        throw evaluationError(
          `The page's Content-Security-Policy blocks eval, so browser_evaluate cannot run here (${outcome.message}). On CSP-restricted pages use browser_inspect with a selector to read DOM state.`,
          'UNSUPPORTED_CAPABILITY'
        );
      }
      if (outcome && typeof outcome === 'object' && outcome.__fastmcpEvalThrew) {
        throw evaluationError(`Expression threw: ${outcome.message}`);
      }
      return serialize(outcome ?? null);
    },

    async inspect(params = {}) {
      const tabId = Number(params?.tabId);
      if (!Number.isInteger(tabId)) throw evaluationError('tabId is required for browser_inspect.');
      const ref = typeof params?.ref === 'string' && params.ref ? params.ref : null;
      const selector = typeof params?.selector === 'string' && params.selector.trim() ? params.selector.trim() : null;
      if (!ref && !selector) throw evaluationError('browser_inspect needs a ref or a selector.');
      const token = ref ? await refToken(tabId, ref, params?.revision) : null;

      let results;
      try {
        results = await scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          // A selector skips the ref store entirely, so browser_inspect stays usable
          // on pages whose DOM churns or whose CSP forbids eval -- the two cases that
          // together made every ref-based read on such pages fail.
          func: (attr, tokenArg, bindElement, pathArg, selectorArg) => {
            const element = bindElement && tokenArg
              ? document.querySelector(`[${attr}="${tokenArg}"]`)
              : (selectorArg ? document.querySelector(selectorArg) : null);
            try {
              if (!element) return { ok: false, error: selectorArg ? 'No element matches the selector.' : 'No element bound; pass a ref or selector.' };
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
          args: [attribute, token, Boolean(ref), params?.path ?? null, selector]
        });
      } catch (error) {
        throw evaluationError(`Inspection failed: ${error?.message ?? String(error)}`);
      }
      return serialize(results?.[0]?.result ?? null);
    }
  };
}
