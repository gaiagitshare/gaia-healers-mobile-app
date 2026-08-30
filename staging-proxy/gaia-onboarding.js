// gaia-onboarding.js — the conversational onboarding survey for Gaia Assist.
// Mirrors the live GHL onboarding form (join.gaiahealers.com/onboarding, 14 steps
// with the Living Beings / Environment / Water branch). The ASSISTANT asks the
// questions; the SERVER maps chosen option labels -> GHL tags deterministically
// (the model never invents tag names). Existing GHL tags reuse the real
// community/membership workflows; new descriptive tags sharpen our targeting.
'use strict';

const COMPLETE_TAG = 'gaia_app_onboarding_complete';

// Each step: { key, title, question, multi, branch?, options:[{label, tags[]}], freeText? }
const STEPS = [
  {
    key: 'primary_interests', title: 'Primary interests', multi: true,
    question: "I'm most interested in exploring…",
    branch: true,
    options: [
      { label: 'Living Beings', tags: ['interest_general_beings_health'] },
      { label: 'Environment', tags: ['product_general_environment_interest'] },
      { label: 'Water', tags: ['product_general_water_interest'] },
    ],
  },
  {
    key: 'why_join', title: 'Why join', multi: false,
    question: 'What made you want to join Gaia Healers?',
    options: [
      { label: 'For my own healing / consciousness', tags: ['interest_personal_healing'] },
      { label: 'For healing others professionally', tags: ['interest_professional_healing'] },
    ],
  },
  {
    key: 'living_beings_who', title: 'Who you support', multi: false, showIf: 'Living Beings',
    question: 'Who are you primarily interested in supporting?',
    options: [
      { label: 'Myself', tags: ['interest_personal_health'] },
      { label: 'Other People', tags: ['interest_general_beings_health'] },
      { label: 'Pets', tags: ['interest_pet_health'] },
      { label: 'Livestock or farm animals', tags: ['interest_livestock_health'] },
      { label: 'Wildlife or sanctuaries', tags: ['interest_wildlife_health'] },
      { label: "I'm not sure yet", tags: [] },
    ],
  },
  {
    key: 'living_beings_support', title: 'Support types', multi: true, showIf: 'Living Beings',
    question: 'What types of support are you most interested in for living beings?',
    options: [
      { label: 'Energy or biofield assessment', tags: ['interest_service_biofield_assessment', 'product_biowell_interest'] },
      { label: 'Stress and nervous system balance', tags: ['interest_service_nervous_system'] },
      { label: 'Brain health or neurofeedback', tags: ['interest_service_neurofeedback', 'product_braintap_interest'] },
      { label: 'Body composition, inflammation, or physiology', tags: ['interest_service_body_composition'] },
      { label: 'Remote or distance healing', tags: ['interest_service_remote_healing'] },
      { label: 'All-in-one measurement and correction systems', tags: ['interest_service_allinone', 'product_miracleqst_interest'] },
      { label: 'Phototherapy or light-based wellness', tags: ['interest_service_phototherapy', 'product_lifewave_interest'] },
      { label: 'Support chronic inflammation and pain management', tags: ['interest_service_pain_management'] },
      { label: 'Offer custom meditation and brain entrainment', tags: ['interest_service_meditation', 'product_braintap_interest'] },
      { label: 'Offer colour therapy sessions', tags: ['interest_service_colour_therapy', 'product_colourenergy_interest'] },
      { label: 'Offer custom structured water and sound therapy', tags: ['interest_service_structured_water_sound', 'product_quantum_sound_therapy_interest'] },
      { label: 'Restore hydration with Alkaline water', tags: ['interest_service_alkaline_water', 'product_kangan_interest'] },
    ],
  },
  {
    key: 'environment_areas', title: 'Environment areas', multi: true, showIf: 'Environment',
    question: 'What environmental areas are you most curious about improving?',
    options: [
      { label: 'EMF measurement or mitigation', tags: ['interest_env_emf', 'product_noxtak_interest'] },
      { label: 'Sound, frequency, or vibration in spaces', tags: ['interest_env_sound', 'product_quantum_sound_therapy_interest'] },
      { label: 'Objects that influence energy of environments', tags: ['interest_env_objects', 'product_tachyon_interest'] },
      { label: 'Remote or scalar-based environmental support', tags: ['interest_env_scalar', 'product_scalar_energy_interest'] },
      { label: 'Interested in measuring the energy of environments', tags: ['interest_env_measurement', 'product_general_environment_interest'] },
      { label: "I'm still exploring", tags: [] },
    ],
  },
  {
    key: 'environment_spaces', title: 'Spaces', multi: false, showIf: 'Environment',
    question: 'What types of spaces are you most interested in working with?',
    options: [
      { label: 'Home or personal living spaces', tags: ['interest_space_home'] },
      { label: 'Clinic or office', tags: ['interest_space_clinic'] },
      { label: 'Land, farms or outdoor property', tags: ['interest_space_land'] },
      { label: 'Community or public spaces', tags: ['interest_space_community'] },
      { label: 'Remote or Distance Based', tags: ['interest_space_remote'] },
      { label: "I'm still exploring", tags: [] },
    ],
  },
  {
    key: 'water', title: 'Water', multi: false, showIf: 'Water',
    question: 'How are you most interested in working with water?',
    options: [
      { label: 'Drinking water for personal or family use', tags: ['interest_water_drinking', 'product_general_water_interest'] },
      { label: 'Structuring or restoring water with technology', tags: ['interest_water_structuring', 'product_general_water_interest'] },
      { label: 'Charging water with sound or information', tags: ['interest_water_charging', 'product_quantum_sound_therapy_interest'] },
      { label: 'Water for crops, farms, or livestock', tags: ['interest_water_agriculture'] },
      { label: 'Measuring water coherence or quality', tags: ['interest_water_measurement', 'product_biowell_water_interest'] },
      { label: "I'm still exploring", tags: ['product_general_water_interest'] },
    ],
  },
  {
    key: 'business_length', title: 'Business length', multi: false,
    question: 'How long have you been in business with your practice?',
    options: [
      { label: "I haven't started it yet, but I'm ready to get going!", tags: ['practice_stage_prelaunch'] },
      { label: 'Less than 1 year', tags: ['practice_stage_early'] },
      { label: '1–3 years', tags: ['practice_stage_growth'] },
      { label: '3–5 years', tags: ['practice_stage_established'] },
      { label: '5–10 years', tags: ['practice_stage_scaling'] },
      { label: '10+ years', tags: ['practice_stage_mature'] },
    ],
  },
  {
    key: 'invest_timing', title: 'Investment timing', multi: false,
    question: 'When do you feel ready to invest in tools, technologies, or education related to healing?',
    options: [
      { label: "I'm ready now", tags: ['invest_ready_now'] },
      { label: 'In the next 3–6 months', tags: ['invest_3_6_months'] },
      { label: 'In the next 6–12 months', tags: ['invest_6_12_months'] },
      { label: "I'm just exploring right now", tags: ['invest_exploring'] },
    ],
  },
  {
    key: 'growth_needs', title: 'Growth needs', multi: true,
    question: 'What kind of support would be most helpful for you right now?',
    options: [
      { label: 'Business infrastructure: website, scheduling and systems', tags: ['need_infrastructure'] },
      { label: 'Automation or software tools', tags: ['need_software', 'crm_interest_education'] },
      { label: 'Client visibility or referrals', tags: ['need_visibility'] },
      { label: 'Education and training', tags: ['community_feature_education'] },
      { label: 'Community connection', tags: ['community_feature_general'] },
      { label: 'None right now', tags: [] },
    ],
  },
  {
    key: 'devices_owned', title: 'Devices owned', multi: true,
    question: 'Do you currently own any of these devices?',
    options: [
      { label: 'BioPulsar', tags: ['product_biopulsar_owner'] },
      { label: 'Bio-Well', tags: ['product_biowell_owner'] },
      { label: 'BrainTap', tags: ['product_braintap_owner'] },
      { label: 'BioTekna BIA', tags: ['product_bia_owner'] },
      { label: 'BioTekna HEG', tags: ['product_heg_owner'] },
      { label: 'BioTekna PPG', tags: ['product_ppg_owner'] },
      { label: 'BioTekna TomEEX', tags: ['product_tomeex_owner'] },
      { label: 'BioTekna Regmatex', tags: ['product_regmatex_owner'] },
      { label: 'ASEA', tags: ['product_asea_owner'] },
      { label: 'LifeWave', tags: ['product_lifewave_owner'] },
      { label: 'SPIRO', tags: ['product_spiro_owner'] },
      { label: 'Miracle QST', tags: ['product_miracleqst_owner'] },
      { label: 'Healy', tags: ['product_healy_owner'] },
      { label: 'ANS Control', tags: ['product_ans_control_owner'] },
      { label: 'Bio-Well BioCor', tags: ['product_biowell_biocor_owner'] },
      { label: 'Bio-Well Sputnik', tags: ['product_biowell_sputnik_owner'] },
      { label: 'Bio-Well Water Sensor', tags: ['product_biowell_water_sensor_owner'] },
      { label: 'Other', tags: ['product_other_devices_owner'] },
      { label: 'None At This Time', tags: [] },
    ],
    freeText: 'If Other, share what other devices you use.',
  },
  {
    key: 'client_needs', title: 'Client needs', multi: true,
    question: 'What are the main needs or goals that your clients are looking for you to help them with?',
    options: [
      { label: 'Improving mental/cognitive function', tags: ['interest_client_cognitive'] },
      { label: 'Reducing stress and supporting the nervous system', tags: ['interest_client_stress'] },
      { label: 'Optimizing physical health and body composition', tags: ['interest_client_physical'] },
      { label: 'Receiving remote or in-person energy/wellness support', tags: ['interest_client_energy'] },
      { label: 'Enhancing their environment or water quality', tags: ['interest_client_environment'] },
      { label: 'Other', tags: [] },
    ],
    freeText: 'If Other, share more.',
  },
  {
    key: 'can_offer', title: 'What you can offer', multi: true,
    question: 'What do you feel called to offer the Gaia Healers community?',
    options: [
      { label: 'My personal testimony so others can get uplifted', tags: ['interest_community_testimonial'] },
      { label: 'Becoming a Gaia Healers center', tags: ['interest_gaia_healer_center'] },
      { label: 'Education, teaching, or training', tags: ['interest_education_partner'] },
      { label: 'Community leadership or moderation', tags: ['interest_community_moderator'] },
      { label: 'Volunteering for events', tags: ['interest_community_volunteer'] },
      { label: 'Bringing my offer to the community and support it', tags: ['interest_community_general'] },
      { label: 'Other', tags: [] },
    ],
    freeText: 'If Other, share more.',
  },
  {
    key: 'want_receive', title: 'What you want to receive', multi: true,
    question: 'What are you hoping to receive from this community?',
    options: [
      { label: 'Education and understanding of energy-based healing systems', tags: ['community_feature_education'] },
      { label: 'Guidance from practitioners, mentors, or experienced leaders', tags: ['community_feature_mentorship'] },
      { label: 'Access to tools, technologies, or practical resources', tags: ['community_feature_tools_resources'] },
      { label: 'Support for personal healing or wellbeing', tags: ['community_feature_personalsupport'] },
      { label: 'Support for professional or practice growth', tags: ['community_feature_practicegrowth'] },
      { label: 'Community connection, collaboration, and shared learning', tags: ['community_feature_general'] },
      { label: 'Other', tags: ['community_feature_other'] },
    ],
    freeText: 'If Other, share more.',
  },
  {
    key: 'final_notes', title: 'Final comments', multi: false, freeTextOnly: true,
    question: "Before we wrap up, is there anything else you'd like us to know about you and where you are in growing your practice?",
    options: [],
  },
];

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
const STEP_BY_KEY = {};
STEPS.forEach((s) => { STEP_BY_KEY[s.key] = s; });

