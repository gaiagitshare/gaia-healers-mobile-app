/**
 * DOCUMENTATION MUST NOT HAND SOMEBODY A PAID COMMAND BY ACCIDENT.
 *
 * docs/STAGING-PROXY.md once offered, under "smoke tests", a curl that posts a
 * prompt to /api/assist/chat -- a real, billed model call -- next to the free
 * health check, with nothing to tell them apart. A future developer or agent
 * copy-pasting a smoke test should not be able to generate paid usage without
 * seeing the words PAID LIVE TEST — OWNER APPROVAL REQUIRED first.
 *
 * This scans every Markdown file in the repository for runnable lines that
 * would reach a model, and requires the label within the twelve lines above.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRoots } from './_app-present.js';

const LABEL = /PAID LIVE TEST\s*[—-]+\s*OWNER APPROVAL REQUIRED/;

// A runnable line that would send a prompt or open a model session.
const PAID_ENDPOINT = /api\/assist\/(chat(\/stream)?|voice|tts|transcribe|tool)\b/;
const PAID_SCRIPT = /(assist-quality-probe|assist-guidance-probe|voice-latency-probe|determinism-harness|assist-health|assist-live-check)\.mjs/;
const RUNNABLE = /^\s*(\$ )?(curl|node|npm|npx|bash|sh|wget|http)\b|^\s*-d\s|^\s*--data/;

function markdownFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.git') || e.name === 'output') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(md|markdown|txt)$/i.test(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** Is this runnable line a provider call that is safe by construction? */
function safeByConstruction(line) {
  // An empty prompt is rejected before any provider is called; a dry-run sends
  // nothing; the lookup route reads local catalogues; the token route only
  // issues a ticket; the report tool is offline.
  return /"prompt":""/.test(line) || /--dry-run/.test(line) || /api\/assist\/lookup\b/.test(line)
    || /api\/assist\/voice\/token\b/.test(line) || /assist-usage-report\.mjs/.test(line) || /--only\b/.test(line) && /--dry-run/.test(line);
}

test('no documentation offers a billed model call without the owner-approval label above it', () => {
  const roots = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), ...appRoots()];
  const seen = new Set();
  const offenders = [];
  for (const root of roots) {
    for (const file of markdownFiles(root)) {
      const real = fs.realpathSync(file);
      if (seen.has(real)) continue;
      seen.add(real);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let inFence = false;
      lines.forEach((line, i) => {
        if (/^\s*```/.test(line)) inFence = !inFence;
        // A route LISTING ("POST {proxy}/api/assist/chat") is reference, not a
        // command; only a runnable shape counts, in a fence or in backticks.
        const runnable = RUNNABLE.test(line) || /`[^`]*\b(curl|node|npm|npx)\b [^`]*`/.test(line);
        const paid = (PAID_ENDPOINT.test(line) || PAID_SCRIPT.test(line)) && runnable;
        if (!paid || safeByConstruction(line)) return;
        // A curl whose -d/--data is on a LATER line: the endpoint line is still the one that bills.
        const context = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
        if (!LABEL.test(context)) offenders.push(`${path.relative(root, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
  }
  assert.deepEqual(offenders, [],
    'these documented commands would call a paid model and are not labelled "PAID LIVE TEST — OWNER APPROVAL REQUIRED" within the 12 lines above:\n  '
    + offenders.join('\n  '));
});

test('the smoke-test section leads with provider-free checks', () => {
  const app = appRoots()[0];
  if (!app) return;
  const doc = fs.readFileSync(path.join(app, 'docs', 'STAGING-PROXY.md'), 'utf8');
  const i = doc.indexOf('## Assistant Smoke Tests');
  assert.ok(i > 0);
  const section = doc.slice(i, doc.indexOf('### PAID LIVE TEST', i));
  assert.match(section, /without\s+calling any model provider/);
  assert.match(section, /"prompt":""/, 'the routing check uses an empty prompt, which is rejected before any provider');
  assert.match(section, /api\/assist\/lookup/);
  assert.match(section, /voice\/token/);
  assert.ok(!/"prompt":"[^"]+"/.test(section), 'no real prompt in the free section');
});
