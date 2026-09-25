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

      let serialized;
      try {
        serialized = JSON.stringify(results?.[0]?.result ?? null);
      } catch (error) {
        throw evaluationError(`Evaluation result is not serializable: ${error?.message ?? String(error)}`, 'ACTION_TIMEOUT');
      }
      if (serialized.length > maxResultBytes) throw evaluationError('Evaluation result exceeds 1 MB.', 'ACTION_TIMEOUT');
      return JSON.parse(serialized);
    }
  };
}