// Map one step's chosen option labels -> tags. Fuzzy-matches labels so the model
// can paraphrase slightly. Returns { tags:[], matched:[], unmatched:[] }.
function mapStep(stepKey, selections) {
  const step = STEP_BY_KEY[stepKey];
  const out = { tags: [], matched: [], unmatched: [] };
  if (!step || !Array.isArray(selections)) return out;
  selections.forEach((sel) => {
    const ns = norm(sel);
    if (!ns) return;
    let opt = step.options.find((o) => norm(o.label) === ns);
    if (!opt) opt = step.options.find((o) => norm(o.label).indexOf(ns) >= 0 || ns.indexOf(norm(o.label)) >= 0);
    if (opt) { out.matched.push(opt.label); opt.tags.forEach((t) => { if (out.tags.indexOf(t) < 0) out.tags.push(t); }); }
    else out.unmatched.push(sel);
  });
  return out;
}

// Full-submission mapping: answers = { stepKey: [labels], ... } → { tags, perStep }
function mapOnboardingAnswers(answers) {
  const tags = []; const perStep = {};
  Object.keys(answers || {}).forEach((k) => {
    const r = mapStep(k, answers[k]);
    perStep[k] = r;
    r.tags.forEach((t) => { if (tags.indexOf(t) < 0) tags.push(t); });
  });
  return { tags, perStep };
}

