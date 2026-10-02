import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FIELD_KEYS, resolveFields, readAnswers } from '../onboarding-store.js';
import { STEPS } from '../gaia-onboarding.js';
const fixtureUrl = new URL('../../output/playwright/onboarding/ghl-survey-verification.json', import.meta.url);
const appTest = fs.existsSync(fixtureUrl) ? test : test.skip;
appTest('published survey checkbox field IDs and values match app persistence mappings', () => {
  const survey = JSON.parse(fs.readFileSync(fixtureUrl, 'utf8'));
  const live = JSON.parse(fs.readFileSync(new URL('../../output/playwright/onboarding/ghl-field-verification.json', import.meta.url), 'utf8'));
  const ids = resolveFields(live.fields.map(f => ({ id: f.id, fieldKey: f.fieldKey, model: 'contact' })));
  for (const field of survey.checkboxFields) {
    assert.equal(field.fieldKey, 'contact.' + FIELD_KEYS[field.step]);
    assert.equal(ids[field.step], field.id);
    const step = STEPS.find(s => s.key === field.step);
    assert.equal(field.values.length, step.options.length, field.step);
    for (const value of field.values) {
      const parsed = readAnswers([{ id: field.id, value: [value] }], ids);
      assert.ok(parsed[field.step]?.length, `${field.step}: ${value}`);
    }
  }
});
