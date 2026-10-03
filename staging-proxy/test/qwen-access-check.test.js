/**
 * tools/qwen-access-check.mjs: one guarded session, nothing without the owner.
 * Offline: --dry-run must print the plan and open no socket; a missing key
 * must stop before any connection; the guard must be planned for exactly 1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = new URL('../tools/qwen-access-check.mjs', import.meta.url);
const src = fs.readFileSync(TOOL, 'utf8');
const run = (args, envFile) => spawnSync(process.execPath, [TOOL.pathname, ...args, '--env', envFile], { encoding: 'utf8', timeout: 15000 });

test('the tool is guarded for exactly one paid call and reads the key only from a .env file', () => {
  assert.match(src, /installPaidCallGuard\(\{ label: 'qwen-access-check', planned: 1/);
  assert.match(src, /guard\.count\(url\)/, 'a WebSocket is not a fetch; it has to be counted explicitly');
  assert.doesNotMatch(src, /console\.log\([^)]*apiKey/, 'the key must never be printed');
});

test('--dry-run prints the plan and exits 0 without opening anything', () => {
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-')), '.env');
  fs.writeFileSync(envFile, 'QWEN_API_KEY=not-a-real-key\nQWEN_VOICE_ENABLED=true\n');
  const r = run(['--dry-run'], envFile);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /planned paid calls: 1/);
  assert.match(r.stderr, /dry run: nothing sent/);
  assert.doesNotMatch(r.stdout, /host /, 'the dry run must stop before resolving a host');
});

test('without a key it stops with exit 2 before any connection', () => {
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-')), '.env');
  fs.writeFileSync(envFile, 'QWEN_VOICE_ENABLED=true\n');
  const r = run([], envFile);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /QWEN_API_KEY is not set/);
});