// Has this member already done the onboarding survey? (complete marker, or the
// GHL form-complete tag, or a solid cluster of survey-built interest tags.)
function onboardingState(tags) {
  const set = new Set((tags || []).map((t) => String(t).toLowerCase()));
  if (set.has(COMPLETE_TAG) || set.has('gaia_practitioner_form_complete')) return 'complete';
  let signals = 0;
  set.forEach((t) => { if (/^practice_stage_|^community_feature_|^interest_(personal|professional|pet|livestock|wildlife|general_beings)_|^invest_/.test(t)) signals++; });
  return signals >= 3 ? 'complete' : 'incomplete';
}

// The compact survey script injected into the assistant's system prompt.
function onboardingPromptBlock() {
  const lines = [];
  lines.push('ONBOARDING SURVEY (run this in conversation when a signed-in member has NOT completed it). Ask ONE step at a time, in order, in your own warm words — never dump the whole list. Read the options naturally; let them pick one or several (multi = choose all that apply). After each step, RECORD it via your save mechanism (described just above) using the EXACT option label(s) they chose so their tags are created; do not say tag names out loud. Keep it light — it is a friendly getting-to-know-you, ~2 minutes, not an interrogation. They may skip any step.');
  lines.push('BRANCHING: Step "primary_interests" decides the path. Only ask living_beings_* if they picked Living Beings; only ask environment_* if Environment; only ask water if Water. Skip the branches they did not pick.');
  STEPS.forEach((s, i) => {
    const cond = s.showIf ? ` [only if "${s.showIf}" chosen]` : '';
    const opts = s.freeTextOnly ? '(free text)' : s.options.map((o) => o.label).join(' | ');
    lines.push(`${i + 1}. key=${s.key}${s.multi ? ' (multi)' : ''}${cond}: "${s.question}" — ${opts}`);
  });
  lines.push('On the FINAL step (final_notes) record it with complete=true so their profile is marked done. Then thank them warmly and move to ONE tailored suggestion based on what they shared.');
  return lines.join('\n');
}

