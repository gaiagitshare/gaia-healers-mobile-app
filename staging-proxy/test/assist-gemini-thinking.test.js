/**
 * TEXT CHAT THINKS "minimal" (owner-approved 3 Oct 2026, Phase B item 4).
 *
 * One real reply spent 806 thinking tokens on 70 reply tokens; "low" left
 * 320, "minimal" left none with the same reply. Both Gemini text calls --
 * the one-shot and the stream -- now send
 * generationConfig.thinkingConfig.thinkingLevel = "minimal" unless
 * GEMINI_TEXT_THINKING_LEVEL says otherwise; "default" sends nothing, so the
 * revert is one environment line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-thinking-')));
const S = 'thinking-secret-'.padEnd(48, 't');
Object.assign(process.env, {
  PORT: '0', HOST: '127.0.0.1', GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false',
  AUTH_SESSION_SECRET: S, COURSES_SYNC_SECRET: S, GHL_BACKFILL_SECRET: S, GHL_WORKFLOW_WEBHOOK_SECRET: S, GAIA_USAGE_LOG: '',
});
delete process.env.GEMINI_TEXT_THINKING_LEVEL;
globalThis.fetch = async (u) => { if (!/^(127\.|localhost$)/.test(new URL(String(u)).hostname)) throw new Error('offline'); return new Response('{}'); };
const srv = await import(new URL('../server.js', import.meta.url).href);
test.after(() => srv.closeServer?.());

test('by default both text-chat shapes think "minimal", with the same temperature and output caps as before', () => {
  assert.deepEqual(srv.geminiTextGenerationConfig(false), { temperature: 0.35, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'minimal' } });
  assert.deepEqual(srv.geminiTextGenerationConfig(true), { temperature: 0.35, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'minimal' } });
});

test('GEMINI_TEXT_THINKING_LEVEL=default (or anything unknown) sends no thinkingConfig at all -- the revert', () => {
  process.env.GEMINI_TEXT_THINKING_LEVEL = '';
  assert.deepEqual(srv.geminiTextGenerationConfig(false).thinkingConfig, { thinkingLevel: 'minimal' }, 'an empty variable is the same as unset');
  for (const v of ['default', 'off', 'none', '  ', '42']) {
    process.env.GEMINI_TEXT_THINKING_LEVEL = v;
    assert.equal(srv.geminiTextGenerationConfig(false).thinkingConfig, undefined, JSON.stringify(v));
  }
  process.env.GEMINI_TEXT_THINKING_LEVEL = 'HIGH';
  assert.deepEqual(srv.geminiTextGenerationConfig(false).thinkingConfig, { thinkingLevel: 'high' }, 'a documented level is passed through, lower-cased');
  delete process.env.GEMINI_TEXT_THINKING_LEVEL;
});

test('both Gemini text call sites use the helper, so the stream path cannot drift from the one-shot path', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const sites = src.match(/generationConfig: geminiTextGenerationConfig\(isVoice\)/g) || [];
  assert.equal(sites.length, 2, 'generateContent and streamGenerateContent');
  assert.doesNotMatch(src, /generationConfig: \{ temperature/, 'no hand-written generationConfig left');
});
