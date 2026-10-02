const SHIM = new URL('./assert-shim.mjs', import.meta.url).href;
const NAMES = ['node:assert/strict', 'assert/strict', 'node:assert', 'assert'];
export async function resolve(specifier, context, next) {
  // The shim imports the real assert, so it must not be redirected to itself.
  if (NAMES.includes(specifier) && context.parentURL !== SHIM) {
    return { url: SHIM, shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}
