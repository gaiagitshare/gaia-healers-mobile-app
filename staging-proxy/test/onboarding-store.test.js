import test from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, onboardingPath, onboardingState, uiSchema, mapStep } from '../gaia-onboarding.js';
import { FIELD_KEYS, createOnboardingStore, resolveFields, readAnswers } from '../onboarding-store.js';
function fixture() {
  const defs = Object.entries(FIELD_KEYS).map(([key, value]) => ({ id: 'id-' + key, fieldKey: 'contact.' + value, model: 'contact' }));
  const contact = { id: 'member-a', firstName: 'Ada', email: 'ada@example.test', tags: [], customFields: [] };
  const writes = []; let failPut = false, failPost = false;
  const store = createOnboardingStore({ locationId: () => 'location',
    get: async path => path.includes('/locations/') ? { customFields: defs } : { contact: structuredClone(contact) },
    put: async (path, body) => { writes.push({ path, body }); if (failPut) return null; for (const f of body.customFields) { const old = contact.customFields.find(x => x.id === f.id); if (old) old.value = f.fieldValue; else contact.customFields.push({ id: f.id, value: f.fieldValue }); } return { contact }; },
    post: async (path, body) => { if (failPost) return null; if (body.tags) contact.tags = [...new Set([...contact.tags, ...body.tags])]; return {}; },
  });
  return { store, contact, writes, failPut: v => { failPut = v; }, failPost: v => { failPost = v; } };
}
const answer = s => [s.options[0].label];
test('paths contain exactly the selected branches', () => {
  for (const interests of [['Living Beings'], ['Water'], ['Living Beings', 'Environment', 'Water']]) {
    const path = onboardingPath({ primary_interests: interests });
    for (const s of STEPS.filter(x => x.showIf)) assert.equal(path.includes(s), interests.includes(s.showIf));
  }
});
test('completion trusts markers, rejects the old tag heuristic, and accepts a fully answered historical form', () => {
  assert.equal(onboardingState(['gaia_practitioner_form_complete']), 'complete');
  assert.equal(onboardingState(['gaia_app_onboarding_complete']), 'complete');
  assert.equal(onboardingState(['practice_stage_growth', 'community_feature_general', 'invest_ready_now']), 'incomplete');
  const answers = { primary_interests: ['Water'] };
  for (const s of onboardingPath(answers).filter(s => !s.freeTextOnly)) if (s.key !== 'primary_interests') answers[s.key] = answer(s);
  assert.equal(onboardingState([], answers), 'complete');
  delete answers.water;
  assert.equal(onboardingState([], answers), 'incomplete');
});
test('UI schema contains no tags or GHL field identifiers', () => {
  const schema = JSON.stringify(uiSchema());
  assert.equal(schema.includes('tags'), false);
  assert.equal(schema.includes('fieldKey'), false);
});
test('every mapped field saves exact form labels and resumes across a new read', async () => {
  const f = fixture();
  await f.store.save('member-a', 'primary_interests', ['Living Beings', 'Environment', 'Water'], '', false, true);
  assert.match(f.contact.customFields[0].value[0], /^Living Beings: /);
  assert.equal((await f.store.load('member-a')).nextStep, 'why_join');
  for (const s of STEPS.filter(s => s.key !== 'primary_interests' && !s.freeTextOnly)) await f.store.save('member-a', s.key, s.key === 'environment_spaces' ? ['Clinic or office'] : answer(s), '', false, true);
  assert.deepEqual(f.contact.customFields.find(f => f.id === 'id-environment_spaces').value, ['Clinic of office']);
  const result = await f.store.save('member-a', 'final_notes', [], '', true, true);
  assert.equal(result.complete, true);
  await f.store.save('member-a', 'final_notes', [], '', true, true);
  assert.equal(f.contact.tags.filter(x => x === 'gaia_app_onboarding_complete').length, 1);
});
test('changed branches clear only removed branch fields and preserve workflow tags', async () => {
  const f = fixture();
  await f.store.save('member-a', 'primary_interests', ['Water', 'Environment'], '', false, true);
  await f.store.save('member-a', 'water', answer(STEPS.find(s => s.key === 'water')), '', false, true);
  const tags = [...f.contact.tags];
  await f.store.save('member-a', 'primary_interests', ['Environment'], '', false, true);
  assert.equal((await f.store.load('member-a')).answers.water, undefined);
  assert.ok(tags.every(t => f.contact.tags.includes(t)));
  await assert.rejects(f.store.save('member-a', 'water', ['I\'m still exploring'], '', false, true), /inactive_onboarding_branch/);
});
test('invalid inputs and premature completion cannot write to GHL', async () => {
  const f = fixture();
  for (const args of [['fake', [], '', false], ['why_join', ['arbitrary'], '', false], ['primary_interests', ['Water'], '', true], ['final_notes', [], '', true]]) await assert.rejects(f.store.save('member-a', ...args, true));
  assert.equal(f.writes.length, 0);
});
test('failed field/tag writes report failure and can be retried without losing authoritative data', async () => {
  const f = fixture(); f.failPut(true);
  await assert.rejects(f.store.save('member-a', 'primary_interests', ['Water'], '', false, true), /save_failed/);
  assert.deepEqual((await f.store.load('member-a')).answers, {});
  f.failPut(false); f.failPost(true);
  await assert.rejects(f.store.save('member-a', 'primary_interests', ['Water'], '', false, true), /tags_failed/);
  f.failPost(false);
  assert.deepEqual((await f.store.save('member-a', 'primary_interests', ['Water'], '', false, true)).answers.primary_interests, ['Water']);
});
test('voice paraphrases retain compatibility; text markers retain final free text', async () => {
  const f = fixture();
  await f.store.save('member-a', 'primary_interests', ['water'], '', false);
  for (const s of onboardingPath({ primary_interests: ['Water'] }).filter(s => s.key !== 'primary_interests' && !s.freeTextOnly)) await f.store.save('member-a', s.key, answer(s), '', false);
  await f.store.save('member-a', 'final_notes', ['Looking forward to learning'], '', true);
  assert.equal((await f.store.load('member-a')).answers.final_notes, 'Looking forward to learning');
});
test('other devices persist in their own field and clear when deselected', async () => {
  const f = fixture();
  await f.store.save('member-a', 'devices_owned', ['Other'], 'Device A\nDevice B', false, true);
  assert.equal((await f.store.load('member-a')).answers.devices_other, 'Device A\nDevice B');
  await f.store.save('member-a', 'devices_owned', ['None At This Time'], '', false, true);
  assert.equal((await f.store.load('member-a')).answers.devices_other, undefined);
});
test('free-form compatibility never treats arbitrary substrings as allowed answers', async () => {
  const f = fixture();
  await assert.rejects(f.store.save('member-a', 'primary_interests', ['ater'], '', false), /invalid_onboarding_answer/);
  assert.equal(f.writes.length, 0);
});
test('existing completion markers bypass a temporary custom-field metadata outage', async () => {
  const store = createOnboardingStore({ locationId: () => 'x', get: async url => url.includes('/contacts/') ? { contact: { id: 'done', tags: ['gaia_practitioner_form_complete'] } } : null, post: async () => null, put: async () => null });
  assert.equal((await store.load('done')).state, 'complete');
});