// Turn a member's tags into concrete, non-pushy next-step suggestions.
function suggestOffers(tags, hasPaidSub) {
  const set = new Set((tags || []).map((t) => String(t).toLowerCase()));
  const has = (re) => { for (const t of set) if (re.test(t)) return true; return false; };
  const offers = [];
  if (has(/_owner$/) && !hasPaidSub) offers.push('They OWN a device but have no paid subscription — a Silver/Gold membership unlocks the community + training for the gear they already have. Offer the best-fit tier.');
  if (set.has('invest_ready_now')) offers.push('They said they are READY TO INVEST NOW — this is a warm moment to recommend the specific membership tier or device that matches their goal, with its activation link.');
  if (has(/^practice_stage_(growth|established|scaling|mature)$/)) offers.push('Established practice → Gold or Diamond (directory exposure, CRM/software, lead generation) fits their growth stage.');
  if (has(/^practice_stage_(prelaunch|early)$/)) offers.push('Early/pre-launch → start with Free or Silver and the foundational courses; do not push high tiers.');
  if (has(/product_biopulsar/)) offers.push('BioPulsar interest/owner → the BioPulsar community + BioPulsar training.');
  if (has(/product_biowell/)) offers.push('Bio-Well interest/owner → the Bio-Well community + Bio-Well Orientation/Advanced courses.');
  if (has(/product_biotekna|_bia_|_heg_|_ppg_|_tomeex_|_regmatex_/)) offers.push('BioTekna interest/owner → the BioTekna community + training.');
  if (set.has('interest_gaia_healer_center')) offers.push('Wants to become a Gaia Healers center → route to the practitioner/center path (Gold/Diamond).');
  if (has(/^interest_client_/)) offers.push('Their clients’ needs are known — suggest the devices/courses that serve those exact needs.');
  return offers;
}

