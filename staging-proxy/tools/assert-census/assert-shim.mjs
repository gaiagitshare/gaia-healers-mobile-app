/** node:assert/strict, but every call is counted. */
import real from 'node:assert/strict';
globalThis.__asserts = globalThis.__asserts || { n: 0 };
const bump = (fn) => function (...args) { globalThis.__asserts.n += 1; return fn.apply(this, args); };
const wrapped = bump(real);
for (const key of Object.getOwnPropertyNames(real)) {
  const v = real[key];
  try { wrapped[key] = typeof v === 'function' ? bump(v.bind(real)) : v; } catch { /* readonly */ }
}
export default wrapped;
export const { strict } = { strict: wrapped };