test('every structured choice writes its GHL field and all mapped workflow tags', async () => {
  const f = fixture();
  await f.store.save('member-a', 'primary_interests', ['Living Beings', 'Environment', 'Water'], '', false, true);
  for (const step of STEPS.filter(s => !s.freeTextOnly && s.key !== 'primary_interests')) {
    for (const option of step.options) {
      const expected = mapStep(step.key, [option.label]).tags;
      await f.store.save('member-a', step.key, [option.label], step.key === 'devices_owned' && option.label === 'Other' ? 'Synthetic device' : '', false, true);
      assert.deepEqual((await f.store.load('member-a')).answers[step.key], [option.label]);
      assert.ok(expected.every(tag => f.contact.tags.includes(tag)), `${step.key}: ${option.label}`);
      assert.ok(f.contact.customFields.some(field => field.id === 'id-' + step.key));
    }
  }
});

test('a successful tags HTTP response without persisted tags is not a confirmed save', async () => {
  const defs = Object.entries(FIELD_KEYS).map(([key, value]) => ({ id: key, fieldKey: 'contact.' + value, model: 'contact' }));
  const contact = { id: 'member-a', tags: [], customFields: [] };
  const store = createOnboardingStore({ locationId: () => 'location', get: async path => path.includes('/locations/') ? { customFields: defs } : { contact }, put: async (_path, body) => { contact.customFields = body.customFields; return {}; }, post: async () => ({ success: true }) });
  await assert.rejects(store.save('member-a', 'primary_interests', ['Water'], '', false, true), /onboarding_tags_unconfirmed/);
});


