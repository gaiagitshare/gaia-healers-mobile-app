import { register } from 'node:module';
import fs from 'node:fs';
register(new URL('./loader.mjs', import.meta.url));
const OUT = process.env.AUDIT_OUT;
const FILE = process.env.AUDIT_FILE;
process.on('exit', () => {
  try { fs.appendFileSync(OUT, JSON.stringify({ file: FILE, executed: (globalThis.__asserts || { n: 0 }).n }) + '\n'); } catch {}
});
