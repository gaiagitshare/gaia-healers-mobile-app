/**
 * Gaia practitioner tiers, spec v2.5 §3 and decisions D1, D4, D10, D13, D14.
 * This is SEED DATA for plan version 1 of each tier, written once by
 * seedCatalog(); afterwards the database is the source and any change is a new
 * plan version. Prices are integer cents (USD).
 *
 * Not here on purpose:
 *   - legacy plans (Silver / Gold / Diamond, the partner's $47 / $97 module
 *     subscriptions): they become legacy plan versions only from real data,
 *     after decisions D7 / N-6 and the partner export;
 *   - EMPA insurance bundle ("future", D8);
 *   - coin pack prices are "indicative" in the spec, so packs seed as drafts.
 */
export const ENTITLEMENTS = [
  ['listing.directory', 'listing', 'Directory listing'],
  ['listing.featured', 'listing', 'Featured directory placement'],
  ['listing.badge.gaia_recommended', 'listing', '"Gaia Recommended" directory badge'],
  ['community.access', 'community', 'Community access'],
  ['community.state_of_union_calls', 'community', 'State of the Union calls'],
  ['community.newsletter', 'community', 'Newsletter'],
  ['community.inner_circle_channel', 'community', 'Private inner-circle community channel'],
  ['software.scan_analysis', 'module', 'Bio-Well scan analysis'],
  ['software.automatic_scan_analysis', 'module', 'Automatic scan analysis'],
  ['software.chakras', 'module', 'Chakras'],
  ['software.auriculo', 'module', 'Auriculo'],
  ['software.biopulsar_biotekna_views', 'module', 'BioPulsar / BioTekna views'],
  ['software.client_portal', 'feature', 'Client portal'],
  ['software.marketplace', 'feature', 'Marketplace'],
  ['software.ai_avatar_videos', 'feature', 'Custom AI avatar videos'],
  ['support.group_coaching_monthly', 'support', 'Monthly group coaching call'],
  ['support.premium', 'support', 'Premium support: priority Q&A, smaller implementation sessions, direct access'],
  ['support.inner_circle_call_monthly', 'support', 'Monthly inner-circle group call with Nima (1 hour, group only)'],
  ['courses.core', 'course_access', 'Core courses'],
  ['certification.foundational', 'certification', 'Foundational / basic certification'],
  ['certification.level_1', 'certification', 'Level 1 certification'],
  ['certification.level_2', 'certification', 'Level 2 certification'],
  ['certification.specialty.photobiomodulation', 'certification', 'Specialty: photobiomodulation'],
  ['certification.specialty.crystal_acupuncture', 'certification', 'Specialty: crystal acupuncture'],
  ['certification.specialty.tachyon', 'certification', 'Specialty: tachyon'],
  ['discount.certifications_pct', 'discount', 'Percent off certifications'],
  ['crm.ghl_subaccount', 'feature', 'Full GHL CRM subaccount with the Bio-Well Practice Snapshot'],
  ['perk.podcast_spotlight_eligibility', 'perk', 'Podcast spotlight and interview eligibility'],
  ['perk.podcast_priority', 'perk', 'Priority for podcast interviews and spotlights'],
  ['perk.early_access', 'perk', 'Early access to new features, tech previews and pilots'],
  ['perk.conference_vip', 'perk', 'VIP treatment at the annual conference'],
];

const FREE = ['listing.directory', 'community.access', 'community.state_of_union_calls', 'community.newsletter'];
const STANDARD = [...FREE,
  'software.scan_analysis', 'software.automatic_scan_analysis', 'software.chakras', 'software.auriculo',
  'software.biopulsar_biotekna_views', 'software.client_portal', 'software.marketplace', 'software.ai_avatar_videos',
  'support.group_coaching_monthly', 'courses.core', 'certification.foundational'];
const PROFESSIONAL = [...STANDARD,
  'support.premium', 'certification.level_1', 'certification.level_2', 'certification.specialty.photobiomodulation',
  'certification.specialty.crystal_acupuncture', 'certification.specialty.tachyon', 'crm.ghl_subaccount',
  'perk.podcast_spotlight_eligibility'];
const INNER_CIRCLE = [...PROFESSIONAL,
  'support.inner_circle_call_monthly', 'perk.early_access', 'listing.featured', 'listing.badge.gaia_recommended',
  'perk.podcast_priority', 'perk.conference_vip', 'community.inner_circle_channel'];

const flags = (keys, extra = {}) => Object.fromEntries([...keys.map((k) => [k, true]), ...Object.entries(extra)]);

export const TIERS = [
  { key: 'free', name: 'Free', rank: 0, coins: 0, prices: { none: 0 }, entitlements: flags(FREE) },
  { key: 'standard', name: 'Standard', rank: 1, coins: 500, prices: { month: 4700, year: 47000 }, entitlements: flags(STANDARD) },
  { key: 'professional', name: 'Professional', rank: 2, coins: 2000, prices: { month: 9700, year: 97000 },
    entitlements: flags(PROFESSIONAL, { 'discount.certifications_pct': 20 }) },
  { key: 'inner_circle', name: 'Inner Circle', rank: 3, coins: 4000, prices: { month: 29700, year: 297000 },
    entitlements: flags(INNER_CIRCLE, { 'discount.certifications_pct': 20 }) },
];

export const COIN_PACKAGES = [
  { key: 'starter', coins: 500, priceCents: 500 },
  { key: 'regular', coins: 1200, priceCents: 1000 },
  { key: 'pro', coins: 3000, priceCents: 2500 },
];

export const COIN_CENTS = 1;   // 1 coin = $0.01 (spec §4)