test('live survey smart apostrophes are stored exactly and resume to stable UI labels', async () => {
  const f = fixture();
  await f.store.save('member-a', 'primary_interests', ['Living Beings', 'Water'], '', false, true);
  for (const [step, label, stored] of [ ['living_beings_who', "I'm not sure yet", 'I’m not sure yet'], ['water', "I'm still exploring", 'I’m still exploring'], ['invest_timing', "I'm ready now", 'I’m ready now'] ]) {
    await f.store.save('member-a', step, [label], '', false, true);
    const value = f.contact.customFields.find(field => field.id === 'id-' + step).value;
    assert.deepEqual(value, step === 'invest_timing' ? stored : [stored]);
    assert.deepEqual((await f.store.load('member-a')).answers[step], [label]);
  }
  assert.equal(FIELD_KEYS.client_needs, 'what_are_your_clients_most_often_asking_for_right_now_select_all_that_apply');
  await f.store.save('member-a', 'client_needs', ['Other'], '', false);
  assert.deepEqual((await f.store.load('member-a')).answers.client_needs, ['Other (please specify)']);
});


test('a partial field/tag write resumes the unconfirmed step instead of skipping its tags', async () => {
  const f = fixture(); f.failPost(true);
  await assert.rejects(f.store.save('member-a', 'primary_interests', ['Water'], '', false, true), /tags_failed/);
  assert.equal((await f.store.load('member-a')).nextStep, 'primary_interests');
  f.failPost(false);
  await f.store.save('member-a', 'primary_interests', ['Water'], '', false, true);
  assert.equal((await f.store.load('member-a')).nextStep, 'why_join');
  for (const step of onboardingPath({ primary_interests: ['Water'] }).filter(s => s.key !== 'primary_interests' && !s.freeTextOnly)) await f.store.save('member-a', step.key, answer(step), '', false, true);
  assert.equal((await f.store.load('member-a')).state, 'incomplete');
  assert.equal((await f.store.load('member-a')).nextStep, 'final_notes');
  await f.store.save('member-a', 'final_notes', [], '', true, true);
  assert.equal((await f.store.load('member-a')).state, 'complete');
});


test('existing historical answers resume without repeating them; an app tag failure remains pending', async () => {
  const f = fixture();
  f.contact.customFields = [{ id: 'id-primary_interests', value: ['Water: I am interested in healing and restructuring our water systems'] }];
  assert.equal((await f.store.load('member-a')).nextStep, 'why_join');
  await f.store.save('member-a', 'why_join', answer(STEPS.find(s => s.key === 'why_join')), '', false, true);
  assert.ok(f.contact.tags.includes('interest_water_drinking') === false); // Not inferred before answering water.
  assert.ok(mapStep('primary_interests', ['Water']).tags.every(tag => f.contact.tags.includes(tag)));
  f.failPost(true);
  await assert.rejects(f.store.save('member-a', 'water', answer(STEPS.find(s => s.key === 'water')), '', false, true), /tags_failed/);
  assert.equal((await f.store.load('member-a')).nextStep, 'water');
});
test('deterministically complete legacy profile is backfilled and partial history is never backfilled', async () => {
  const f = fixture();
  f.contact.tags = ['gaia_practitioner_form_complete'];
  assert.equal((await f.store.load('member-a')).state, 'complete');
  assert.ok(f.contact.tags.includes('gaia_app_onboarding_complete'));
  const partial = fixture();
  partial.contact.customFields = [{ id: 'id-primary_interests', value: ['Water: I am interested in healing and restructuring our water systems'] }];
  assert.equal((await partial.store.load('member-a')).state, 'incomplete');
  assert.ok(!partial.contact.tags.includes('gaia_app_onboarding_complete'));
});
test('GHL keyed Other Devices text lists decode slots and ignore empty objects', () => {
  const defs=Object.entries(FIELD_KEYS).map(([k,v])=>({id:k,fieldKey:'contact.'+v,...(k==='devices_other'?{picklistOptions:[{id:'slot-a'},{id:'slot-b'}]}:{})}));
  const fields=resolveFields(defs);
  assert.equal(readAnswers([{id:'devices_other',value:{'slot-b':'Device B','slot-a':'Device A'}}],fields).devices_other,'Device A\nDevice B');
  assert.equal(readAnswers([{id:'devices_other',value:{}}],fields).devices_other,undefined);
});
test('a failed legacy backfill does not re-ask a contact whose form marker already proves completion', async () => {
  const f=fixture();f.contact.tags=['gaia_practitioner_form_complete'];f.failPost(true);
  assert.equal((await f.store.load('member-a')).state,'complete');
  assert.ok(!f.contact.tags.includes('gaia_app_onboarding_complete'));
});