// express_interest: map a free-text topic the member voices ("I'm interested in
// BioPulsar", "structured water", "getting certified") to GHL interest tag(s)
// (so the existing routing workflows fire) + where in the app to take them.
const INTEREST_MAP = [
  { re: /biopulsar|bio[- ]?pulsar/, tags: ['product_biopulsar_interest'], route: { kind: 'community', community: 'biopulsar' } },
  { re: /bio[- ]?well|biowell/, tags: ['product_biowell_interest'], route: { kind: 'community', community: 'biowell' } },
  { re: /biotekna|bio[- ]?tekna/, tags: ['product_biotekna_interest'], route: { kind: 'community', community: 'biotekna' } },
  { re: /braintap|brain[- ]?tap|neurofeedback|entrainment/, tags: ['product_braintap_interest'], route: { kind: 'community', community: 'braintap' } },
  { re: /asea/, tags: ['product_asea_interest'], route: { kind: 'community', community: 'asea' } },
  { re: /lifewave|life[- ]?wave|phototherapy|light[- ]?based/, tags: ['product_lifewave_interest'], route: { kind: 'community', community: 'lifewave' } },
  { re: /healy/, tags: ['product_healy_interest'], route: { kind: 'navigate', screen: 'store', tab: 'shop' } },
  { re: /tachyon/, tags: ['product_tachyon_interest'], route: { kind: 'navigate', screen: 'store', tab: 'shop' } },
  { re: /colou?r|chakra spray|colour energy/, tags: ['product_colourenergy_interest'], route: { kind: 'navigate', screen: 'store', tab: 'shop' } },
  { re: /water|kangen|alkaline|hydration/, tags: ['product_general_water_interest'], route: { kind: 'navigate', screen: 'store', tab: 'shop' } },
  { re: /certif|become a practitioner|get listed|directory listing|practitioner path/, tags: ['interest_professional_healing', 'practitioner_interest_biofield'], route: { kind: 'navigate', screen: 'store', tab: 'membership' } },
  { re: /member|subscrib|silver|gold|diamond|upgrade|plan/, tags: [], route: { kind: 'navigate', screen: 'store', tab: 'membership' } },
  { re: /event|conference|elevate|gathering/, tags: [], route: { kind: 'navigate', screen: 'events' } },
  { re: /course|academy|learn|training|class/, tags: [], route: { kind: 'navigate', screen: 'academy' } },
  { re: /practitioner|healer|directory|find (a|someone)/, tags: [], route: { kind: 'navigate', screen: 'directory' } },
];
function interestFromTopic(topic) {
  const t = String(topic || '').toLowerCase();
  for (let i = 0; i < INTEREST_MAP.length; i++) {
    if (INTEREST_MAP[i].re.test(t)) return { matched: true, tags: INTEREST_MAP[i].tags.slice(), route: INTEREST_MAP[i].route };
  }
  return { matched: false, tags: [], route: null };
}

