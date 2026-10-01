// GHL is the only durable answer store. Dependencies are injected for offline tests.
import { STEPS, STEP_BY_KEY, COMPLETE_TAG, mapStep, onboardingPath, onboardingState, validAnswer, uiSchema } from './gaia-onboarding.js';
export const FIELD_KEYS = {
  primary_interests: 'im_most_interested_in_exploring',
  why_join: 'what_made_you_want_to_join_gaia_healers',
  living_beings_who: 'who_are_you_primarily_interested_in_supporting',
  living_beings_support: 'contactcontactchoose_your_field_of_specialty_4va_copy_xup_copy_svo_copy',
  environment_areas: 'contactcheckbox_10kp0_wch_copy_ndo_copy',
  environment_spaces: 'what_types_of_spaces_are_you_most_interested_in_working_with',
  water: 'contactcontactcheckbox_10kp0_wch_copy_ndo_copy_lad_copy',
  business_length: 'how_long_have_you_been_in_business_with_your_practice',
  invest_timing: 'when_do_you_feel_ready_to_invest_in_tools_technologies_or_education_related_to_healing',
  growth_needs: 'contactwhat_are_you_most_focused_on_improving_right_nowselect_all_that_apply_27s_copy',
  devices_owned: 'do_you_currently_own_any_of_these_devices',
  devices_other: 'if_other_devices_was_checked_please_share_what_other_devices_you_use_in_your_practice',
  client_needs: 'contactcheckbox_17sna_wk6_copy_ag5_copy',
  can_offer: 'contactwhat_are_your_clients_most_often_asking_for_right_now_select_all_that_apply_xzl_copy',
  want_receive: 'contactcontactwhat_are_your_clients_most_often_asking_for_right_now_select_all_that_apply_xzl_copy_o8w_copy',
  final_notes: 'before_we_wrap_up_is_there_anything_else_youd_like_us_to_know_about_you_and_where_you_are_in_growing_your_practice',
};
const STORED_LABELS = {
  'Living Beings': 'Living Beings: I am interested in health and support for people and animals',
  'Environment': 'Environment: I am interested in learning more about how to create healthier spaces and environments',
  'Water': 'Water: I am interested in healing and restructuring our water systems',
  'Clinic or office': 'Clinic of office',
};
const fail = (reason, status = 503) => Object.assign(new Error(reason), { status, reason });
export function resolveFields(definitions) {
  const fields = {};
  for (const [key, fieldKey] of Object.entries(FIELD_KEYS)) {
    const candidates = definitions.filter(f => f.fieldKey === 'contact.' + fieldKey);
    const field = candidates.find(f => !f.model || f.model === 'contact');
    if (!field?.id) throw fail('onboarding_field_unavailable');
    fields[key] = field.id;
  }
  return fields;
}
export function readAnswers(customFields, fields) {
  const values = Object.fromEntries((customFields || []).map(f => [f.id, f.value ?? f.fieldValue]));
  const answers = {};
  for (const step of STEPS) {
    const value = values[fields[step.key]];
    if (step.freeTextOnly) { if (value) answers[step.key] = String(value); continue; }
    const list = Array.isArray(value) ? value : value ? [value] : [];
    const labels = list.map(v => step.options.find(o => o.label === v || STORED_LABELS[o.label] === v)?.label);
    if (labels.length && labels.every(Boolean) && validAnswer(step, labels)) answers[step.key] = labels;
  }
  const other = values[fields.devices_other];
  if (Array.isArray(other) ? other.length : other) answers.devices_other = Array.isArray(other) ? other.join('\n') : String(other);
  return answers;
}
export function createOnboardingStore({ get, post, put, locationId, invalidate = () => {} }) {
  let metadata;
  let metadataAt = 0;
  const pending = new Map();
  async function fields() {
    if (!metadata || Date.now() - metadataAt > 300000) {
      const result = await get(`/locations/${encodeURIComponent(locationId())}/customFields`, { model: 'contact' });
      metadata = resolveFields(result?.customFields || result?.data?.customFields || []);
      metadataAt = Date.now();
    }
    return metadata;
  }
  async function load(contactId) {
    const result = await get(`/contacts/${encodeURIComponent(contactId)}`);
    const contact = result?.contact || result?.data?.contact;
    if (!contact || contact.id !== contactId) throw fail('onboarding_contact_unavailable');
    let ids;
    try { ids = await fields(); }
    catch (e) {
      if (onboardingState(contact.tags) === 'complete') return { contact, ids: null, answers: {}, state: 'complete', nextStep: null };
      throw e;
    }
    const answers = readAnswers(contact.customFields, ids);
    const complete = onboardingState(contact.tags, answers) === 'complete';
    const next = onboardingPath(answers).find(s => !s.freeTextOnly && !validAnswer(s, answers[s.key])) || STEP_BY_KEY.final_notes;
    return { contact, ids, answers, state: complete ? 'complete' : 'incomplete', nextStep: complete ? null : next.key };
  }
  async function saveNow(contactId, stepKey, selections = [], freeText = '', complete = false, strict = false) {
    const step = STEP_BY_KEY[stepKey];
    if (!step || !Array.isArray(selections) || typeof freeText !== 'string' || freeText.length > 4000) throw fail('invalid_onboarding_answer', 400);
    if (step.freeTextOnly && !strict && !freeText) { freeText = selections.join('; '); selections = []; }
    const normalize = v => String(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const aliases = {
      'Less than 1 year': '< 1 year',
      'Business infrastructure: website, scheduling and systems': 'Business infrastructure (website, scheduling, systems)',
      'Other': ['can_offer', 'want_receive'].includes(stepKey) ? 'Other (please specify)' : 'Other',
    };
    const canonical = selections.map(value => step.options.find(o => o.label === value || (!strict && (
      normalize(o.label) === normalize(value) || STORED_LABELS[o.label] === value || aliases[value] === o.label
    )))?.label);
    if (canonical.some(value => !value)) throw fail('invalid_onboarding_answer', 400);
    const mapped = mapStep(stepKey, canonical);
    const chosen = [...new Set(mapped.matched)];
    if (mapped.unmatched.length || (strict && selections.some(v => !step.options.some(o => o.label === v))) || (!step.freeTextOnly && !validAnswer(step, chosen))) throw fail('invalid_onboarding_answer', 400);
    if (complete && stepKey !== 'final_notes') throw fail('invalid_onboarding_completion', 400);
    const before = await load(contactId);
    if (!before.ids) throw fail('onboarding_field_unavailable');
    if (step.showIf && !(before.answers.primary_interests || []).includes(step.showIf)) throw fail('inactive_onboarding_branch', 400);
    if (complete && onboardingPath(before.answers).some(s => !s.freeTextOnly && !validAnswer(s, before.answers[s.key]))) throw fail('onboarding_steps_missing', 400);
    const customFields = [{ id: before.ids[stepKey], fieldValue: step.freeTextOnly ? freeText : step.multi ? chosen.map(v => STORED_LABELS[v] || v) : (STORED_LABELS[chosen[0]] || chosen[0]) }];
    if (stepKey === 'primary_interests') {
      for (const branch of STEPS.filter(s => s.showIf && (before.answers.primary_interests || []).includes(s.showIf) && !chosen.includes(s.showIf))) customFields.push({ id: before.ids[branch.key], fieldValue: [] });
    }
    if (stepKey === 'devices_owned') customFields.push({ id: before.ids.devices_other, fieldValue: chosen.includes('Other') ? freeText.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 6) : [] });
    const path = `/contacts/${encodeURIComponent(contactId)}`;
    if (!await put(path, { customFields })) throw fail('onboarding_save_failed');
    const tags = mapped.tags.slice();
    if (complete && !before.contact.tags?.includes(COMPLETE_TAG)) tags.push(COMPLETE_TAG);
    if (tags.length && !await post(path + '/tags', { tags })) throw fail('onboarding_tags_failed');
    // Free text without a corresponding GHL field retains the existing notes path.
    if (freeText && !step.freeTextOnly && stepKey !== 'devices_owned') {
      if (!await post(path + '/notes', { body: `Gaia Assist onboarding (${stepKey}): ${freeText}` })) throw fail('onboarding_note_failed');
    }
    invalidate(contactId);
    const after = await load(contactId);
    const saved = after.answers[stepKey];
    if (!step.freeTextOnly && (!saved || JSON.stringify([...saved].sort()) !== JSON.stringify([...chosen].sort()))) throw fail('onboarding_save_unconfirmed');
    if (step.freeTextOnly && (saved || '') !== freeText) throw fail('onboarding_save_unconfirmed');
    if (stepKey === 'primary_interests' && STEPS.some(s => s.showIf && (before.answers.primary_interests || []).includes(s.showIf) && !chosen.includes(s.showIf) && after.answers[s.key])) throw fail('onboarding_branch_clear_unconfirmed');
    if (complete && !after.contact.tags?.includes(COMPLETE_TAG)) throw fail('onboarding_completion_unconfirmed');
    console.info('[Gaia Onboarding]', { event: complete ? 'completed' : 'step_saved', stepKey });
    return { tagsAdded: tags, matched: chosen, unmatched: [], complete: complete && after.state === 'complete', answers: after.answers, state: after.state, nextStep: after.nextStep };
  }
  return {
    load: async contactId => { const s = await load(contactId); return { ok: true, state: s.state, answers: s.answers, nextStep: s.nextStep, schema: uiSchema(), completedByTag: (s.contact.tags || []).some(t => [COMPLETE_TAG, 'gaia_practitioner_form_complete'].includes(t)), member: { name: s.contact.firstName || s.contact.name || '', email: s.contact.email || '' } }; },
    save(contactId, ...args) {
      const previous = pending.get(contactId) || Promise.resolve();
      const task = previous.catch(() => {}).then(() => saveNow(contactId, ...args));
      pending.set(contactId, task);
      task.finally(() => { if (pending.get(contactId) === task) pending.delete(contactId); }).catch(() => {});
      return task;
    },
  };
}