// ── Targeting engine ────────────────────────────────────────────────
// Turn a member's tags + the LIVE catalog into SPECIFIC, ranked, deduped
// recommendations (priced products, named courses, the right tier + community),
// cross-checked against what they already own. Pure function — the server feeds
// it live store products, course titles, owned courses, and subscription state.
const DEVICE_SIGNALS = [
  { key: 'biowell', label: 'Bio-Well', ownRe: /biowell.*owner|bio-?well owner|biocor owner|sputnik owner|water sensor owner/, intRe: /biowell.*interest|biocor.*interest|sputnik.*interest|biowell_water.*interest/, prodRe: /bio-?well|biocor|sputnik/i, courseRe: /bio-?well/i, community: 'biowell' },
  { key: 'biopulsar', label: 'BioPulsar', ownRe: /biopulsar.*owner|biopulsar-owner/, intRe: /biopulsar.*interest/, prodRe: /biopulsar/i, courseRe: /biopulsar/i, community: 'biopulsar' },
  { key: 'biotekna', label: 'BioTekna', ownRe: /biotekna.*owner|_bia_owner|_heg_owner|_ppg_owner|_tomeex_owner|_regmatex_owner|bia owner|heg owner|ppg.*owner/, intRe: /biotekna.*interest|_bia_interest|_heg_interest|_ppg_interest|_tomeex_interest|_regmatex_interest/, prodRe: /biotekna/i, courseRe: /biotekna/i, community: 'biotekna' },
  { key: 'braintap', label: 'BrainTap', ownRe: /braintap.*owner/, intRe: /braintap.*interest|neurofeedback|meditation/, prodRe: /braintap/i, courseRe: /braintap/i, community: 'braintap' },
  { key: 'colour', label: 'Colour Energy', ownRe: /x^/, intRe: /colourenergy.*interest|colour_therapy/, prodRe: /colou?r|chakra/i, courseRe: /chakra/i, community: null },
  { key: 'tachyon', label: 'Tachyon', ownRe: /x^/, intRe: /tachyon.*interest|env_objects/, prodRe: /tachyon/i, courseRe: /x^/, community: null },
  { key: 'water', label: 'water', ownRe: /x^/, intRe: /general_water.*interest|alkaline|kangen/, prodRe: /water|kangen|hydrogen/i, courseRe: /x^/, community: null },
  { key: 'healy', label: 'Healy', ownRe: /healy.*owner/, intRe: /healy.*interest/, prodRe: /healy/i, courseRe: /x^/, community: null },
  { key: 'lifewave', label: 'LifeWave', ownRe: /lifewave.*owner/, intRe: /lifewave.*interest|phototherapy/, prodRe: /lifewave/i, courseRe: /x^/, community: 'lifewave' },
];
function buildTargeting(tags, opts) {
  opts = opts || {};
  const set = new Set((tags || []).map((t) => String(t).toLowerCase()));
  const tagList = Array.from(set);
  // Match WITHIN a single tag (never across tags) so e.g. biopulsar.*owner does
  // not match a biopulsar-interest tag + an unrelated sputnik-owner tag.
  const has = (re) => tagList.some((t) => re.test(t));
  const products = (opts.storeProducts || []).filter((p) => p && p.title && p.available !== false);
  const courseTitles = opts.courseTitles || [];
  const ownedCourses = (opts.ownedCourseTitles || []).map((x) => String(x || '').toLowerCase());
  const hasPaidSub = !!opts.hasPaidSub;
  const ownsCourse = (re) => ownedCourses.some((c) => re.test(c));
  const rec = { hotLead: false, membership: null, courses: [], products: [], communities: [], headline: '' };

  if (set.has('invest_ready_now')) rec.hotLead = true;
  // membership tier from practice stage / aspiration (only if not already paying)
  if (set.has('interest_gaia_healer_center')) rec.membership = 'diamond';
  else if (has(/practice_stage_(growth|established|scaling|mature)/)) rec.membership = 'gold';
  else if (has(/practice_stage_(prelaunch|early)/)) rec.membership = 'silver';
  if (hasPaidSub) rec.membership = null; // do not re-pitch a plan they pay for

  const seenCourse = {}, seenProd = {}, seenComm = {};
  DEVICE_SIGNALS.forEach((d) => {
    const owner = d.ownRe && d.ownRe.source !== 'x^' && has(d.ownRe);
    const interested = d.intRe && has(d.intRe);
    if (!owner && !interested) return;
    if (d.courseRe && d.courseRe.source !== 'x^' && !ownsCourse(d.courseRe)) {
      const c = courseTitles.find((t) => d.courseRe.test(t));
      if (c && !seenCourse[c]) { seenCourse[c] = 1; rec.courses.push({ title: c, reason: owner ? ('owns ' + d.label + ', not yet trained — certify') : ('interested in ' + d.label), priority: owner ? 3 : 1 }); }
    }
    if (!owner && d.prodRe) {
      products.filter((p) => d.prodRe.test(p.title)).slice(0, 2).forEach((p) => { if (!seenProd[p.title]) { seenProd[p.title] = 1; rec.products.push({ title: p.title, price: p.price || '', url: p.url || '', reason: 'interested in ' + d.label, priority: 1 }); } });
    }
    if (d.community && !seenComm[d.community] && !has(new RegExp('community-' + d.community + '-member'))) { seenComm[d.community] = 1; rec.communities.push(d.community); }
  });
  rec.courses.sort((a, b) => b.priority - a.priority);
  rec.products.sort((a, b) => b.priority - a.priority);
  rec.courses = rec.courses.slice(0, 4);
  rec.products = rec.products.slice(0, 4);

  // headline = the single best next step
  const ownerCourse = rec.courses.find((c) => c.priority >= 3);
  if (ownerCourse) rec.headline = 'They own the device but are not certified — nudge the "' + ownerCourse.title + '" course' + (rec.hotLead ? ' (they are ready to invest now)' : '') + '.';
  else if (rec.hotLead && rec.membership) rec.headline = 'Ready to invest now → recommend the ' + rec.membership.toUpperCase() + ' membership with its activation link.';
  else if (rec.membership && !hasPaidSub) rec.headline = 'Best-fit membership for their stage is ' + rec.membership.toUpperCase() + '.';
  else if (rec.courses.length) rec.headline = 'Suggest the "' + rec.courses[0].title + '" course.';
  else if (rec.products.length) rec.headline = 'Suggest ' + rec.products[0].title + (rec.products[0].price ? ' (' + rec.products[0].price + ')' : '') + '.';
  return rec;
}
function formatTargeting(rec) {
  if (!rec) return '';
  const parts = [];
  if (rec.headline) parts.push('Best next step: ' + rec.headline);
  if (rec.courses.length) parts.push('Courses to suggest: ' + rec.courses.map((c) => '"' + c.title + '" (' + c.reason + ')').join('; '));
  if (rec.products.length) parts.push('Products to suggest: ' + rec.products.map((p) => p.title + (p.price ? ' — ' + p.price : '') + ' (' + p.reason + ')').join('; '));
  if (rec.membership) parts.push('Membership to offer: ' + rec.membership.toUpperCase());
  if (rec.communities.length) parts.push('Communities they could join: ' + rec.communities.join(', '));
  if (!parts.length) return '';
  return 'TARGETED RECOMMENDATIONS (specific, from the live catalog, deduped against what they own — bring up the Best next step first, naturally and one at a time, never pushy):\n' + parts.map((p) => '- ' + p).join('\n');
}

export {
  COMPLETE_TAG, STEPS, STEP_BY_KEY,
  mapStep, mapOnboardingAnswers, onboardingState, onboardingPromptBlock, suggestOffers,
  interestFromTopic, buildTargeting, formatTargeting,
};
