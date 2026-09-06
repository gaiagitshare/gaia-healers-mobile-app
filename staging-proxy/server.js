import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import * as adminRouter from './admin-router.js';
import * as wellnessRouter from './wellness-router.js';
import * as directoryRouter from './directory-router.js';
import * as eventIdentity from './membership/event-identity.js';
import * as reader from './membership/reader.js';
import * as onboarding from './gaia-onboarding.js';
import { migrateStore, migrateContactRecord } from './membership/ledger.js';
import { resolveMemberAccess } from './membership/resolver.js';
import { UNRESOLVED_BILLING_IDS, tierFromBillingIds } from './membership/config.js';
import { membershipPlans } from './membership/plans.js';
import { syncCatalog, storeView, diffMessages, emptyCatalog, productDetail } from './membership/store-catalog.js';
import { audit as recordAudit } from './membership/audit-log.js';
import { loadPolicy as loadMembershipPolicy, loadRegistry as loadMembershipRegistry, loadModel as loadCommerceModel } from './membership/admin-api.js';
import {
  resourceKey, eventTimestamp, eventSequence, decideOrder, watermark,
  noteRejection, domainWatermarkMs,
} from './membership/ordering.js';
import {
  verifyIdToken, claimEmailVerified, isAppleRelayEmail, appleClientSecret,
  googleAuthUrl, appleAuthUrl, providerConfig as oauthProviderConfig, OAUTH_ENDPOINTS,
} from './membership/oauth-core.js';
import { classifyMembershipEvent, membershipFromEvent } from './membership/events.js';
import { normalizeMembership } from './membership/ledger.js';
import {
  fixturesAvailable, fixtureKeyMatches, fixtureAccessGranted,
  requestedFixtureId, fixtureProfile, fixtureIds,
} from './membership/fixture-gate.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = String(process.env.HOST || '127.0.0.1').trim();
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const ELEVENLABS_VOICE_NAME = process.env.ELEVENLABS_VOICE_NAME || 'Adam';
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_22050_32';
const COMPAT_TTS_MODEL = process.env.OPENAI_COMPATIBLE_TTS_MODEL || OPENAI_TTS_MODEL;
const COMPAT_TTS_VOICE = process.env.OPENAI_COMPATIBLE_TTS_VOICE || OPENAI_TTS_VOICE;
const ASSIST_PROVIDER_ORDER = (process.env.ASSIST_PROVIDER_ORDER || 'groq,openrouter,openai')
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);
const TTS_PROVIDER_ORDER = (process.env.TTS_PROVIDER_ORDER || 'elevenlabs,openai,compatible')
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || 'https://gaiahealers.app/home.html').trim();
const PROXY_PUBLIC_URL = (process.env.PROXY_PUBLIC_URL || 'https://api.gaiahealers.app').trim().replace(/\/+$/, '');
const GHL_CLIENT_PORTAL_BASE_URL = (process.env.GHL_CLIENT_PORTAL_BASE_URL || 'https://education.gaiahealers.com').trim().replace(/\/+$/, '');
const AUTH_SESSION_COOKIE = process.env.AUTH_SESSION_COOKIE || 'gaia_member_session';
const AUTH_SESSION_TTL_SECONDS = Math.min(
  Math.max(Number(process.env.AUTH_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7) || (60 * 60 * 24 * 7), 900),
  60 * 60 * 24 * 30,
);
const AUTH_MAGIC_LINK_TTL_SECONDS = Math.min(Math.max(Number(process.env.AUTH_MAGIC_LINK_TTL_SECONDS || 900) || 900, 300), 3600);
const CONSUMED_MAGIC_LINKS = new Map();
const MAGIC_LINK_REQUESTS = new Map();
// Pending magic-link polls. Lets an installed PWA establish its OWN session even
// when the emailed link opened in a separate browser context (iOS PWA cookie
// isolation): the app polls this, and the session cookie is minted on the poll
// request itself, landing in the PWA's context. pollId -> { verified, member, exp }.
const MAGIC_LINK_POLLS = new Map();
const MAGIC_LINK_POLL_TTL_MS = 10 * 60 * 1000;
function cleanupMagicPolls(now) {
  for (const [id, entry] of MAGIC_LINK_POLLS) { if (entry.exp <= now) MAGIC_LINK_POLLS.delete(id); }
  if (MAGIC_LINK_POLLS.size > 20000) MAGIC_LINK_POLLS.clear();
}
const AUTH_ALLOW_DEBUG_LINKS = process.env.AUTH_ALLOW_DEBUG_LINKS === 'true';
const AUTH_ALLOW_UNVERIFIED_EMAIL_MAGIC_LINK = process.env.AUTH_ALLOW_UNVERIFIED_EMAIL_MAGIC_LINK === 'true';
const AUTH_EMBED_SHARED_SECRET = process.env.AUTH_EMBED_SHARED_SECRET || process.env.APP_PROXY_SHARED_SECRET || '';
// Legacy embedded auto-claim accepts a static bearer plus a caller-selected
// contact id. It remains off unless an operator explicitly re-enables it while
// migrating to a signed, per-user SSO assertion. Magic-link/OAuth auth remains.
const AUTH_ALLOW_LEGACY_EMBEDDED_CLAIM = String(process.env.AUTH_ALLOW_LEGACY_EMBEDDED_CLAIM || '').trim() === '1';
const AUTH_TRUSTED_REFERRERS = (process.env.AUTH_TRUSTED_REFERRERS || 'https://crm.gaiahealers.com,https://education.gaiahealers.com')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const AUTH_ALLOWED_LOCATION_IDS = new Set(
  [
    process.env.GHL_LOCATION_ID,
    'WkKl1K5RuZNQ60xR48k6',
    'hPqC08CFLJmUALiMjHir',
  ].filter(Boolean),
);

// No event details are hardcoded here. When the Event Manager cannot be reached
// the app must show its empty state, not a remembered event that reads as live.
const EMPTY_EVENT = {
  id: null,
  name: '',
  date: '',
  startDate: null,
  endDate: null,
  description: '',
  venue: '',
  location: '',
  timezone: 'UTC',
  startAt: null,
  endAt: null,
  serverTime: null,
  heroImageUrl: '',
  registrationUrl: '',
  registrationLabel: '',
  sourceUrl: '',
  source: 'unavailable',
  liveData: false,
  stats: { attendees: 0, paidMembers: 0, checkedIn: 0, exhibitors: 0, leads: 0, sessions: 0, speakers: 0, checkInRate: 0 },
};

const FALLBACK_GAIA = {
  members: 0,
  portalUrl: 'https://education.gaiahealers.com',
  event: EMPTY_EVENT,
};

const FALLBACK_ACADEMY = {
  ok: true,
  configured: false,
  liveData: false,
  source: 'unavailable-without-member-session',
  generatedAt: '',
  member: {
    name: 'Gaia Healers member',
    email: '',
    portalUrl: 'https://education.gaiahealers.com',
  },
  summary: {
    enrolled: 0,
    completed: 0,
    inProgress: 0,
    averageProgress: 0,
    nextCourseTitle: 'Open your secure Academy workspace',
    nextLessonTitle: 'Member login unlocks your lessons and course progress',
    nextLessonUrl: 'https://education.gaiahealers.com',
    ceCreditsEarned: 0,
    ceCreditsRequired: 0,
  },
  activeCourseId: '',
  courses: [],
  credentials: [],
  requirements: {
    title: 'Member login required',
    description: 'GHL does not expose course progress through its public API.',
    scansCompleted: 0,
    scansRequired: 0,
    courseRequiredPercent: 0,
    currentCoursePercent: 0,
  },
};

const FALLBACK_MEMBER_HUB = {
  ok: true,
  configured: false,
  liveData: false,
  source: 'unavailable-without-member-session',
  generatedAt: '',
  member: {
    displayName: 'Gaia Healers member',
    role: 'Member',
    cohort: '',
    portalUrl: 'https://education.gaiahealers.com',
  },
  portal: {
    url: 'https://education.gaiahealers.com',
    users: 0,
    invited: 0,
    adminSections: ['Client Portal', 'Courses', 'Communities', 'Credentials', 'Gokollab Marketplace'],
    actions: ['Generate magic link', 'Invite to client portal', 'Send login email'],
  },
  dashboard: {
    welcomeTitle: 'Your Gaia Healers dashboard is ready',
    welcomeDetail: 'Courses, communities, live sessions, credentials, and products from GHL Memberships.',
    nextLessonTitle: 'Open your secure Academy workspace',
    nextLessonUrl: '',
    nextMeetingTitle: '',
    nextMeetingTime: '',
    eventPassTitle: '',
    eventPassDetail: 'Open the confirmed event details',
    ceCreditsEarned: 0,
    ceCreditsRequired: 0,
    topCourse: '',
    topCourseMeta: '',
    revenueGenerated: '',
    averageOrderValue: '',
    totalCheckouts: 0,
  },
  communities: [],
  discussions: [],
  events: [],
  members: [],
  newsletters: [],
  products: [],
  meetings: [],
  /* Community feeds, course progress, credentials, purchases, and member
     activity must come from an authenticated source. They intentionally have
     no production fallback. */
  /* Community feeds, progress, credentials, purchases, and member activity\n     intentionally have no unauthenticated production fallback. */
  marketplace: {
    enabled: true,
    provider: 'Gokollab Marketplace',
    status: 'activation',
    note: 'Digital products, device bundles, and member checkout routes live inside GHL Memberships.',
  },
  access: {
    notes: [
      'Member login should use GHL Client Portal or a backend-generated magic link.',
      'Lessons, certificates, purchases, and private records stay behind the proxy and verified member session.',
      'Discussion, events, product previews, and course guidance can stay inside the embedded app shell.',
    ],
  },
};

const GAIA_KNOWLEDGE = {
  brand: 'Gaia Healers — a holistic wellness network combining biofield / energy-science devices, practitioner certification, a member community, live events, and a wellness store. Founded by Dr. Nima Farshid.',
  founder: 'Official Gaia Healers sources describe Dr. Nima Farshid as Gaia Healers’ founder, a doctor of natural medicine, software engineer, and Bio-Well educator whose work connects biofield technology, practitioner education, community, and live events. His research interests include people, places, and water. Never use his story or titles to turn a symbolic horoscope into a medical claim; offer verified education, booking, device-measurement, community, and event routes as optional next steps.',
  publicWebsite: 'https://gaiahealers.com',
  clientPortal: 'https://education.gaiahealers.com',
  practitionerDirectory: 'https://gaiapractitioners.com',
  ecosystem: [
    'gaiahealers.app — THIS member app (where Gaia Assist lives).',
    'gaiahealers.com — the Shopify store: Bio-Well and devices, Colour Energy chakra sprays, crystals, malas, courses, and event tickets. Checkout happens on Shopify.',
    'education.gaiahealers.com — the course + community portal (GoHighLevel). Course videos and community discussions live here and it has its own login.',
    'gaiapractitioners.com — the Find-a-Practitioner directory.',
    'elevate.gaiahealers.com — the Elevate conference site.',
    'join.gaiahealers.com/membership — the official Gaia 2.0 Practitioners membership page and enrolment destination.',
  ],
  crm: {
    observedLocationId: 'WkKl1K5RuZNQ60xR48k6',
    configuredLocationId: process.env.GHL_LOCATION_ID || '',
    embeddedAppUrl: 'https://gaiahealers.app/home.html?embedded=ghl',
    embeddedRule: 'When the app is embedded in GHL, keep people inside the Gaia Healers app: The bottom bar has six sections: Today (daily dashboard), Energy (energy check, horoscope, chakras, numerology, colour test, today sky, Bio-Well), Academy (courses, certifications, library), Community (circles/discussions, Find a Healer, Schedule with Dr. Nima, Book a session, Events, Gaia Radio, Messages), Shop (the live store), and You (account, access, bookings, memberships, become-a-practitioner), plus the centre Gaia Assist button. Only send them to education.gaiahealers.com for actual course videos, community discussions, or portal login.',
  },
  services: [
    'Certification and training on biofield devices: Bio-Well, BioPulsar, BioTekna, HealeeX.',
    'A practitioner community and mentorship.',
    'Live events, including the annual Elevate conference.',
    'A wellness store (energy sprays, crystals, devices, courses).',
    'In-app wellness tools: a birth-chakra reading, a daily body-point and wellness horoscope, an 8-week chakra challenge, and a colour personality test.',
    'Session booking: Bio-Well energy scans, Bio-Well demos, a free discovery call, and wellness coaching.',
    'A directory to find certified practitioners.',
    'Public resources from gaiahealers.com: product collections, Bio-Well research, practitioner certification requests, blogs, affiliate access, Bio-Well demos, GaiaPractitioners CRM/software/marketplace, education, community, contact, and Dr. Nima’s story.',
  ],
  publicResources: [
    'Live store and product collections: https://gaiahealers.com/collections — includes Bio-Well, BioPulsar, BioTekna, Colour Energy, courses, crystals, HealeeX, water, sound, supplements and other current collections. Prices and availability must be checked live; never quote a remembered price as current.',
    'Bio-Well demo booking: https://api.leadconnectorhq.com/widget/bookings/bio-welldemo.',
    'Find a Practitioner directory: https://gaiapractitioners.com.',
    'Bio-Well research: https://gaiahealers.com/pages/bio-well-research.',
    'Gaia Healers articles and wellness insights: https://gaiahealers.com/blogs/news.',
    'Free community and ecosystem orientation: https://join.gaiahealers.com/.',
    'Practitioner education and community portal: https://education.gaiahealers.com.',
    'Bio-Well Level 1 certificate request: https://form.jotform.com/250512881268055.',
    'Affiliate registration: https://af.uppromote.com/gaia/register.',
    'Practitioner CRM, software and marketplace: https://gaiapractitioners.com and https://nextlevel.gaiahealers.com.',
    'Contact Gaia Healers: https://gaiahealers.com/pages/contact-us.',
    'Elevate Conference: https://elevate.gaiahealers.com.',
    'Dr. Nima Farshid and Gaia Healers’ biofield education story: https://gaiahealers.com and https://workshop.gaiahealers.com/.',
  ],
  devices: [
    'Bio-Well 3.0 — biofield / GDV imaging for stress and energy assessment (plus Sputnik, Glove, Water Sensor, and Bio Cor accessories).',
    'BioPulsar — aura and chakra imaging.',
    'BioTekna — nervous-system and stress mapping.',
    'HealeeX — practitioner device and protocol.',
    'Colour Energy chakra sprays, crystals, malas, and other wellness tools.',
  ],
  communities: [
    'All Gaia Healers', 'Bio-Well Practitioners', 'BioPulsar Practitioners', 'BioTekna Practitioners', 'ASEA', 'BrainTap', 'LifeWave', 'Golden Practitioner',
  ],
  memberships: 'The official Gaia 2.0 Practitioners membership has four tiers: Free ($0 forever, enrol at https://join.gaiahealers.com/onboarding), Silver ($97/month or $997/year, enrol at https://join.gaiahealers.com/silver), Gold ($497/month or $4,997/year, enrol at https://join.gaiahealers.com/gold), and Diamond ($997/month or $9,997/year, enrol at https://join.gaiahealers.com/diamond). Benefits expand from community resources through education, directory exposure, software/CRM, implementation support, lead generation, accelerator benefits, and early-access opportunities. Each tier must open its own exact enrolment page inside the app.',
  courses: [
    'Bio-Well Orientation, Basic Certification, Advanced Level 1, and Advanced Level 2',
    'BioPulsar Basic Technical & Business',
    'BioTekna trainings',
    'HealeeX getting started',
    'Members now WATCH their entitled courses natively IN THE APP under Academy — Your courses lists what they own and the video plays inside Gaia (no portal), with progress and resume tracked. Free courses open for everyone. Course access comes from their GHL offers, bundles, purchases, and enrolments, not from a tier, price, or interest tag. Only lessons hosted on the owner-hosted domain-locked YouTube, or courses not yet mirrored, still open in the education.gaiahealers.com portal.',
  ],
  // No event is described here. Event facts come from the Event Manager at
  // request time via gaiaKnowledgePrompt(event) — this app runs many events.
  app: {
    shell: 'The app is gaiahealers.app (home.html). The bottom bar, left to right, is: Today, Energy, Academy, the centre Gaia Assist button, Community, Shop, You. The top-right menu is a small overflow with Membership, Meet the Founder and Member sign in — every other feature is a bottom tab or lives inside one of the six hubs.',
    screens: [
      'Today (view=today): the daily dashboard — daily energy, streak, next event, continue learning and next booking, with quick actions into the hubs.',
      'Find a Healer (view=directory): the in-app practitioner directory built from real gaiapractitioners.com data, with map and profiles; reached from Community > Connect.',
      'Events (view=events): the confirmed public Gaia Healers event plus authenticated member appointments; unavailable community live-session feeds are never invented.',
      'Bookings (view=bookings): real GHL appointments plus verified Gaia Healers booking forms.',
      'Inbox (view=inbox): read-only GHL conversation summaries for the authenticated contact.',
      'Energy (view=wellness): the wellness & self-discovery hub. It hosts three core public tools, plus the Colour Personality Test, a Numerology calculator, Today’s Sky and Bio-Well research. Energy Check (tab=check) uses an easy Month / Day / typed 4-digit Year form—never a long calendar scroll—to reveal a birth-date-number chakra and sun-sign reflection before sign-up. Worldwide birth-city autocomplete resolves the city and time zone; an optional birth time then powers a seven-planet sky-to-chakra map calculated with Astronomy Engine. It shows actual astronomical sign placements, a symbolic Gaia chakra spotlight, the most represented element, and an element to gently invite. The result now becomes a Gaia Energy Path: a two-minute practice, a balancing element invitation, a journal question, matching Colour Energy support, and verified routes to Bio-Well sessions, Dr. Nima, community, and Elevate. Planet details remain available in a disclosure. If birth time is unknown it uses local noon and labels the result as an estimate. Wellness Horoscope (tab=horoscope) adds a reflective daily practice and journal question. Chakra Match (tab=chakras) is an interactive seven-centre guide with traditional themes, practices, prompts, and relevant Colour Energy support. These are symbolic wellness reflection tools, not medical advice, predictions, device scans, or measured chakra scores.',
      'Academy (view=academy): courses, certifications and a Library of articles & research. For a signed-in member it lists the courses they are actually entitled to; opening one takes them into their course library on education.gaiahealers.com for the lessons. It never shows fake progress.',
      'Community (view=community): the connection hub — Connect (Find a Healer, Schedule with Dr. Nima, Book a session), your unlocked circles/discussions ("My Access" — which communities you have unlocked versus still locked — plus Find a Practitioner. Communities: All Gaia Healers, Bio-Well, BioPulsar, BioTekna, ASEA, BrainTap, LifeWave, Golden Practitioner.',
      'Store (view=store): two tabs — Shop (the live Shopify catalogue by category: Featured, Colour Energy, Courses, Bio-Well, BioPulsar, BioTekna, Crystals; tapping a product opens its image, description, and purchase action in a native in-app sheet; Shopify opens only for the final current-price and secure-payment step) and Membership (the official Free / Silver / Gold / Diamond Gaia 2.0 tiers).',
      'You (view=profile): your account — Member Pass, membership plans, my access, my bookings, my events, my communities, an adaptive For Practitioners section (become a practitioner / practitioner tools), and settings.',
    ],
    features: [
      'Energy Check — free at view=wellness&tab=check; choose a month and type the day and 4-digit year to see a birth-date-number chakra, sun-sign reflection, gentle practice, journal prompt, and relevant Gaia Healers support. Saving the profile unlocks today’s body point and challenge practice.',
      'Wellness Horoscope — free at view=wellness&tab=horoscope; type and select a worldwide birth city, optionally add birth time, and receive a seven-planet sky-to-chakra map plus a personal Gaia Energy Path. Gaia Assist can turn it into a gentle 7-day plan and explain optional verified routes to Colour Energy, a Bio-Well scan or demo, Dr. Nima, community, and Elevate. The astronomy placements are calculated; the chakra interpretation is symbolic and not a prediction or measurement.',
      'Chakra Match — free at view=wellness&tab=chakras; an interactive seven-centre guide with traditional themes, two-minute practices, journal prompts, and matching Colour Energy support. It deliberately shows no fake percentages or scan scores.',
      'Wellness sign-up (name, birth date, location, email) — unlocks your daily body-point and a daily wellness horoscope tip.',
      '8-Week Chakra Challenge — join, then check in daily; one chakra per week with a practice and an affirmation.',
      'Book a session — a Bio-Well energy scan, a Bio-Well demo, a free discovery call, or wellness coaching (real booking links).',
      'Colour Personality Test — 5 questions reveal your chakra colour and suggest the matching Colour Energy spray.',
      'Find a Healer — the in-app practitioner directory (view=directory), reached from Community; real gaiapractitioners.com data with map and profiles.',
    ],
    navigation: 'To guide someone, use the exact current structure: bottom bar Today, Energy, Academy, Gaia Assist, Community, Shop, You; a small overflow menu with Membership, Meet the Founder and sign-in. Deep links: home.html?view=today|academy|community|events|bookings|inbox|directory|wellness|store|profile. Energy tabs: &tab=check|horoscope|chakras. Store tabs: &tab=shop|membership. Keep people inside the app: course videos now PLAY natively in Academy (no portal). Only send them to education.gaiahealers.com for community discussions, portal-only courses, or portal login.',
    tasks: [
      'Watch a course / see my videos: Academy tab shows "Your courses" (what they own) — tap a course and the videos play natively in the app. I can also open a specific course for them.',
      'Find more / free courses: Academy > "Explore more courses". Free-tagged courses open for everyone.',
      'Daily energy: the Today tab shows their Daily Energy reading and streak.',
      'Energy or body-point check: Energy tab > Check.',
      'Chakra reading / match: Energy tab > Chakras (a birth-date reading; adding birth time + place gives a fuller chart).',
      'Wellness horoscope: Energy tab > Horoscope. Numerology, Colour personality test, Today sky and Bio-Well also live under Energy.',
      'Find a practitioner / healer: Community > Find a Healer (the in-app directory with map and profiles).',
      'Book a session: I can open the booking for a Bio-Well scan, a demo, a free discovery call, wellness coaching, or a 1:1 with Dr. Nima.',
      'Messages: Community > Messages (the inbox).',
      'Events: the Events screen shows the current gathering with agenda and speakers; register from there.',
      'Circles / discussions / members / Gaia Radio: all under Community.',
      'Shop products (sprays, crystals, devices, courses): Store > Shop (checkout finishes on Shopify).',
      'Join or upgrade membership: Store > Membership, or I hand them the exact activation link for Free, Silver, Gold or Diamond.',
      'Account, access, bookings, my communities, become-a-practitioner: the You tab.',
      'Get certified / be a listed practitioner: a membership path (Silver and up) plus a certification request — I can guide them and open the right page.',
      'Personalize my experience: I can run a quick 2-minute getting-to-know-you so Gaia tailors everything to them.',
    ],
  },
  signIn: 'In-app sign-in: on Home use Member access, or open the top Menu and tap Member sign in. Enter your member email and receive a one-tap sign-in link by email; tapping it signs you into your member area. Course videos and community discussions live in the separate education.gaiahealers.com portal, which has its own login.',
  safety: [
    'Do not diagnose or make medical claims; give wellness guidance only.',
    'Never claim you saved, booked, bought, emailed, checked in, or changed anything — explain how the member can do it.',
    'Never invent course progress, scan numbers, community posts, prices, or personal history.',
    'Do not expose private system tokens or any other member data.',
  ],
};

let _lastPublishedEvent = null;

function gaiaKnowledgePrompt(event) {
  const K = GAIA_KNOWLEDGE;
  event = event || _lastPublishedEvent;
  // Whatever the Event Manager currently publishes, described in its own words.
  const eventLine = event && event.name
    ? `Current event: ${event.name}${event.date ? ` — ${event.date}` : ''}`
      + `${event.venue ? `, ${event.venue}` : ''}.`
      + `${event.description ? ` ${String(event.description).slice(0, 400)}` : ''}`
      + ' Say only what this states; if asked something it does not cover, open the event page rather than inventing detail.'
    : 'No event is currently published. Say so plainly rather than describing a past or expected one.';
  return [
    `About Gaia Healers: ${K.brand}`,
    `About Dr. Nima Farshid: ${K.founder}`,
    `Ecosystem (these are different sites — do not confuse them):\n- ${K.ecosystem.join('\n- ')}`,
    `What Gaia Healers offers:\n- ${K.services.join('\n- ')}`,
    `Verified public resources:\n- ${K.publicResources.join('\n- ')}`,
    `Devices & products:\n- ${K.devices.join('\n- ')}`,
    `Communities (8): ${K.communities.join(', ')}.`,
    `Membership: ${K.memberships}`,
    `Courses: ${K.courses.join('; ')}.`,
    eventLine,
    `The app: ${K.app.shell}`,
    `Screens:\n- ${K.app.screens.join('\n- ')}`,
    `Key features:\n- ${K.app.features.join('\n- ')}`,
    `Navigation: ${K.app.navigation}`,
    `How to do things in the app (guide them step by step, then take them there):\n- ${K.app.tasks.join('\n- ')}`,
    `Sign-in: ${K.signIn}`,
    `Embedded-in-GHL rule: ${K.crm.embeddedRule}`,
    `Safety rules: ${K.safety.join(' ')}`,
  ].join('\n');
}

function corsHeaders(origin) {
  const allowOrigin = origin
    ? (ALLOWED_ORIGINS.includes(origin) ? origin : 'null')
    : '*';
  const allowCredentials = Boolean(origin && allowOrigin !== 'null');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Academy-Secret',
    'Access-Control-Expose-Headers': 'X-Gaia-Voice-Provider,X-Gaia-Voice-Model,X-Gaia-Voice-Name,X-Gaia-Voice-Max-Seconds',
    ...(allowCredentials ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    'Vary': 'Origin',
  };
}

function sendJson(res, status, data, origin, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
    ...extraHeaders,
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendBuffer(res, status, buffer, contentType, origin, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
    ...extraHeaders,
  });
  res.end(buffer);
}

// ── Dynamic course catalog (synced from GHL via webhook) ─────────────────
// GHL has no public Courses/LMS API, so we receive the course catalog from a
// daily GHL workflow that pushes it here. The data is stored to disk so it
// survives restarts, and served at GET /api/courses for the app to render.
const COURSES_FILE = path.join(process.cwd(), 'data', 'courses.json');
const COURSES_SYNC_SECRET = String(process.env.COURSES_SYNC_SECRET || '').trim();
const MEMBER_ENTITLEMENTS_FILE = String(process.env.MEMBER_ENTITLEMENTS_FILE || path.join(process.cwd(), 'data', 'member-entitlements.json')).trim();
// Explicit product -> membership/course mapping (the Event-style discipline for
// entitlements): a paid product decides the entitlement, never the webhook body.
const ENTITLEMENT_MAP_FILE = String(process.env.ENTITLEMENT_MAP_FILE || path.join(process.cwd(), 'data', 'entitlement-product-mappings.json')).trim();
function loadEntitlementProductMappings() {
  try { return JSON.parse(fs.readFileSync(ENTITLEMENT_MAP_FILE, 'utf8')); } catch (_) { return { version: 1, products: {} }; }
}
// Product classification registry + a review store so a paid product that is
// not explicitly classified is never silently lost — it surfaces for an admin.
const PRODUCT_REGISTRY_FILE = path.join(process.cwd(), 'data', 'product-registry.json');
const PAYMENT_REVIEW_FILE = path.join(process.cwd(), 'data', 'payment-review.json');
const INTENTIONAL_CLASSES = new Set(['EVENT_TICKET','EVENT_UPGRADE','EVENT_ADDON','MEMBERSHIP_SUBSCRIPTION','PHYSICAL_PRODUCT','SPONSOR','SERVICE','COURSE','NON_ENTITLEMENT']);
function loadProductRegistry() { try { return JSON.parse(fs.readFileSync(PRODUCT_REGISTRY_FILE,'utf8')); } catch(_){ return {version:1,products:{}}; } }
function recordEntitlementReview(productIds, orderId) {
  const reg = (loadProductRegistry().products)||{};
  let store; try { store = JSON.parse(fs.readFileSync(PAYMENT_REVIEW_FILE,'utf8')); } catch(_){ store = { version:1, items:{} }; }
  const now = new Date().toISOString(); let changed=false;
  for (const pid of (productIds||[])) {
    const entry = reg[pid];
    if (entry && INTENTIONAL_CLASSES.has(entry.classification)) continue; // intentional non-event: not a gap
    const it = store.items[pid] || { product_id: pid, name: (entry&&entry.name)||null, classification: (entry&&entry.classification)||'UNKNOWN', count:0, first_seen: now };
    it.count += 1; it.last_seen = now; it.last_order = orderId||null; store.items[pid]=it; changed=true;
  }
  if (changed) { try { writeJsonAtomic(PAYMENT_REVIEW_FILE, store); } catch(_){} }
}
const GHL_WORKFLOW_WEBHOOK_SECRET = String(process.env.GHL_WORKFLOW_WEBHOOK_SECRET || COURSES_SYNC_SECRET).trim();
const GHL_BACKFILL_SECRET = String(process.env.GHL_BACKFILL_SECRET || GHL_WORKFLOW_WEBHOOK_SECRET).trim();
const GHL_WEBHOOK_ED25519_PUBLIC_KEY = normalizeEd25519PublicKey(process.env.GHL_WEBHOOK_ED25519_PUBLIC_KEY);
// Once real signed deliveries are observed on every event source, set this to
// reject a delivery whose signature does not verify instead of falling back.
const GHL_WEBHOOK_ED25519_STRICT = String(process.env.GHL_WEBHOOK_ED25519_STRICT || '').trim() === '1';

/** Accept the key as bare base64 DER (as GHL publishes it) or as full PEM. */
function normalizeEd25519PublicKey(value) {
  const raw = String(value || '').replace(/\\n/g, '\n').trim();
  if (!raw) return '';
  if (raw.includes('BEGIN PUBLIC KEY')) return raw;
  return `-----BEGIN PUBLIC KEY-----\n${raw}\n-----END PUBLIC KEY-----\n`;
}
if (COURSES_SYNC_SECRET.length < 32) {
  throw new Error('COURSES_SYNC_SECRET must be set and at least 32 characters.');
}
if (GHL_BACKFILL_SECRET.length < 32) {
  throw new Error('GHL_BACKFILL_SECRET must be set and at least 32 characters.');
}
let _coursesCache = null;
let _memberEntitlementsCache = null;
let _memberEntitlementsMtimeMs = 0;

function safeSecretEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ensureCoursesDataDir() {
  const dir = path.dirname(COURSES_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
}

function writeJsonAtomic(file, payload) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

// ── Access confirmations ──────────────────────────────────────────────────
// observed_at = when an entitlement last CHANGED (ingest). confirmed_at = when
// we last SUCCESSFULLY read the member live from GHL (state still current).
// The stale/degraded banner is driven by confirmed_at, so a stable entitlement
// that simply hasn't changed does not read as stale while GHL is healthy. Kept
// in a small side store (not the entitlement ledger) to avoid ledger churn and
// read-modify-write races; persisted on a debounced timer.
const MEMBER_CONFIRMATIONS_FILE = String(process.env.MEMBER_CONFIRMATIONS_FILE
  || path.join(path.dirname(MEMBER_ENTITLEMENTS_FILE), 'member-confirmations.json')).trim();
const CONFIRM_DEBOUNCE_MS = 10 * 60 * 1000; // stamp a contact at most every 10 min
const _confirmations = new Map();
let _confirmationsDirty = false;
try {
  const obj = JSON.parse(fs.readFileSync(MEMBER_CONFIRMATIONS_FILE, 'utf8')) || {};
  for (const [cid, iso] of Object.entries(obj)) {
    const ms = Date.parse(iso);
    if (cid && Number.isFinite(ms)) _confirmations.set(cid, ms);
  }
} catch (_) { /* first run: no confirmations file yet */ }
function recordConfirmation(contactId) {
  if (!contactId) return;
  const prev = _confirmations.get(contactId) || 0;
  if (Date.now() - prev < CONFIRM_DEBOUNCE_MS) return; // debounced: no write on every request
  _confirmations.set(contactId, Date.now());
  _confirmationsDirty = true;
}
function confirmationIso(contactId) {
  const ms = contactId ? _confirmations.get(contactId) : 0;
  return ms ? new Date(ms).toISOString() : null;
}
setInterval(() => {
  if (!_confirmationsDirty) return;
  _confirmationsDirty = false;
  try {
    writeJsonAtomic(MEMBER_CONFIRMATIONS_FILE,
      Object.fromEntries([..._confirmations].map(([k, v]) => [k, new Date(v).toISOString()])));
  } catch (err) { console.error('[Gaia Confirmations] persist failed', err.message); }
}, 60 * 1000).unref();

const STORE_CATALOG_FILE = process.env.STORE_CATALOG_FILE
  || path.join(path.dirname(MEMBER_ENTITLEMENTS_FILE), 'store-catalog.json');
const SHOPIFY_STOREFRONT = process.env.SHOPIFY_STOREFRONT_URL || 'https://gaiahealers.com';
const STORE_SYNC_INTERVAL_MS = Number(process.env.STORE_SYNC_INTERVAL_MS) || 24 * 60 * 60 * 1000;
let _storeCatalogCache = null;

function loadStoreCatalog() {
  if (_storeCatalogCache) return _storeCatalogCache;
  try { _storeCatalogCache = JSON.parse(fs.readFileSync(STORE_CATALOG_FILE, 'utf8')); }
  catch (_) { _storeCatalogCache = emptyCatalog(); }
  return _storeCatalogCache;
}

function saveStoreCatalog(catalog) {
  writeJsonAtomic(STORE_CATALOG_FILE, catalog);
  _storeCatalogCache = catalog;
}

/**
 * Read the public Shopify catalogue.
 *
 * Public storefront JSON only — no credentials, no admin scopes, nothing that
 * could mutate the shop. Shopify remains the authority for price and checkout;
 * this is Gaia keeping a copy of the shelf so the app can browse it.
 */
const STORE_MARKET = process.env.STORE_MARKET_COUNTRY || 'US';

async function fetchShopifyCatalogue({ maxPages = 6, pageSize = 250 } = {}) {
  const products = [];
  for (let page = 1; page <= maxPages; page += 1) {
    // The market is pinned. Shopify Markets otherwise serves whichever currency
    // suits the caller's location — this proxy sits in Germany, and an
    // unpinned fetch returned EUR prices that would have been rendered as
    // dollars. products.json carries no currency field, so nothing downstream
    // could have caught it.
    const url = `${SHOPIFY_STOREFRONT}/products.json?limit=${pageSize}&page=${page}&country=${STORE_MARKET}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`shopify ${response.status}`);
    const batch = await response.json();
    const list = Array.isArray(batch?.products) ? batch.products : [];
    products.push(...list);
    if (list.length < pageSize) break;
  }
  return products;
}

/**
 * Confirm the market actually gave us the currency we asked for.
 *
 * Pinning the country is a request, not a guarantee, and the feed cannot tell
 * us what it answered with. So one product is checked against its own retail
 * page, which does declare a currency, and the price must agree to the cent.
 * If it does not, prices are marked unverified and the store shows none rather
 * than showing a number that will not match checkout.
 */
async function verifyCatalogueCurrency(products) {
  const sample = products.find((p) => p?.handle && Number(p?.variants?.[0]?.price) > 0);
  if (!sample) return { verified: false, reason: 'no_sample' };
  try {
    const response = await fetch(
      `${SHOPIFY_STOREFRONT}/products/${sample.handle}?country=${STORE_MARKET}`,
    );
    if (!response.ok) return { verified: false, reason: `page_${response.status}` };
    const html = await response.text();
    const currency = (html.match(/"currency":"([A-Z]{3})"/) || [])[1] || null;
    const cents = Number((html.match(/"price":(\d{3,})/) || [])[1] || NaN);
    const feedCents = Math.round(Number(sample.variants[0].price) * 100);
    const matches = Number.isFinite(cents) && cents === feedCents;
    return {
      verified: Boolean(currency) && matches,
      currency,
      reason: matches ? 'ok' : `price_mismatch_feed_${feedCents}_page_${cents}`,
      sample: sample.handle,
    };
  } catch (error) {
    return { verified: false, reason: 'verify_failed' };
  }
}

/**
 * One sync pass. Never throws into the caller: a Shopify outage must leave the
 * existing catalogue standing rather than take the store down with it.
 */
async function runStoreSync({ reason = 'scheduled' } = {}) {
  try {
    const fetched = await fetchShopifyCatalogue();
    if (!fetched.length) {
      console.log('[Gaia Store] sync returned no products; keeping the existing catalogue');
      return { ok: false, reason: 'empty_response' };
    }
    const check = await verifyCatalogueCurrency(fetched);
    if (!check.verified) {
      console.log(`[Gaia Store] currency unverified (${check.reason}); prices will be withheld`);
    }
    const { catalog, diff } = syncCatalog(loadStoreCatalog(), fetched, {
      now: new Date(),
      currency: check.currency || null,
      market: STORE_MARKET,
      priceVerified: check.verified,
    });
    saveStoreCatalog(catalog);
    const messages = diffMessages(diff);
    if (messages.length) {
      console.log(`[Gaia Store] sync (${reason}):`, messages.slice(0, 12).join(' | '));
    }
    try {
      const ledger = loadMemberEntitlements();
      for (const message of messages.slice(0, 40)) {
        recordAudit(ledger, { actor: 'store-sync', source: 'shopify', action: 'store.sync', note: message });
      }
      if (messages.length) saveMemberEntitlements(ledger);
    } catch (_) { /* the audit is a courtesy, never a reason to fail a sync */ }
    return { ok: true, diff, currency: check.currency, priceVerified: check.verified, counts: {
      products: Object.keys(catalog.products).length,
      added: diff.added.length, priceChanged: diff.priceChanged.length, unobserved: diff.unobserved.length,
    } };
  } catch (error) {
    console.error('[Gaia Store] sync failed:', error.message.split('\n')[0]);
    return { ok: false, reason: 'fetch_failed' };
  }
}

function emptyEntitlementStore() {
  return { version: 1, contacts: {}, processedWebhookIds: [], updatedAt: null };
}

function loadMemberEntitlements() {
  try {
    const mtimeMs = fs.statSync(MEMBER_ENTITLEMENTS_FILE).mtimeMs;
    if (_memberEntitlementsCache && mtimeMs === _memberEntitlementsMtimeMs) return _memberEntitlementsCache;
    const parsed = JSON.parse(fs.readFileSync(MEMBER_ENTITLEMENTS_FILE, 'utf8'));
    const base = {
      ...emptyEntitlementStore(), ...parsed,
      contacts: parsed?.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {},
      processedWebhookIds: Array.isArray(parsed?.processedWebhookIds) ? parsed.processedWebhookIds : [],
    };
    // Bring the document up to the ledger schema in memory only. A read must
    // never rewrite the store: the new shape reaches disk the next time a
    // webhook saves, so a bad deploy can be rolled back with the file intact.
    const { store, report } = migrateStore(base);
    if (report.changed || report.failed.length || report.fixturesSkipped.length) {
      console.log('[Gaia Ledger] migrated in memory', {
        total: report.total, changed: report.changed,
        failed: report.failed.length, fixturesSkipped: report.fixturesSkipped.length,
      });
    }
    _memberEntitlementsCache = store;
    _memberEntitlementsMtimeMs = mtimeMs;
  } catch (_) {
    _memberEntitlementsCache = emptyEntitlementStore();
    _memberEntitlementsMtimeMs = 0;
  }
  return _memberEntitlementsCache;
}

function saveMemberEntitlements(store) {
  store.updatedAt = new Date().toISOString();
  store.processedWebhookIds = uniqueStrings(store.processedWebhookIds || []).slice(-5000);
  writeJsonAtomic(MEMBER_ENTITLEMENTS_FILE, store);
  _memberEntitlementsCache = store;
  try { _memberEntitlementsMtimeMs = fs.statSync(MEMBER_ENTITLEMENTS_FILE).mtimeMs; } catch (_) { _memberEntitlementsMtimeMs = 0; }
}

function entitlementForContact(contactId) {
  const id = String(contactId || '').trim();
  if (!id) return null;
  const record = loadMemberEntitlements().contacts[id] || null;
  if (!record) return null;
  // Migrate on read, per contact, in memory. The webhook path writes the store
  // in its original shape and refreshes the cache, so a record can be newer
  // than the last store-wide migration — deriving here means a course granted
  // one second ago is already visible in the v2 entitlement list.
  try {
    return migrateContactRecord(record).record;
  } catch (err) {
    console.error('[Gaia Ledger] record migration failed', { contactId: id, error: err.message.split('\n')[0] });
    return record;
  }
}

function entitlementDomainTimestamp(record, domain) {
  const explicit = Date.parse(record?.domainUpdatedAt?.[domain] || '');
  if (Number.isFinite(explicit)) return explicit;
  if (domain === 'tier') return Date.parse(record?.tier?.updatedAt || '') || 0;
  if (domain === 'subscriptions') {
    return Math.max(0, ...(Array.isArray(record?.subscriptions) ? record.subscriptions : [])
      .map((item) => Date.parse(item?.updatedAt || item?.createdAt || '') || 0));
  }
  if (domain === 'courses' || domain === 'communities') {
    return Math.max(0, ...(Array.isArray(record?.[domain]) ? record[domain] : [])
      .map((item) => Date.parse(item?.updatedAt || '') || 0));
  }
  return 0;
}

function loadCourses() {
  if (_coursesCache) return _coursesCache;
  try {
    const raw = fs.readFileSync(COURSES_FILE, 'utf8');
    _coursesCache = JSON.parse(raw);
    return _coursesCache;
  } catch (_) {
    return { courses: [], syncedAt: null, source: 'none' };
  }
}

function saveCourses(payload) {
  ensureCoursesDataDir();
  _coursesCache = payload;
  try {
    fs.writeFileSync(COURSES_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[Gaia Courses] save failed', { error: err.message.split('\n')[0] });
  }
}

// Normalize whatever shape GHL sends into our canonical course object.
function normalizeCatalogCourse(c = {}) {
  const accessLevel = String(c.accessLevel || c.access_level || c.tier || '').toLowerCase();
  const price = Number(c.price);
  const memberCountRaw = Number(c.memberCount ?? c.members ?? c.enrolledCount ?? c.enrollment ?? c.students);
  return {
    id: String(c.id || c._id || c.productId || ''),
    title: String(c.title || c.name || 'Course'),
    description: String(c.description || c.desc || c.summary || ''),
    image: String(c.image || c.imageUrl || c.thumbnail || ''),
    category: String(c.category || c.track || c.group || ''),
    accessLevel: ['free', 'silver', 'gold', 'practitioner'].includes(accessLevel)
      ? accessLevel
      : (isFinite(price) && price > 0 ? 'silver' : 'free'),
    price: isFinite(price) ? price : 0,
    memberCount: isFinite(memberCountRaw) ? memberCountRaw : null,
    portalUrl: String(c.portalUrl || c.url || c.courseUrl || c.link || ''),
    order: Number(c.order) || 0,
    status: String(c.status || c.publicationStatus || '').trim().toLowerCase(),
    portalPublished: c.portalPublished === true || c.isPublished === true || c.published === true,
    availableInStore: c.availableInStore === true,
    processing: c.processing ?? null,
    deletedAt: String(c.deletedAt || c.deleted_at || ''),
    productType: String(c.productType || c.type || ''),
  };
}

function plainCourseDescription(value, maxLength = 220) {
  let text = String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|li|ul|ol|br|h[1-6]|blockquote|section|article)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLength) text = text.slice(0, maxLength).replace(/\s+\S*$/, '').trimEnd() + '…';
  return text;
}

function catalogCourseIsPublic(course = {}) {
  if (course.deletedAt) return false;
  if (/\b(demo|e2e)\b/i.test(String(course.title || ''))) return false; // never surface test/DEMO courses
  if (course.processing && !/^(false|complete|completed|ready)$/i.test(String(course.processing))) return false;
  if (course.status && !/^(active|published|live)$/i.test(course.status)) return false;
  return course.portalPublished || course.availableInStore;
}

async function enrichCatalogPublication(rawCourses = []) {
  const cfg = ghlConfig();
  if (!cfg.enabled || !rawCourses.length) return rawCourses;
  try {
    const products = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await ghlGet('/products/', {
        locationId: cfg.locationId,
        limit: 100,
        offset,
      });
      const items = Array.isArray(page?.products) ? page.products : [];
      products.push(...items);
      if (items.length < 100 || (Number.isFinite(Number(page?.total)) && products.length >= Number(page.total))) break;
    }
    const byId = new Map(products.map((product) => [String(product._id || product.id || ''), product]));
    return rawCourses.map((course) => {
      const id = String(course?.id || course?._id || course?.productId || '');
      const product = byId.get(id);
      if (!product) return course;
      return {
        ...course,
        status: product.status ?? course.status,
        availableInStore: product.availableInStore === true,
        processing: product.processing ?? course.processing ?? null,
        deletedAt: product.deletedAt || course.deletedAt || '',
        productType: product.productType || course.productType || '',
      };
    });
  } catch (error) {
    console.warn('[Gaia Courses] publication enrichment failed', { error: error.message.split('\n')[0] });
    return rawCourses;
  }
}

// Normalize a raw course title into a grouping key so payment variants of the
// same course collapse into one entry. e.g. "Bio-Well Advanced Level 1
// Certification (Payment over 4 months)" → "bio-well advanced level 1".
function courseGroupKey(title = '') {
  let t = String(title).toLowerCase().trim();
  // Strip payment-plan / variant noise.
  t = t.replace(/\(.*?(payment|installment|pay |month|st|nd|rd|th|recording|vip|zoom|in-person|virtual|online|recording|swag|free).*?\)/g, ' ');
  t = t.replace(/\b(payment|installment|1st|2nd|3rd|4th|st payment|nd payment|over \d+ months|recording|vip package|swag bag|second person|group)\b/g, ' ');
  // Strip event/prefix wrappers.
  t = t.replace(/^(events?\s*-\s*|learning\s*-\s*|in-person\s*-\s*|virtual\s*-\s*|online\s*-\s*)/g, ' ');
  // Collapse device bundles ("bio-well 3.0 + ...") → just the course part.
  t = t.replace(/(bio-well\s*\d\.\d.*?\+|device.*?\+)/g, ' ');
  // Collapse to canonical: remove punctuation, extra spaces.
  t = t.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// Human-friendly display title for a group (picks the shortest, cleanest name).
function cleanGroupTitle(group) {
  const names = group.map((c) => String(c.title || '').trim()).filter(Boolean);
  if (!names.length) return 'Course';
  // Prefer names that start with a capital letter and have no "(" suffix.
  const clean = names.filter((n) => /^[A-Z]/.test(n) && !/\b(payment|installment|1st|2nd)\b/i.test(n));
  const pool = clean.length ? clean : names;
  // Shortest non-trivial name wins.
  return pool.sort((a, b) => a.length - b.length)[0] || names[0];
}

// POST /api/courses/sync — receiver for the GHL daily workflow webhook.
// Deduplicates payment variants of the same course into one catalog entry, and
// (best-effort) fetches each product's live status from GHL so drafts and
// retired products are filtered out.
async function coursesSync(req, res, origin) {
  const secret = String(req.headers['x-sync-secret'] || '').trim();
  if (!safeSecretEqual(secret, COURSES_SYNC_SECRET)) {
    console.warn('[Gaia Courses] sync rejected: bad secret');
    sendJson(res, 403, { ok: false, error: 'Invalid sync secret.' }, origin);
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' }, origin);
    return;
  }
  let rawCourses = [];
  if (Array.isArray(body)) rawCourses = body;
  else if (Array.isArray(body.courses)) rawCourses = body.courses;
  else if (Array.isArray(body.data)) rawCourses = body.data;
  const enrichedCourses = await enrichCatalogPublication(rawCourses);
  const normalized = enrichedCourses.map(normalizeCatalogCourse).filter((c) => c.id || c.title !== 'Course');
  const publicCourses = normalized.filter(catalogCourseIsPublic);

  // Group variants by normalized key, then pick one representative per group.
  const groups = new Map();
  for (const c of publicCourses) {
    const key = courseGroupKey(c.title);
    if (!key || key.length < 4) continue; // drop noise
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  let courses = [];
  let hiddenCount = normalized.length - publicCourses.length;
  for (const [, group] of groups) {
    const rep = group[0];
    const title = cleanGroupTitle(group);
    // Member count: prefer the max across variants (a course sold via multiple
    // SKUs still has one real enrollment count).
    const memberCount = group.reduce((max, c) => Math.max(max, Number(c.memberCount) || 0), 0);
    // Detect access level from the representative + the group's titles.
    const allText = group.map((c) => (c.title + ' ' + c.accessLevel).toLowerCase()).join(' ');
    const accessLevel = rep.accessLevel !== 'free' ? rep.accessLevel
      : (/certif|level|advanced|expert|master/.test(allText) ? 'silver' : 'free');
    courses.push({
      id: rep.id,
      title,
      description: rep.description,
      image: rep.image,
      category: rep.category,
      accessLevel,
      price: group.reduce((max, c) => Math.max(max, Number(c.price) || 0), 0),
      memberCount,
      portalUrl: rep.portalUrl,
      order: rep.order,
      variantCount: group.length,
      portalPublished: true,
    });
  }
  // Sort: most members first (popular courses surface to the top), then by name.
  courses.sort((a, b) => {
    const am = Number(a.memberCount) || 0;
    const bm = Number(b.memberCount) || 0;
    if (am !== bm) return bm - am; // descending member count
    return a.title.localeCompare(b.title);
  });

  const payload = {
    ok: true,
    courses,
    syncedAt: body.syncedAt && body.syncedAt !== 'null' ? body.syncedAt : new Date().toISOString(),
    locationId: String(body.locationId && body.locationId !== 'null' ? body.locationId : ''),
    count: courses.length,
    rawCount: normalized.length,
    source: 'ghl-workflow',
  };
  saveCourses(payload);
  // Self-heal the authoritative grant registry from the FULL raw GHL universe
  // (including hidden/unpublished courses), so authority always tracks GHL.
  // Ambiguous group-keys are recorded so a name mapping to >1 course is
  // rejected, never guessed. This is what makes GHL — not our ledger — the
  // authority for whether a NEW course entitlement may be created.
  try {
    const authCourses = [];
    const keyIds = new Map();
    for (const c of normalized) {
      const id = String(c.id || '').trim();
      const title = String(c.title || '').trim();
      if (!id && !title) continue;
      if (/\b(demo|e2e)\b/i.test(title)) continue; // keep DEMO/test courses out of grant authority
      const key = courseGroupKey(title || id);
      authCourses.push({ id: id || key, title, groupKey: key, productType: c.productType || '', visible: catalogCourseIsPublic(c), status: c.status || '', source: 'ghl_courses_sync' });
      if (key) { if (!keyIds.has(key)) keyIds.set(key, new Set()); keyIds.get(key).add(id || key); }
    }
    const ambiguous = {};
    for (const [k, ids] of keyIds) if (ids.size > 1) ambiguous[k] = [...ids];
    writeJsonAtomic(COURSE_AUTHORITY_FILE, { version: 1, source: 'ghl_courses_sync (full raw universe, incl hidden)', seeded_pending_full_sync: false, generatedAt: payload.syncedAt, count: authCourses.length, courses: authCourses, ambiguous_keys: ambiguous });
    console.log('[Gaia Courses] authority refreshed', { count: authCourses.length, ambiguous: Object.keys(ambiguous).length });
  } catch (err) { console.warn('[Gaia Courses] authority refresh failed', { error: err.message.split('\n')[0] }); }
  console.log('[Gaia Courses] sync received', { raw: normalized.length, deduped: courses.length, hidden: hiddenCount, syncedAt: payload.syncedAt });
  sendJson(res, 200, { ok: true, count: courses.length, rawCount: normalized.length, hidden: hiddenCount, syncedAt: payload.syncedAt }, origin);
}

// GET /api/courses — public catalog for the app to render.
async function coursesList(req, res, origin) {
  const data = loadCourses();
  const courses = (data.courses || []).map((course) => ({
    ...course,
    description: plainCourseDescription(course.description),
  }));
  sendJson(res, 200, {
    ok: true,
    courses,
    syncedAt: data.syncedAt || null,
    count: courses.length,
    source: data.source || 'none',
    stale: data.syncedAt ? (Date.now() - new Date(data.syncedAt).getTime()) > 48 * 60 * 60 * 1000 : true,
  }, origin);
}

// ── Academy Player (Path A) ────────────────────────────────
// Native in-app course player. Videos live on a fast CDN (Phase 2); this endpoint
// serves the content MANIFEST the app renders. Phase 1 is public (a single
// preview course on a public HLS test stream) so playback is verifiable now.
const ACADEMY_MANIFEST_FILE = path.join(process.cwd(), 'data', 'academy-manifest.json');
const DEFAULT_ACADEMY_MANIFEST = {
  courses: [
    {
      id: 'demo-gaia-player',
      title: 'Gaia Academy \u2014 Player Preview',
      poster: '',
      preview: true,          // visible to everyone (beta demo); no grant needed
      grantMatch: [],         // GHL course ids/names this maps to (Phase 2)
      sections: [
        { title: 'Welcome', lessons: [
          { id: 'demo-1', title: 'Watching your courses inside Gaia', durationSec: 60, type: 'hls', free: true, src: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
          { id: 'demo-2', title: 'Adaptive streaming \u2014 no portal, no leaving', durationSec: 120, type: 'hls', free: true, src: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
        ] },
      ],
    },
  ],
};
function loadAcademyManifest() {
  try {
    if (fs.existsSync(ACADEMY_MANIFEST_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ACADEMY_MANIFEST_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.courses)) return parsed;
    }
  } catch (_) { /* fall through to the built-in default */ }
  return DEFAULT_ACADEMY_MANIFEST;
}
// GET /api/academy/manifest — public course structure for the in-app player.
async function academyManifest(req, res, origin) {
  const data = loadAcademyManifest();
  sendJson(res, 200, {
    ok: true,
    courses: data.courses || [],
    updatedAt: data.updatedAt || null,
    count: (data.courses || []).length,
  }, origin);
}

const ACADEMY_ACCESS_FILE = path.join(process.cwd(), 'data', 'academy-access.json');
const ACADEMY_PROGRESS_FILE = path.join(process.cwd(), 'data', 'academy-progress.json');
function loadAcademyAccess() { try { return JSON.parse(fs.readFileSync(ACADEMY_ACCESS_FILE, 'utf8')); } catch (_) { return { byContact: {}, byEmail: {}, updatedAt: null }; } }
function loadAcademyProgress() { try { return JSON.parse(fs.readFileSync(ACADEMY_PROGRESS_FILE, 'utf8')); } catch (_) { return { byContact: {}, updatedAt: null }; } }

// Detect a lesson's video provider + playable source from GHL's fields.
function academyLessonSource(lesson) {
  if (lesson.provider === 'youtube' && lesson.src) return { provider: 'youtube', src: String(lesson.src) };
  if (lesson.provider === 'vimeo' && lesson.src) return { provider: 'vimeo', src: String(lesson.src) };
  const raw = String(lesson.videoUrl || lesson.embedUrl || lesson.url || lesson.src || '').trim();
  const vm = raw.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return { provider: 'vimeo', src: vm[1] };
  const yt = raw.match(/(?:youtube\.com\/embed\/|youtu\.be\/|[?&]v=)([\w-]{11})/);
  if (yt) return { provider: 'youtube', src: yt[1] };
  if (/^[\w-]{11}$/.test(raw) && lesson.provider === 'youtube') return { provider: 'youtube', src: raw };
  // GHL-native: build the PUBLIC mp4 URL from the video id (CORS-open CDN).
  const vid = String(lesson.videoId || lesson.mediaId || lesson.embedMediaId || '').trim();
  const loc = String(process.env.GHL_LOCATION_ID || '').trim();
  if (vid && loc) {
    const bitrate = String(lesson.bitrate || '5300k');
    return { provider: 'mp4', src: 'https://cdn.courses.apisystem.tech/memberships/' + loc + '/videos/' + vid + '_' + bitrate + '.mp4' };
  }
  if (raw) return { provider: /\.m3u8(\?|$)/i.test(raw) ? 'hls' : 'mp4', src: raw };
  return { provider: 'none', src: '' };
}

// POST /api/academy/sync — ingest the mirror from the GHL extractor.
async function academySync(req, res, origin) {
  const expected = String(process.env.ACADEMY_SYNC_SECRET || '').trim();
  let qSecret = ''; try { qSecret = new URL(req.url, 'http://x').searchParams.get('secret') || ''; } catch (e) {}
  const supplied = String(req.headers['x-academy-secret'] || qSecret || '').trim();
  if (!expected || expected.length < 16) { sendJson(res, 503, { ok: false, error: 'sync_not_configured' }, origin); return; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' }, origin); return;
  }
  let body;
  try { body = await readJsonBody(req, 16 * 1024 * 1024); } catch (e) { sendJson(res, 400, { ok: false, error: 'bad_json' }, origin); return; }
  const now = new Date().toISOString();
  const catalog = Array.isArray(body.catalog) ? body.catalog : [];
  const members = Array.isArray(body.members) ? body.members : [];

  // --- manifest (catalog -> player shape) ---
  const courses = catalog.map((c) => {
    const modules = Array.isArray(c.modules) ? c.modules : [{ title: 'Lessons', lessons: c.lessons || [] }];
    const sections = modules.map((m) => ({
      title: String(m.title || 'Lessons'),
      lessons: (m.lessons || []).map((l) => {
        const vs = academyLessonSource(l);
        return { id: String(l.postId || l.id || ''), title: String(l.title || 'Lesson'), provider: vs.provider, src: vs.src, durationSec: Number(l.durationSec || l.duration || 0) || 0 };
      }).filter((l) => l.id),
    }));
    return { id: String(c.productId || c.id || ''), title: String(c.title || 'Course'), poster: String(c.poster || c.image || ''), grantMatch: [String(c.productId || ''), String(c.title || '')].filter(Boolean), sections };
  }).filter((c) => c.id);
  if (courses.length) {
    const existing = loadAcademyManifest();
    const map = {}; (existing.courses || []).forEach((c) => { map[c.id] = c; });
    courses.forEach((c) => {
      const incomingHasLessons = (c.sections || []).some((s) => (s.lessons || []).length);
      const prev = map[c.id];
      if (!prev) { map[c.id] = c; }
      else { map[c.id] = Object.assign({}, prev, c, { sections: incomingHasLessons ? c.sections : (prev.sections || c.sections) }); }
    });
    writeJsonAtomic(ACADEMY_MANIFEST_FILE, { updatedAt: now, source: 'ghl-sync', courses: Object.values(map) });
  }

  // --- access + progress (per member) ---
  const access = { byContact: {}, byEmail: {}, updatedAt: now };
  const progress = { byContact: {}, updatedAt: now };
  for (const m of members) {
    const cid = String(m.contactId || '').trim();
    const email = String(m.email || '').trim().toLowerCase();
    const cs = Array.isArray(m.courses) ? m.courses : [];
    const ids = cs.map((x) => String(x.productId || x.id || '')).filter(Boolean);
    if (cid) access.byContact[cid] = ids;
    if (email) access.byEmail[email] = ids;
    if (cid) {
      progress.byContact[cid] = {};
      for (const x of cs) {
        const pid = String(x.productId || x.id || ''); if (!pid) continue;
        progress.byContact[cid][pid] = { pct: Number(x.progressPct || x.percentage || 0) || 0, completed: Array.isArray(x.completedPostIds) ? x.completedPostIds : [] };
      }
    }
  }
  if (members.length) {
    const ea = loadAcademyAccess(); const ep = loadAcademyProgress();
    ea.byContact = Object.assign(ea.byContact || {}, access.byContact); ea.byEmail = Object.assign(ea.byEmail || {}, access.byEmail); ea.updatedAt = now;
    ep.byContact = Object.assign(ep.byContact || {}, progress.byContact); ep.updatedAt = now;
    writeJsonAtomic(ACADEMY_ACCESS_FILE, ea); writeJsonAtomic(ACADEMY_PROGRESS_FILE, ep);
  }

  sendJson(res, 200, { ok: true, courses: courses.length, members: members.length, updatedAt: now }, origin);
}

// POST /api/academy/webhook — GHL Workflow fires this on course grant/revoke.
// Body (any of): { email, contactId, productId, offerTitle|offerName, action: "grant"|"revoke" }.
// The GHL "Membership Offer Access Granted/Removed" trigger cannot pass a course
// UUID, only the granted offer's TITLE ({{membership_contact.offer_title}}), so we
// resolve that title -> course product id(s) here: an explicit map wins
// (data/academy-offer-map.json), else a single unambiguous manifest-title match;
// anything unresolved is recorded in data/academy-offer-unmapped.json for review.
// Secret via ?secret= or x-academy-secret. Updates data/academy-access.json live.
const ACADEMY_OFFER_MAP_FILE = path.join(process.cwd(), 'data', 'academy-offer-map.json');
const ACADEMY_OFFER_UNMAPPED_FILE = path.join(process.cwd(), 'data', 'academy-offer-unmapped.json');
function acadNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function loadAcademyOfferMap() { try { return JSON.parse(fs.readFileSync(ACADEMY_OFFER_MAP_FILE, 'utf8')) || {}; } catch (_) { return {}; } }
// Resolve a granted offer title to the course product id(s) it should unlock.
// Returns { ids: [...], via: 'map'|'title'|'unresolved', candidates: n }.
function resolveOfferToProducts(offerTitle) {
  const norm = acadNorm(offerTitle);
  if (!norm) return { ids: [], via: 'unresolved', candidates: 0 };
  const map = loadAcademyOfferMap();
  for (const k of Object.keys(map)) {
    if (acadNorm(k) === norm) {
      const v = map[k]; const ids = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
      if (ids.length) return { ids, via: 'map', candidates: ids.length };
    }
  }
  // Fall back to the synced manifest, but accept ONLY an unambiguous single match,
  // so a vague offer title never silently unlocks the wrong (or several) courses.
  const courses = (loadAcademyManifest().courses || []);
  const hits = courses.filter((c) => {
    const t = acadNorm(c.title);
    if (!t) return false;
    if (t === norm) return true;
    if (Array.isArray(c.grantMatch) && c.grantMatch.some((g) => acadNorm(g) === norm)) return true;
    return t.indexOf(norm) === 0 || norm.indexOf(t) === 0;
  });
  const ids = [...new Set(hits.map((c) => c.id).filter(Boolean))];
  if (ids.length === 1) return { ids, via: 'title', candidates: 1 };
  return { ids: [], via: 'unresolved', candidates: ids.length };
}
function recordUnmappedOffer(offerTitle, contactRef) {
  try {
    let log = {}; try { log = JSON.parse(fs.readFileSync(ACADEMY_OFFER_UNMAPPED_FILE, 'utf8')) || {}; } catch (_) {}
    const key = String(offerTitle || '').trim() || '(empty)';
    const e = log[key] || { count: 0, firstSeen: new Date().toISOString(), lastContact: null };
    e.count += 1; e.lastSeen = new Date().toISOString(); e.lastContact = contactRef || e.lastContact;
    log[key] = e; writeJsonAtomic(ACADEMY_OFFER_UNMAPPED_FILE, log);
  } catch (_) {}
}
async function academyWebhook(req, res, origin) {
  const expected = String(process.env.ACADEMY_SYNC_SECRET || '').trim();
  let qSecret = ''; try { qSecret = new URL(req.url, 'http://x').searchParams.get('secret') || ''; } catch (e) {}
  const supplied = String(req.headers['x-academy-secret'] || qSecret || '').trim();
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' }, origin); return;
  }
  let body; try { body = await readJsonBody(req, 256 * 1024); } catch (e) { sendJson(res, 400, { ok: false, error: 'bad_json' }, origin); return; }
  const email = String(body.email || body.contact_email || (body.contact && body.contact.email) || '').trim().toLowerCase();
  const contactId = String(body.contactId || body.contact_id || (body.contact && body.contact.id) || '').trim();
  const directId = String(body.productId || body.product_id || body.courseId || body.course_id || '').trim();
  const offerTitle = String(body.offerTitle || body.offer_title || body.offerName || body.offer_name || '').trim();
  const raw = String(body.action || body.event || body.type || 'grant').toLowerCase();
  const action = /revok|remov|cancel|refund|expir|delete/.test(raw) ? 'revoke' : 'grant';
  if (!email && !contactId) { sendJson(res, 422, { ok: false, error: 'need contact (email or contactId)' }, origin); return; }
  let ids = []; let via = 'direct';
  if (directId) { ids = [directId]; via = 'direct'; }
  else if (offerTitle && !/\{\{/.test(offerTitle)) { const r = resolveOfferToProducts(offerTitle); ids = r.ids; via = r.via; }
  if (!ids.length) {
    // Nothing to change — not a fault the sender can fix, so 200 + record the
    // offer title we could not map, ready for a one-line academy-offer-map.json entry.
    if (offerTitle) recordUnmappedOffer(offerTitle, email || contactId);
    sendJson(res, 200, { ok: true, action, resolved: [], via: 'unresolved', offerTitle: offerTitle || null, contactId: contactId || null, email: email || null }, origin);
    return;
  }
  const access = loadAcademyAccess(); access.byContact = access.byContact || {}; access.byEmail = access.byEmail || {};
  const upd = (store, key) => { if (!key) return; const set = new Set(store[key] || []); for (const id of ids) { if (action === 'grant') set.add(id); else set.delete(id); } store[key] = [...set]; };
  upd(access.byContact, contactId); upd(access.byEmail, email);
  access.updatedAt = new Date().toISOString();
  writeJsonAtomic(ACADEMY_ACCESS_FILE, access);
  sendJson(res, 200, { ok: true, action, resolved: ids, via, offerTitle: offerTitle || null, contactId: contactId || null, email: email || null }, origin);
}

const ACADEMY_EMAIL_TO_CONTACT_FILE = path.join(path.dirname(MEMBER_ENTITLEMENTS_FILE), 'email-to-contact.json');
// email -> contactId crosswalk (from the backfill), cached by mtime.
let _acadEmailToContact = null;
function loadAcademyEmailToContact() {
  try {
    const mtime = fs.statSync(ACADEMY_EMAIL_TO_CONTACT_FILE).mtimeMs;
    if (_acadEmailToContact && _acadEmailToContact.mtime === mtime) return _acadEmailToContact.map;
    const j = JSON.parse(fs.readFileSync(ACADEMY_EMAIL_TO_CONTACT_FILE, 'utf8'));
    const raw = (j && j.map) || j || {};
    const map = {};
    for (const e of Object.keys(raw)) { const k = String(e).trim().toLowerCase(); if (k) map[k] = String(raw[e] || '').trim(); }
    _acadEmailToContact = { mtime, map };
    return map;
  } catch (e) { return (_acadEmailToContact && _acadEmailToContact.map) || {}; }
}

// contactId -> [manifest course ids], derived from the ledger by matching each
// unlocked course's NAME to a manifest course title/grantMatch. Cached until the
// ledger or the manifest file changes.
let _ledgerAcademyIndex = null;
function loadLedgerAcademyIndex() {
  let lm = 0, mm = 0;
  try { lm = fs.statSync(MEMBER_ENTITLEMENTS_FILE).mtimeMs; } catch (e) {}
  try { mm = fs.statSync(ACADEMY_MANIFEST_FILE).mtimeMs; } catch (e) {}
  const key = lm + ':' + mm;
  if (_ledgerAcademyIndex && _ledgerAcademyIndex.key === key) return _ledgerAcademyIndex.byContact;
  const byContact = {};
  try {
    const manifest = loadAcademyManifest();
    const titleToId = {};
    (manifest.courses || []).forEach((c) => {
      const t = acadNorm(c.title); if (t) titleToId[t] = c.id;
      (Array.isArray(c.grantMatch) ? c.grantMatch : []).forEach((g) => { const k = acadNorm(g); if (k) titleToId[k] = c.id; });
    });
    const ledger = loadMemberEntitlements();
    const contacts = (ledger && ledger.contacts) || {};
    for (const cid of Object.keys(contacts)) {
      const courses = (contacts[cid] && contacts[cid].courses) || [];
      const set = new Set();
      for (const co of courses) {
        if (co && co.state && co.state !== 'unlocked') continue;
        const id = titleToId[acadNorm(co && co.name)] || titleToId[acadNorm(co && co.id)];
        if (id) set.add(id);
      }
      if (set.size) byContact[cid] = [...set];
    }
  } catch (e) { /* fall through with whatever we built */ }
  _ledgerAcademyIndex = { key, byContact };
  return byContact;
}

// GET /api/academy/me?email= — the signed-in member's OWN courses + progress.
// Access = live webhook grants (academy-access.json) UNION the authoritative GHL
// entitlement ledger (member-entitlements.json), so a member plays exactly what
// GHL grants them, for every course whose videos are in the synced manifest.
async function academyMe(req, res, origin, url) {
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  let contactId = String(url.searchParams.get('contactId') || '').trim();
  if (!contactId && email) { const map = loadAcademyEmailToContact(); contactId = map[email] || ''; }
  const access = loadAcademyAccess();
  const progress = loadAcademyProgress();
  const ids = new Set();
  if (contactId && Array.isArray(access.byContact[contactId])) access.byContact[contactId].forEach((x) => ids.add(x));
  if (email && Array.isArray(access.byEmail[email])) access.byEmail[email].forEach((x) => ids.add(x));
  const ledgerIdx = loadLedgerAcademyIndex();
  if (contactId && Array.isArray(ledgerIdx[contactId])) ledgerIdx[contactId].forEach((x) => ids.add(x));
  const manifest = loadAcademyManifest();
  const owned = (manifest.courses || []).filter((c) => ids.has(c.id) || (Array.isArray(c.grantMatch) && c.grantMatch.some((g) => ids.has(g))));
  const prog = (contactId && progress.byContact && progress.byContact[contactId]) || {};
  sendJson(res, 200, { ok: true, courses: owned, progress: prog, count: owned.length, updatedAt: access.updatedAt }, origin);
}

// POST /api/academy/progress — the in-app player reports a lesson's position +
// completion; we persist it per member so "% complete" and resume survive across
// devices (academyMe returns this back). Body: { email|contactId, courseId,
// lessonId, positionSec, durationSec, done }. Playback lives in-app now, so THIS
// is the source of truth for in-app progress (GHL's portal progress is separate).
async function academyProgress(req, res, origin) {
  let body; try { body = await readJsonBody(req, 64 * 1024); } catch (e) { sendJson(res, 400, { ok: false, error: 'bad_json' }, origin); return; }
  const email = String(body.email || '').trim().toLowerCase();
  let contactId = String(body.contactId || '').trim();
  if (!contactId && email) { const map = loadAcademyEmailToContact(); contactId = map[email] || ''; }
  const courseId = String(body.courseId || '').trim();
  const lessonId = String(body.lessonId || '').trim();
  if (!contactId || !courseId || !lessonId) { sendJson(res, 422, { ok: false, error: 'need contactId (or known email) + courseId + lessonId' }, origin); return; }
  const pos = Math.max(0, Math.floor(Number(body.positionSec) || 0));
  const dur = Math.max(0, Math.floor(Number(body.durationSec) || 0));
  const done = !!body.done || (dur > 0 && pos >= dur - 15);
  const store = loadAcademyProgress(); store.byContact = store.byContact || {};
  const byCourse = store.byContact[contactId] = store.byContact[contactId] || {};
  const c = byCourse[courseId] = byCourse[courseId] || { pct: 0, completed: [], pos: {} };
  c.completed = Array.isArray(c.completed) ? c.completed : [];
  c.pos = c.pos && typeof c.pos === 'object' ? c.pos : {};
  c.pos[lessonId] = pos;
  if (done && !c.completed.includes(lessonId)) c.completed.push(lessonId);
  // recompute % against the manifest's lesson count for this course
  const manifest = loadAcademyManifest();
  const mc = (manifest.courses || []).find((x) => String(x.id) === courseId || (Array.isArray(x.grantMatch) && x.grantMatch.some((g) => String(g) === courseId)));
  const total = mc ? (mc.sections || []).reduce((a, sec) => a + ((sec.lessons || []).length), 0) : 0;
  c.pct = total ? Math.round(Math.min(c.completed.length, total) / total * 100) : (c.completed.length ? 100 : 0);
  store.updatedAt = new Date().toISOString();
  writeJsonAtomic(ACADEMY_PROGRESS_FILE, store);
  sendJson(res, 200, { ok: true, courseId, pct: c.pct, completed: c.completed }, origin);
}

function memberWebhookAuthorized(req, rawBody) {
  const suppliedSignature = String(req.headers['x-ghl-signature'] || '').trim();

  // Ed25519 first when the platform actually signed the delivery: a verified
  // signature is stronger evidence than a shared secret, because it proves the
  // body was not altered as well as who sent it.
  if (GHL_WEBHOOK_ED25519_PUBLIC_KEY && suppliedSignature) {
    try {
      const signature = /^[a-f0-9]{128}$/i.test(suppliedSignature)
        ? Buffer.from(suppliedSignature, 'hex')
        : Buffer.from(suppliedSignature, 'base64');
      if (crypto.verify(null, Buffer.from(rawBody, 'utf8'), GHL_WEBHOOK_ED25519_PUBLIC_KEY, signature)) {
        return 'ghl-ed25519';
      }
      // Present but not verifiable. Loud, because it is either the wrong key or
      // a forgery attempt — but not yet fatal: we have not observed a real
      // signed delivery on this path, and hard-rejecting an unrecognised
      // signature would silently drop legitimate events. Flip
      // GHL_WEBHOOK_ED25519_STRICT=1 once signed deliveries are confirmed.
      console.warn('[Gaia Entitlements] X-GHL-Signature present but did NOT verify', {
        strict: GHL_WEBHOOK_ED25519_STRICT, bytes: signature.length,
      });
      if (GHL_WEBHOOK_ED25519_STRICT) return '';
    } catch (err) {
      console.warn('[Gaia Entitlements] signature verification failed', { error: err.message.split('\n')[0] });
      if (GHL_WEBHOOK_ED25519_STRICT) return '';
    }
  }

  const suppliedSecret = String(req.headers['x-webhook-secret'] || req.headers['x-sync-secret'] || '').trim();
  if (GHL_WORKFLOW_WEBHOOK_SECRET.length >= 32 && safeSecretEqual(suppliedSecret, GHL_WORKFLOW_WEBHOOK_SECRET)) {
    return 'workflow-secret';
  }
  return '';
}

function nestedValue(body, ...keys) {
  const containers = [body, body?.data, body?.contact, body?.customData, body?.workflow];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of keys) {
      if (container[key] != null && String(container[key]).trim()) return container[key];
    }
  }
  return '';
}

function normalizeEntitlementResource(body, resourceType) {
  const source = (body?.resource && typeof body.resource === 'object') ? body.resource : body;
  const idKeys = resourceType === 'community'
    ? ['communityId', 'groupId', 'resourceId', 'offerId']
    : ['courseId', 'offerId', 'productId', 'resourceId'];
  const nameKeys = resourceType === 'community'
    ? ['communityName', 'groupName', 'resourceName', 'offerName', 'name']
    : ['courseName', 'offerName', 'productName', 'resourceName', 'name'];
  const id = firstNonEmptyString(source !== body ? source?.id : '', ...idKeys.map((key) => source?.[key]), ...idKeys.map((key) => body?.data?.[key]));
  const name = firstNonEmptyString(...nameKeys.map((key) => source?.[key]), ...nameKeys.map((key) => body?.data?.[key]), id);
  const openUrl = firstNonEmptyString(source?.openUrl, source?.portalUrl, source?.url, body?.data?.openUrl, body?.data?.portalUrl, body?.data?.url);
  // Preserve whether GHL actually gave us a stable id vs. one we derived from
  // the name. A revoke that carries only a real product id must still match a
  // backfill row that is keyed by the name — see resolveEntitlementMatch.
  const rawId = firstNonEmptyString(source !== body ? source?.id : '', ...idKeys.map((key) => source?.[key]), ...idKeys.map((key) => body?.data?.[key]));
  return { id: id || courseGroupKey(name), name, openUrl, rawId: rawId || '' };
}

/* A course event can arrive keyed by a real GHL product id, by a human name, or
 * (historically) by neither cleanly. The backfill wrote rows keyed by
 * courseGroupKey(name); live webhooks may carry a product id with no name. To
 * make grant AND revoke land on the same row regardless, we match on any of:
 *   - exact stored id            (id-keyed rows, and re-fired webhooks)
 *   - exact stored name          (name-keyed backfill rows, when a name is sent)
 *   - courseGroupKey(name)       (bridges name spelling ↔ the backfill key)
 *   - a learned id↔key alias     (bridges a real product id ↔ the backfill key)
 * The alias registry is populated only from webhooks that present BOTH a real
 * product id and a name, so nothing is ever guessed. */
function aliasKeyForId(store, realId) {
  const id = String(realId || '').trim();
  if (!id) return '';
  return (store.courseAliases && store.courseAliases.byId && store.courseAliases.byId[id]) || '';
}
function aliasIdForKey(store, nameKey) {
  const key = String(nameKey || '').trim();
  if (!key) return '';
  return (store.courseAliases && store.courseAliases.byKey && store.courseAliases.byKey[key]) || '';
}
function learnCourseAlias(store, realId, name) {
  const id = String(realId || '').trim();
  const key = courseGroupKey(name || '');
  if (!id || !key || id === key) return;                 // only real product ids
  store.courseAliases = store.courseAliases || { byId: {}, byKey: {} };
  store.courseAliases.byId = store.courseAliases.byId || {};
  store.courseAliases.byKey = store.courseAliases.byKey || {};
  store.courseAliases.byId[id] = key;
  store.courseAliases.byKey[key] = id;
}
function resolveEntitlementMatch(list, resource, store, authAliasIndex) {
  const rid = String(resource.rawId || '').trim();
  const nameKey = courseGroupKey(resource.name || '');
  const aliasKey = aliasKeyForId(store, rid);            // real id -> backfill key
  const aliasId = aliasIdForKey(store, nameKey);         // name-only revoke -> real id
  const candidates = new Set([
    String(resource.id || '').toLowerCase(),
    nameKey,
    aliasKey,
    String(aliasId || '').toLowerCase(),
  ].filter(Boolean));
  // Approved AUTHORITY aliases — the SAME registry grant resolution
  // (resolveCourseGrant) uses — so a variant revoke/existing-row match lands on
  // the canonical row a variant grant created. Deterministic: explicit approved
  // aliases only; the ambiguity guard still lives in the grant authority gate.
  const aidx = authAliasIndex || buildCourseAuthorityIndex();
  const authHit = (nameKey && aidx.aliasByKey.get(nameKey)) || (rid && aidx.aliasById.get(rid.toLowerCase()));
  if (authHit) { candidates.add(String(authHit.id).toLowerCase()); candidates.add(courseGroupKey(authHit.title)); }
  const nameLc = String(resource.name || '').toLowerCase();
  return list.findIndex((item) => {
    const iid = String(item.id || '').toLowerCase();
    const iname = String(item.name || '').toLowerCase();
    const ikey = courseGroupKey(item.name || item.id || '');
    if (rid && iid === rid.toLowerCase()) return true;   // real id == stored id
    if (nameLc && iname === nameLc) return true;          // exact name
    if (candidates.has(iid)) return true;                 // derived-key / alias match
    if (candidates.has(ikey)) return true;               // stored name -> same key
    return false;
  });
}

// ── Authoritative course grant registry ──────────────────────────────
// Authority for CREATING a course entitlement comes ONLY from GHL, never from
// our own ledger. data/course-authority.json is the real GHL course universe
// (seeded from the catalog sync + GHL Products API, and self-healed from the
// full raw set on every POST /api/courses/sync). course-authority-aliases.json
// holds explicit, evidence-documented approvals for LMS-only courses GHL's own
// access-granted workflow uses but that expose no product id. The ledger is
// audited against this authority but is NEVER itself a source of authority — a
// bad historical row can never become grantable.
const COURSE_REJECTIONS_FILE = path.join(process.cwd(), 'data', 'course-grant-rejections.json');
const COURSE_AUTHORITY_FILE = String(process.env.COURSE_AUTHORITY_FILE || path.join(process.cwd(), 'data', 'course-authority.json')).trim();
const COURSE_ALIAS_FILE = String(process.env.COURSE_ALIAS_FILE || path.join(process.cwd(), 'data', 'course-authority-aliases.json')).trim();
function loadCourseAuthority() { try { return JSON.parse(fs.readFileSync(COURSE_AUTHORITY_FILE, 'utf8')); } catch (_) { return { courses: [], ambiguous_keys: {} }; } }
function loadCourseAliases() { try { return JSON.parse(fs.readFileSync(COURSE_ALIAS_FILE, 'utf8')); } catch (_) { return { aliases: [] }; } }
// Build the resolution index from authority + approved aliases (NOT the ledger).
function buildCourseAuthorityIndex() {
  const auth = loadCourseAuthority();
  const byId = new Map();      // lc id -> { id, title }
  const byKey = new Map();     // unique group key -> { id, title }
  const ambiguousKeys = new Set(Object.keys(auth.ambiguous_keys || {}));
  for (const c of (auth.courses || [])) {
    const id = String(c.id || '').trim();
    const title = String(c.title || '').trim();
    const key = String(c.groupKey || courseGroupKey(title || id));
    if (id) byId.set(id.toLowerCase(), { id, title });
    if (key && !ambiguousKeys.has(key) && !byKey.has(key)) byKey.set(key, { id, title });
  }
  const aliasByKey = new Map();
  const aliasById = new Map();
  for (const a of (loadCourseAliases().aliases || [])) {
    if (a.approved === false) continue;
    const entry = { id: String(a.canonical_id || a.alias_key || ''), title: String(a.canonical_title || a.alias_name || ''), method: a.resolution_method || 'explicit_alias' };
    if (a.alias_key) aliasByKey.set(String(a.alias_key), entry);
    if (a.canonical_id) aliasById.set(String(a.canonical_id).toLowerCase(), entry);
  }
  return { byId, byKey, ambiguousKeys, aliasByKey, aliasById };
}
// Group-keys present in the ledger but resolving to NO authority/alias: legacy,
// unverified courses. Used only to classify a rejection reason and to let an
// existing owner keep access; never to authorize a NEW grant.
function courseLegacyKeySet(store, idx) {
  const legacy = new Set();
  for (const rec of Object.values((store && store.contacts) || {})) {
    for (const c of (rec.courses || [])) {
      const key = courseGroupKey(c.name || c.id || '');
      if (!key) continue;
      const known = idx.byKey.has(key) || idx.aliasByKey.has(key) || (c.id && idx.byId.has(String(c.id).toLowerCase()));
      if (!known) legacy.add(key);
    }
  }
  return legacy;
}
// Resolve an incoming course to an authoritative course, or a reject reason.
// Order: exact GHL id -> explicit alias -> exact authoritative name/group-key.
// Ambiguous key -> reject. No fuzzy matching. Records the resolution method.
function resolveCourseGrant(idx, resource) {
  const rid = String(resource.rawId || '').trim().toLowerCase();
  if (rid && idx.byId.has(rid)) return { course: idx.byId.get(rid), method: 'exact_resource_id' };
  if (rid && idx.aliasById.has(rid)) { const a = idx.aliasById.get(rid); return { course: { id: a.id, title: a.title }, method: a.method }; }
  const key = courseGroupKey(resource.name || '');
  if (key) {
    if (idx.ambiguousKeys.has(key)) return { reject: 'AMBIGUOUS_RESOURCE' };
    if (idx.aliasByKey.has(key)) { const a = idx.aliasByKey.get(key); return { course: { id: a.id, title: a.title }, method: a.method }; }
    if (idx.byKey.has(key)) return { course: idx.byKey.get(key), method: 'exact_authoritative_name' };
  }
  return { reject: 'UNKNOWN_RESOURCE' };
}
function recordCourseGrantRejection(store, contactId, entry) {
  const rec = store && store.contacts && store.contacts[contactId];
  if (rec) {
    rec.courseGrantRejections = Array.isArray(rec.courseGrantRejections) ? rec.courseGrantRejections : [];
    rec.courseGrantRejections.push(entry);
    if (rec.courseGrantRejections.length > 50) rec.courseGrantRejections = rec.courseGrantRejections.slice(-50);
  }
  let log; try { log = JSON.parse(fs.readFileSync(COURSE_REJECTIONS_FILE, 'utf8')); } catch (_) { log = { version: 1, items: [] }; }
  log.items = Array.isArray(log.items) ? log.items : [];
  log.items.push({ ...entry, contactId });
  if (log.items.length > 500) log.items = log.items.slice(-500);
  try { writeJsonAtomic(COURSE_REJECTIONS_FILE, log); } catch (_) {}
}

function normalizeTierName(value) {
  const tier = String(value || '').trim().toLowerCase();
  return ['free', 'silver', 'gold', 'diamond'].includes(tier) ? tier.charAt(0).toUpperCase() + tier.slice(1) : null;
}

function classifyEntitlementEvent(body) {
  const raw = firstNonEmptyString(body.type, body.event, body.eventType, body.action, body.customData?.event).toLowerCase().replace(/[\s.-]+/g, '_');
  if (/contact.*tag/.test(raw)) return { kind: 'tags', grant: null, raw };
  if (/(community|group).*(remove|removed|revoke|revoked|delete|deleted)/.test(raw)) return { kind: 'community', grant: false, raw };
  if (/(community|group).*(grant|granted|add|added|access)/.test(raw)) return { kind: 'community', grant: true, raw };
  if (/(course|offer).*(remove|removed|revoke|revoked|delete|deleted)/.test(raw)) return { kind: 'course', grant: false, raw };
  if (/(course|offer).*(grant|granted|add|added|access|enroll|enrolled)/.test(raw)) return { kind: 'course', grant: true, raw };
  // Membership is mapped exactly, never by substring: "membership_ended"
  // matches no revoke keyword and used to be read as a grant. An unrecognised
  // membership event returns action null so the caller rejects it.
  if (/tier|membership/.test(raw)) {
    const action = classifyMembershipEvent(raw);
    return { kind: 'tier', grant: action === 'activate', raw, membershipAction: action };
  }
  const resourceType = firstNonEmptyString(body.resourceType, body.data?.resourceType).toLowerCase();
  const action = firstNonEmptyString(body.action, body.data?.action).toLowerCase();
  if (['course', 'offer'].includes(resourceType)) return { kind: 'course', grant: !/(remove|revoke|delete|cancel)/.test(action), raw };
  if (['community', 'group'].includes(resourceType)) return { kind: 'community', grant: !/(remove|revoke|delete|cancel)/.test(action), raw };
  return { kind: '', grant: null, raw };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Entitlement webhook telemetry.
 *
 * The pipeline is correct and, today, idle: no course has been sold since 27
 * August, so nothing arrives. Idle and broken are indistinguishable from the
 * outside, and the next real purchase is the moment that matters — so every
 * decision the receiver makes is counted, and the last time each KIND of
 * decision happened is kept.
 *
 * What is deliberately NOT kept: request bodies, contact identifiers, secrets,
 * signatures, emails. A monitoring file that leaks the thing it monitors is a
 * worse problem than the blindness it fixes. Counters and timestamps only.
 * ────────────────────────────────────────────────────────────────────────── */
const WEBHOOK_TELEMETRY_FILE = String(process.env.WEBHOOK_TELEMETRY_FILE
  || path.join(path.dirname(MEMBER_ENTITLEMENTS_FILE), 'webhook-telemetry.json')).trim();

const TELEMETRY_COUNTERS = ['received', 'authenticated', 'rejected_auth', 'unknown_resource',
  'unknown_contact', 'rejected_other', 'accepted', 'duplicate', 'grant', 'revoke', 'stale'];

function readWebhookTelemetry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WEBHOOK_TELEMETRY_FILE, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) { return {}; }
}

/**
 * Record one decision. `event` is a counter name; `at` fields are set from the
 * counter so a reader can ask "when did authentication last succeed" without
 * the writer having to enumerate every combination.
 */
function noteWebhookEvent(hook, event, { reason = null } = {}) {
  try {
    const all = readWebhookTelemetry();
    const h = all[hook] || { counters: {}, firstSeenAt: new Date().toISOString() };
    h.counters = h.counters || {};
    if (TELEMETRY_COUNTERS.includes(event)) h.counters[event] = (h.counters[event] || 0) + 1;
    const now = new Date().toISOString();
    const set = (k) => { h[k] = now; };
    if (event === 'received') set('lastReceivedAt');
    if (event === 'authenticated') set('lastAuthenticatedAt');
    if (event === 'accepted') set('lastAcceptedAt');
    if (event === 'grant') set('lastGrantAt');
    if (event === 'revoke') set('lastRevokeAt');
    if (event === 'duplicate') set('lastDuplicateAt');
    if (event === 'rejected_auth' || event === 'unknown_resource'
        || event === 'unknown_contact' || event === 'rejected_other' || event === 'stale') {
      set('lastRejectedAt');
      // A short, non-identifying label. Never the payload.
      h.lastRejectionReason = String(reason || event).slice(0, 80);
      h.lastRejectionKind = event;
    }
    all[hook] = h;
    fs.mkdirSync(path.dirname(WEBHOOK_TELEMETRY_FILE), { recursive: true });
    writeJsonAtomic(WEBHOOK_TELEMETRY_FILE, all);
  } catch (_) { /* telemetry must never break the pipeline it watches */ }
}

async function memberAccessWebhook(req, res, origin) {
  noteWebhookEvent('member_access', 'received');
  let rawBody = '';
  try { rawBody = await readRawBody(req, 512 * 1024); }
  catch (_) {
    noteWebhookEvent('member_access', 'rejected_other', { reason: 'body_too_large' });
    sendJson(res, 413, { ok: false, error: 'Request body is too large.' }, origin); return;
  }
  const authMethod = memberWebhookAuthorized(req, rawBody);
  if (!authMethod) {
    noteWebhookEvent('member_access', 'rejected_auth', { reason: 'invalid_authentication' });
    console.warn('[Gaia Entitlements] webhook rejected: invalid authentication');
    sendJson(res, 403, { ok: false, error: 'Invalid webhook authentication.' }, origin);
    return;
  }
  noteWebhookEvent('member_access', 'authenticated');
  let body;
  try { body = rawBody ? JSON.parse(rawBody) : {}; }
  catch (_) {
    noteWebhookEvent('member_access', 'rejected_other', { reason: 'invalid_json' });
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' }, origin); return;
  }

  const contactId = firstNonEmptyString(nestedValue(body, 'contactId', 'contact_id'), body.contact?.id, body.data?.contact?.id);
  if (!contactId) {
    // The course was fine; we could not say safely WHO it was for.
    noteWebhookEvent('member_access', 'unknown_contact', { reason: 'contact_id_missing' });
    sendJson(res, 422, { ok: false, error: 'contactId is required.' }, origin); return;
  }

  // \u2500\u2500 EVIDENCE MODE (product determines the entitlement) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Same discipline as the Event webhook. When a workflow supplies PAYMENT
  // EVIDENCE (a transaction/order id), we resolve the REAL GHL order -> product
  // id -> an explicit MEMBERSHIP/COURSE product mapping and grant ONLY what the
  // mapping says. Any body-supplied tier/courseId is ignored; no mapping = no-op;
  // idempotent per order. This is what makes membership/course product-driven.
  {
    const _txId = String(body.transaction_id || body.transactionId || body.payment_transaction_id || '').trim();
    let _orderId = String(body.orderId || body.order_id || '').trim();
    if (_txId || _orderId) {
      const _LOC = (process.env.GHL_LOCATION_ID || '').trim();
      const _isRefund = body.refunded === true || /(refund|refunded|charge_?back|cancel|revoke)/i.test(String(body.type || body.event || body.action || ''));
      if (_txId && !_orderId) {
        try { const _tx = await _swFindTransaction(_txId, contactId); if (_tx && _tx.entityId) _orderId = _tx.entityId; } catch (_) {}
      }
      let _productIds = [];
      if (_orderId) {
        try {
          const _order = await _swGhlGetRetry('/payments/orders/' + encodeURIComponent(_orderId), { altId: _LOC, altType: 'location' });
          const _items = (_order && _order.items) || [];
          _productIds = [...new Set(_items.map((it) => (it.product && it.product._id) || it.productId).filter(Boolean))];
        } catch (_) {}
      }
      const _emap = loadEntitlementProductMappings();
      const _matched = _productIds.map((pid) => ({ pid, m: (_emap.products || {})[pid] })).filter((x) => x.m);
      const _store = loadMemberEntitlements();
      const _idem = (_isRefund ? 'evidence:refund:' : 'evidence:grant:') + (_orderId || _txId);
      if ((_orderId || _txId) && _store.processedWebhookIds.includes(_idem)) {
        noteWebhookEvent('member_access', 'duplicate', { reason: 'evidence_replay' });
        sendJson(res, 200, { ok: true, duplicate: true, contactId, orderId: _orderId }, origin); return;
      }
      if (!_matched.length) {
        noteWebhookEvent('member_access', 'unknown_resource', { reason: 'no_mapped_product' });
        console.log('[Gaia Entitlements] member-access evidence no-op: no compatible product mapping', { contactId, orderId: _orderId, productIds: _productIds });
        sendJson(res, 202, { ok: true, applied: false, reason: 'no_mapped_product', productIds: _productIds }, origin); return;
      }
      const _now = new Date().toISOString();
      const _rec = _store.contacts[contactId] || { contactId, tags: [], tier: null, courses: [], communities: [], subscriptions: [], domainUpdatedAt: {}, updatedAt: _now };
      _rec.courses = Array.isArray(_rec.courses) ? _rec.courses : [];
      const _granted = [];
      for (const { pid, m } of _matched) {
        const _et = String(m.entitlement_type || '').toUpperCase();
        if (_et === 'MEMBERSHIP') {
          const _tier = String(m.membership_tier || '').toLowerCase();
          const _act = _isRefund ? 'end' : 'activate';
          const _b = membershipFromEvent({ tier: _tier, source: 'ghl_payment', evidenceId: _orderId || _txId }, { action: _act, rawType: _isRefund ? 'evidence_refund' : 'evidence_payment', now: new Date() });
          if (!_b.error) { _rec.membership = normalizeMembership(_b.membership, { now: new Date() }); }
          _granted.push({ type: 'MEMBERSHIP', action: _isRefund ? 'revoked' : 'granted', tier: _tier, product: pid });
        } else if (_et === 'COURSE') {
          const _cid = String(m.course_id || m.course_name || pid);
          const _cname = String(m.course_name || m.course_id || 'Course');
          const _idx = _rec.courses.findIndex((c) => String(c.id).toLowerCase() === _cid.toLowerCase() || String(c.name || '').toLowerCase() === _cname.toLowerCase());
          if (_isRefund) {
            if (_idx >= 0) _rec.courses.splice(_idx, 1);
            _granted.push({ type: 'COURSE', action: 'revoked', course: _cname, product: pid });
          } else {
            const _item = { id: _cid, name: _cname, state: 'unlocked', openUrl: '', matchedBy: 'payment:' + (_orderId || _txId), updatedAt: _now };
            if (_idx >= 0) _rec.courses[_idx] = { ..._rec.courses[_idx], ..._item }; else _rec.courses.push(_item);
            _granted.push({ type: 'COURSE', action: 'granted', course: _cname, product: pid });
          }
          _rec.domainUpdatedAt = _rec.domainUpdatedAt || {}; _rec.domainUpdatedAt.courses = _now;
        }
      }
      _rec.updatedAt = _now;
      _store.contacts[contactId] = _rec;
      if (_orderId || _txId) _store.processedWebhookIds.push(_idem);
      try { saveMemberEntitlements(_store); } catch (_) {}
      console.log('[Gaia Entitlements] member-access evidence grant', { contactId, orderId: _orderId, granted: _granted });
      sendJson(res, 200, { ok: true, applied: true, contactId, orderId: _orderId, granted: _granted }, origin); return;
    }
  }
  const event = classifyEntitlementEvent(body);
  if (!event.kind) { sendJson(res, 422, { ok: false, error: 'Unsupported entitlement event type.' }, origin); return; }

  // An unrecognised membership event must not fall through to a grant.
  if (event.kind === 'tier' && !event.membershipAction) {
    sendJson(res, 422, {
      ok: false, applied: false,
      error: 'Unrecognised membership event type.',
      received: event.raw,
    }, origin);
    return;
  }

  const webhookId = firstNonEmptyString(req.headers['x-ghl-webhook-id'], body.webhookId, body.idempotencyKey, body.eventId);
  const store = loadMemberEntitlements();
  if (webhookId && store.processedWebhookIds.includes(webhookId)) {
    noteWebhookEvent('member_access', 'duplicate', { reason: 'webhook_id_replay' });
    sendJson(res, 200, { ok: true, duplicate: true, contactId }, origin);
    return;
  }
  const arrivalMs = Date.now();
  const now = new Date(arrivalMs).toISOString();
  let membershipNotes = [];
  const record = store.contacts[contactId] || { contactId, tags: [], tier: null, courses: [], communities: [], subscriptions: [], domainUpdatedAt: {}, updatedAt: now };
  record.tags = uniqueStrings(record.tags || []);
  record.courses = Array.isArray(record.courses) ? record.courses : [];
  record.communities = Array.isArray(record.communities) ? record.communities : [];
  record.subscriptions = Array.isArray(record.subscriptions) ? record.subscriptions : [];
  record.domainUpdatedAt = record.domainUpdatedAt && typeof record.domainUpdatedAt === 'object' ? record.domainUpdatedAt : {};
  record.order = record.order && typeof record.order === 'object' ? record.order : {};

  // ── ordering guard ────────────────────────────────────────────────────────
  // Delivery order is not event order. Each resource carries its own watermark
  // so a delayed revoke cannot delete a newer grant, and so an event about one
  // course never blocks an event about another.
  const stamp = eventTimestamp(body, req.headers, arrivalMs);
  const seq = eventSequence(body);
  const orderResource = event.kind === 'course' || event.kind === 'community'
    ? normalizeEntitlementResource(body, event.kind)
    : null;
  // Canonical ordering key. The delete path matches a revoke to a stored row by
  // id, name, group-key OR learned alias, but resourceKey() keys only on the raw
  // id-or-name the event happened to carry. Keyed naively, a name-only revoke
  // ('course:<name>') and the grant it targets ('course:<id>') land on different
  // watermarks, so decideOrder sees no prior marker for the revoke and accepts it
  // as the first event — deleting a strictly newer grant. Resolve the event to
  // its existing row first and key the watermark by THAT row's identity, so both
  // the grant and any later revoke for the same course share one watermark.
  let orderMatchIndex = -1;
  let keyResource = orderResource;
  if (event.kind === 'course' || event.kind === 'community') {
    const olist = event.kind === 'course' ? record.courses : record.communities;
    orderMatchIndex = event.kind === 'course'
      ? resolveEntitlementMatch(olist, orderResource, store)
      : olist.findIndex((item) => (orderResource.id && String(item.id) === String(orderResource.id))
          || (orderResource.name && String(item.name || '').toLowerCase() === orderResource.name.toLowerCase()));
    if (orderMatchIndex >= 0) keyResource = olist[orderMatchIndex];
  }
  const key = resourceKey(event.kind, keyResource);
  const decision = decideOrder(
    { ms: stamp.ms, basis: stamp.basis, eventId: webhookId, seq },
    record.order[key],
  );

  if (!decision.accept) {
    noteRejection(record, {
      at: now, resource: key, eventId: webhookId || null,
      action: event.grant === null ? event.kind : (event.grant ? 'grant' : 'revoke'),
      reason: decision.reason,
      incomingAt: new Date(stamp.ms).toISOString(), incomingBasis: stamp.basis,
      storedAt: record.order[key]?.at || null,
    });
    store.contacts[contactId] = record;
    if (webhookId) store.processedWebhookIds.push(webhookId);
    try { saveMemberEntitlements(store); } catch (_) { /* reported below */ }
    noteWebhookEvent('member_access', 'stale', { reason: 'out_of_order' });
    console.log('[Gaia Entitlements] event ignored as out of order', {
      contactId, resource: key, reason: decision.reason, eventId: webhookId,
    });
    sendJson(res, 200, {
      ok: true, applied: false, stale: true, contactId,
      resource: key, reason: decision.reason,
    }, origin);
    return;
  }

  if (event.kind === 'tags') {
    const tags = body.tags || body.contact?.tags || body.data?.tags || body.data?.contact?.tags;
    if (Array.isArray(tags)) record.tags = uniqueStrings(tags);
  } else if (event.kind === 'tier') {
    const nestedMembership = (body.membership && typeof body.membership === 'object') ? body.membership : {};
    const billingIds = [
      body.priceId, body.price_id, body.productId, body.product_id,
      nestedMembership.priceId, nestedMembership.productId,
    ].filter(Boolean).map(String);
    const billingMatch = tierFromBillingIds(billingIds);
    if (!billingMatch) {
      console.warn('[Gaia Entitlements] membership event rejected: no canonical billing id', {
        contactId, event: event.raw, billingIdCount: billingIds.length,
      });
      sendJson(res, 202, {
        ok: true, applied: false, rejected: true,
        reason: billingIds.length ? 'UNMAPPED_BILLING_ID' : 'BILLING_ID_REQUIRED',
        contactId,
      }, origin);
      return;
    }
    // The canonical billing id decides the tier — membershipFromEvent resolves
    // it from the id itself and prefers it over any claim in the body.
    //
    // The body is passed through UNCHANGED on purpose. Overwriting `tier` with
    // the billing-derived key first made the claim and the id agree by
    // construction, so the "payload claimed X but billing id says Y" note could
    // never fire: a workflow misconfigured to send Gold against a Silver price
    // was silently corrected and nothing recorded that it had lied. The
    // correction is right; losing the evidence of it is not.
    const built = membershipFromEvent(body, { action: event.membershipAction, rawType: event.raw, now: new Date(arrivalMs) });
    if (built.error) {
      sendJson(res, 422, { ok: false, applied: false, error: built.error }, origin);
      return;
    }
    // Canonical state the Phase 1 resolver actually reads. Validated through
    // the frozen ledger schema rather than assembled ad hoc here.
    record.membership = normalizeMembership(built.membership, { now: new Date(arrivalMs) });
    membershipNotes = built.notes || [];
    // Legacy mirror, kept for diagnostics and any older consumer. It is not
    // read by the resolver and must never be treated as authority.
    const legacyTier = normalizeTierName(built.membership.key);
    record.tier = event.membershipAction === 'activate' && legacyTier
      ? { name: legacyTier, matchedBy: `webhook:${event.raw || 'tier'}`, updatedAt: now }
      : null;
  } else {
    const resource = normalizeEntitlementResource(body, event.kind);
    if (!resource.id && !resource.name) { sendJson(res, 422, { ok: false, error: `${event.kind} id or name is required.` }, origin); return; }
    const listName = event.kind === 'course' ? 'courses' : 'communities';
    const list = record[listName];
    // Learn a real-id ↔ name-key alias only when the payload carries a real id
    // AND a real human name — not the id echoed back by the normalizer's
    // fallback — so an id-only event never pollutes the registry with junk.
    if (event.kind === 'course' && resource.rawId && resource.name && resource.name !== resource.rawId) {
      learnCourseAlias(store, resource.rawId, resource.name);
    }
    // Resolved once already, when the ordering key was derived above. Reusing it
    // keeps the watermark's identity and the row we mutate perfectly in step.
    const index = orderMatchIndex;
    if (event.grant) {
      // On a match, keep the human name if the incoming event lacks one (an
      // id-only grant must not blank out a backfill row's display title), and
      // adopt a real product id onto the row so it becomes fully keyed.
      const prev = index >= 0 ? list[index] : null;
      // ── Authority gate (courses only) ─────────────────────────────
      // Creating OR re-affirming a course entitlement requires the incoming
      // course to resolve against GHL AUTHORITY or an approved alias — the
      // ledger is never authority. This runs even when the contact already
      // holds the row (index>=0), so a stale/forged webhook can never turn an
      // existing legacy row into an authorization. On rejection the existing
      // row is left exactly as-is (the owner keeps access) and only a
      // reviewable rejection is logged. On success the SERVER id/title win.
      let resolved = null;
      if (event.kind === 'course') {
        const aidx = buildCourseAuthorityIndex();
        const r = resolveCourseGrant(aidx, resource);
        if (r.course) {
          resolved = r;
        } else {
          const rkey = courseGroupKey(resource.name || '');
          let reason = r.reject || 'UNKNOWN_RESOURCE';
          if (reason === 'UNKNOWN_RESOURCE' && rkey && courseLegacyKeySet(store, aidx).has(rkey)) reason = 'LEGACY_UNVERIFIED';
          recordCourseGrantRejection(store, contactId, {
            at: now, action: 'grant', event: event.raw || null,
            id: resource.rawId || resource.id || null, name: resource.name || null,
            reason, already_held: index >= 0,
          });
          try { saveMemberEntitlements(store); } catch (_) {}
          noteWebhookEvent('member_access', 'unknown_resource', { reason: String(reason || 'unknown_resource') });
          console.warn('[Gaia Entitlements] course grant rejected', { contactId, reason, id: resource.rawId || resource.id, name: resource.name, alreadyHeld: index >= 0 });
          sendJson(res, 202, { ok: true, applied: false, rejected: true, reason, contactId, requested: { id: resource.rawId || resource.id || null, name: resource.name || null } }, origin);
          return;
        }
      }
      const realName = resolved ? resolved.course.title
        : (resource.name && resource.name !== resource.rawId ? resource.name : (prev && prev.name) || resource.name);
      const item = {
        id: resolved ? resolved.course.id : (resource.rawId || (prev && prev.id) || resource.id),
        name: realName,
        state: 'unlocked',
        openUrl: firstNonEmptyString(resource.openUrl, prev && prev.openUrl),
        matchedBy: resolved ? `webhook:${event.raw}:${resolved.method}` : `webhook:${event.raw}`,
        ...(resolved ? { resolutionMethod: resolved.method } : {}),
        updatedAt: now,
      };
      if (index >= 0) list[index] = { ...list[index], ...item };
      else list.push(item);
    } else if (index >= 0) {
      list.splice(index, 1);
    } else if (event.kind === 'course') {
      // A revoke we could not map (e.g. an id-only event for a course no grant
      // webhook has yet taught us). Never guess which course to remove — log it
      // for review rather than silently dropping the wrong access.
      record.unmatchedRevokes = Array.isArray(record.unmatchedRevokes) ? record.unmatchedRevokes : [];
      record.unmatchedRevokes.push({ at: now, id: resource.rawId || resource.id || null, name: resource.name || null, event: event.raw || null });
      recordCourseGrantRejection(store, contactId, { at: now, action: 'revoke', event: event.raw || null, id: resource.rawId || resource.id || null, name: resource.name || null, reason: 'INVALID_REVOKE' });
      console.log('[Gaia Entitlements] revoke did not match any stored course', { contactId, id: resource.rawId || resource.id, name: resource.name });
    }
  }

  const eventDomain = event.kind === 'course' ? 'courses'
    : (event.kind === 'community' ? 'communities' : event.kind);
  record.domainUpdatedAt[eventDomain] = now;
  // The accepted watermark is the SOURCE time, not the arrival time, so a later
  // comparison asks "which event happened first" rather than "which arrived first".
  record.order[key] = watermark({
    ms: stamp.ms, basis: stamp.basis, eventId: webhookId, seq,
    action: event.grant === null ? event.kind : (event.grant ? 'grant' : 'revoke'),
    appliedAt: now,
  });
  if (decision.lowConfidence) record.order[key].lowConfidence = true;
  record.updatedAt = now;
  store.contacts[contactId] = record;
  if (webhookId) store.processedWebhookIds.push(webhookId);
  try { saveMemberEntitlements(store); }
  catch (err) {
    // Everything about the event was valid and the write failed. That is its
    // own failure class: not auth, not mapping, not identity.
    noteWebhookEvent('member_access', 'rejected_other', { reason: 'persistence_failed' });
    console.error('[Gaia Entitlements] save failed', { error: err.message.split('\n')[0] });
    sendJson(res, 500, { ok: false, error: 'Unable to persist entitlement update.' }, origin);
    return;
  }
  noteWebhookEvent('member_access', 'accepted');
  noteWebhookEvent('member_access', event.grant ? 'grant' : 'revoke');
  console.log('[Gaia Entitlements] access updated', { contactId, event: event.raw, kind: event.kind, grant: event.grant, authMethod });
  sendJson(res, 200, {
    ok: true, applied: true, contactId, kind: event.kind, grant: event.grant,
    resource: key, orderBasis: stamp.basis, orderReason: decision.reason,
    ...(decision.lowConfidence ? { lowConfidence: true } : {}),
    ...(event.kind === 'tier' ? {
      membership: record.membership,
      ...(membershipNotes.length ? { notes: membershipNotes } : {}),
    } : {}),
    updatedAt: now,
  }, origin);
}

function backfillAuthorized(req) {
  // This route is for a trusted server-side import only, never a browser.
  if (req.headers.origin || req.headers['sec-fetch-site']) return false;
  const supplied = String(req.headers['x-backfill-secret'] || req.headers['x-webhook-secret'] || '').trim();
  return GHL_BACKFILL_SECRET.length >= 32 && safeSecretEqual(supplied, GHL_BACKFILL_SECRET);
}

function normalizedBackfillResources(items, resourceType, snapshotAt) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const normalized = [];
  for (const raw of items) {
    const source = typeof raw === 'string' ? { name: raw } : (raw && typeof raw === 'object' ? raw : {});
    const resource = normalizeEntitlementResource(source, resourceType);
    const key = String(resource.id || resource.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      id: resource.id,
      name: resource.name,
      state: 'unlocked',
      openUrl: resource.openUrl,
      matchedBy: 'backfill:ghl',
      updatedAt: snapshotAt,
    });
  }
  return normalized;
}

function normalizedBackfillSubscriptions(value, snapshotAt) {
  const items = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  return items.map((raw) => ({
    id: firstNonEmptyString(raw.id, raw._id, raw.subscriptionId),
    status: firstNonEmptyString(raw.status, raw.subscriptionStatus),
    name: firstNonEmptyString(raw.name, raw.plan, raw.planName, raw.offerName, raw.productName),
    entitySourceName: firstNonEmptyString(raw.entitySourceName, raw.offerName, raw.plan, raw.planName),
    renewalDate: firstNonEmptyString(raw.renewalDate, raw.nextBillingDate, raw.currentPeriodEnd),
    createdAt: firstNonEmptyString(raw.createdAt, raw.subscriptionStartDate),
    updatedAt: firstNonEmptyString(raw.updatedAt, snapshotAt),
  })).filter((item) => item.id || item.name || item.entitySourceName);
}

async function memberBackfill(req, res, origin) {
  if (!backfillAuthorized(req)) {
    console.warn('[Gaia Entitlements] backfill rejected: invalid authentication or browser request');
    sendJson(res, 403, { ok: false, error: 'Invalid backfill authentication.' }, origin);
    return;
  }
  let rawBody = '';
  try { rawBody = await readRawBody(req, 2 * 1024 * 1024); }
  catch (_) { sendJson(res, 413, { ok: false, error: 'Request body is too large.' }, origin); return; }
  let body;
  try { body = rawBody ? JSON.parse(rawBody) : {}; }
  catch (_) { sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' }, origin); return; }

  const contacts = Array.isArray(body.contacts) ? body.contacts : [body];
  if (!contacts.length || contacts.length > 250) {
    sendJson(res, 422, { ok: false, error: 'Provide between 1 and 250 contacts per request.' }, origin);
    return;
  }
  const defaultSnapshotAt = firstNonEmptyString(body.snapshotAt);
  const defaultSource = firstNonEmptyString(body.snapshotSource, 'ghl');
  const store = loadMemberEntitlements();
  const result = { applied: 0, stale: 0, duplicate: 0, rejected: 0 };

  for (const item of contacts) {
    const contactId = firstNonEmptyString(item?.contactId, item?.contact_id);
    const snapshotAt = firstNonEmptyString(item?.snapshotAt, defaultSnapshotAt);
    const snapshotMs = Date.parse(snapshotAt);
    const snapshotSource = firstNonEmptyString(item?.snapshotSource, defaultSource, 'ghl');
    if (!contactId || !Number.isFinite(snapshotMs)) { result.rejected += 1; continue; }
    const snapshotDomains = ['courses', 'communities', 'subscriptions', 'subscription', 'tags']
      .filter((domain) => Object.prototype.hasOwnProperty.call(item, domain))
      .map((domain) => domain === 'subscription' ? 'subscriptions' : domain);
    const snapshotKey = `backfill:${snapshotSource}:${snapshotAt}:${contactId}:${uniqueStrings(snapshotDomains).sort().join(',')}`;
    if (store.processedWebhookIds.includes(snapshotKey)) { result.duplicate += 1; continue; }

    const now = new Date().toISOString();
    const record = store.contacts[contactId] || { contactId, tags: [], tier: null, courses: [], communities: [], subscriptions: [], domainUpdatedAt: {}, updatedAt: now };
    record.tags = uniqueStrings(record.tags || []);
    record.courses = Array.isArray(record.courses) ? record.courses : [];
    record.communities = Array.isArray(record.communities) ? record.communities : [];
    record.subscriptions = Array.isArray(record.subscriptions) ? record.subscriptions : [];
    record.domainUpdatedAt = record.domainUpdatedAt && typeof record.domainUpdatedAt === 'object' ? record.domainUpdatedAt : {};
    let contactApplied = false;
    let contactStale = false;
    const applyDomain = (domain, value) => {
      // A snapshot must lose to fresher live evidence. Two guards: the legacy
      // domain timestamp, and the newest per-resource watermark accepted from a
      // webhook — the latter is source time, so a snapshot taken before a live
      // event cannot overwrite it even if it was uploaded afterwards.
      const kind = domain === 'courses' ? 'course' : (domain === 'communities' ? 'community' : domain);
      if (snapshotMs < domainWatermarkMs(record, kind)) { contactStale = true; return; }
      if (snapshotMs < entitlementDomainTimestamp(record, domain)) { contactStale = true; return; }
      record[domain] = value;
      record.domainUpdatedAt[domain] = snapshotAt;
      contactApplied = true;
    };

    if (Object.prototype.hasOwnProperty.call(item, 'courses')) {
      applyDomain('courses', normalizedBackfillResources(item.courses, 'course', snapshotAt));
    }
    if (Object.prototype.hasOwnProperty.call(item, 'communities')) {
      applyDomain('communities', normalizedBackfillResources(item.communities, 'community', snapshotAt));
    }
    if (Object.prototype.hasOwnProperty.call(item, 'subscriptions') || Object.prototype.hasOwnProperty.call(item, 'subscription')) {
      applyDomain('subscriptions', normalizedBackfillSubscriptions(item.subscriptions ?? item.subscription, snapshotAt));
    }
    if (Object.prototype.hasOwnProperty.call(item, 'tags')) {
      applyDomain('tags', uniqueStrings(Array.isArray(item.tags) ? item.tags : []));
    }

    if (contactApplied) {
      record.updatedAt = now;
      record.lastSnapshot = { source: snapshotSource, snapshotAt, importedAt: now };
      store.contacts[contactId] = record;
      result.applied += 1;
    } else if (contactStale) {
      result.stale += 1;
    } else {
      result.rejected += 1;
    }
    store.processedWebhookIds.push(snapshotKey);
  }

  try { saveMemberEntitlements(store); }
  catch (err) {
    console.error('[Gaia Entitlements] backfill save failed', { error: err.message.split('\n')[0] });
    sendJson(res, 500, { ok: false, error: 'Unable to persist backfill.' }, origin);
    return;
  }
  console.log('[Gaia Entitlements] GHL backfill processed', result);
  sendJson(res, result.rejected ? 207 : 200, { ok: result.rejected === 0, ...result }, origin);
}

function sendSseHeaders(res, origin) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    ...corsHeaders(origin),
  });
}

function writeSse(res, event, data = {}) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const GEMINI_LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || 'Puck';
const GEMINI_LIVE_MAX_SECONDS = clampNumber(
  Number(process.env.GEMINI_LIVE_MAX_SECONDS || 900),
  30,
  900,
  900,
);

function publicTtsOrder() {
  return [...new Set([...TTS_PROVIDER_ORDER, 'browser'])];
}

function hasAnyBackendTtsProvider() {
  return Boolean(
    process.env.OPENAI_API_KEY
    || (process.env.ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID)
    || (process.env.OPENAI_COMPATIBLE_TTS_API_KEY && process.env.OPENAI_COMPATIBLE_TTS_BASE_URL)
  );
}

function safeOpenAiVoice(value, fallback) {
  const voice = String(value || '').trim().toLowerCase();
  const allowed = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
  return allowed.has(voice) ? voice : fallback;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchJsonIfOk(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const next = String(value || '').trim();
    if (next) return next;
  }
  return '';
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readRawBody(req, maxBytes = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return '';
  return Buffer.concat(chunks).toString('utf8');
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function authSessionSecret() {
  const secret = String(process.env.AUTH_SESSION_SECRET || '').trim();
  if (secret.length < 32) {
    throw new Error('AUTH_SESSION_SECRET must be set and at least 32 characters.');
  }
  return secret;
}

function signTokenPayload(payload) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', authSessionSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSignedToken(token) {
  if (!token || !String(token).includes('.')) return null;
  const [body, sig] = String(token).split('.', 2);
  const expected = crypto.createHmac('sha256', authSessionSecret()).update(body).digest('base64url');
  const left = Buffer.from(sig || '', 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp && Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader = '') {
  const entries = String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      return idx === -1 ? [part, ''] : [part.slice(0, idx), part.slice(idx + 1)];
    });
  return Object.fromEntries(entries);
}

function cookieForRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return readSignedToken(cookies[AUTH_SESSION_COOKIE] || '');
}

function requestIsSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted || false;
}

function buildSetCookie(req, value, expiresAtMs) {
  const parts = [
    `${AUTH_SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=None',
    'Secure',
    `Max-Age=${Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000))}`,
  ];
  return parts.join('; ');
}

function buildClearCookie() {
  return [
    `${AUTH_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=None',
    'Secure',
    'Max-Age=0',
  ].join('; ');
}

function normalizeMemberIdentity(input = {}) {
  const displayName = String(
    input.displayName
    || input.name
    || input.fullName
    || [input.firstName, input.lastName].filter(Boolean).join(' ')
    || 'Gaia Healers member',
  ).trim();
  return {
    memberId: String(input.memberId || input.member_id || input.contactId || input.contact_id || '').trim(),
    contactId: String(input.contactId || input.contact_id || input.memberId || input.member_id || '').trim(),
    email: String(input.email || '').trim().toLowerCase(),
    displayName,
    role: String(input.role || 'Member').trim() || 'Member',
    cohort: String(input.cohort || input.group || '').trim(),
    locationId: String(input.locationId || input.location_id || '').trim(),
    source: String(input.source || 'unknown').trim() || 'unknown',
  };
}

function createMemberSession(identity = {}, source = 'auth', options = {}) {
  const member = normalizeMemberIdentity({ ...identity, source });
  const exp = Date.now() + (AUTH_SESSION_TTL_SECONDS * 1000);
  return {
    sub: member.memberId || member.contactId || member.email || member.displayName,
    member,
    source,
    // Whether this session PROVED the email address, as opposed to being told
    // it. Carried as an explicit flag because `source` alone cannot answer it:
    // the embedded-claim path uses one source string for both a GHL-verified
    // member and an unverified fallback, and this value decides whether the
    // address is allowed to unlock an event ticket.
    emailVerified: options.emailVerified === true,
    iat: Date.now(),
    exp,
  };
}

function sessionPublicShape(session) {
  if (!session?.member) return { authenticated: false };
  return {
    authenticated: true,
    source: session.source || 'session',
    member: session.member,
    expiresAt: session.exp || null,
  };
}

// Gate for member-only routes (e.g. /api/assist/*). Reads the signed session
// cookie and returns the session when a member identity is present, or sends a
// 401 and returns null. Usage: `if (!requireMemberSession(req, res, origin)) return;`
function requireMemberSession(req, res, origin) {
  const session = cookieForRequest(req);
  const member = session?.member || {};
  if (!member.email && !member.memberId && !member.contactId) {
    sendJson(res, 401, {
      ok: false,
      error: 'Sign in to use Gaia Assist.',
      reason: 'auth_required',
    }, origin);
    return null;
  }
  return session;
}

function sessionMemberContext(req) {
  const session = cookieForRequest(req);
  if (!session?.member) return null;
  return normalizeMemberIdentity({
    ...session.member,
    source: session.source || 'session',
  });
}

function trustedReferrer(referrer = '') {
  const value = String(referrer || '').trim();
  if (!value) return false;
  return AUTH_TRUSTED_REFERRERS.some((prefix) => value.startsWith(prefix));
}

function safeReturnUrl(returnTo = '') {
  const fallback = `${APP_PUBLIC_URL}${String(APP_PUBLIC_URL).includes('?') ? '&' : '?'}auth=1`;
  const value = String(returnTo || '').trim();
  if (!value) return fallback;
  try {
    const url = new URL(value);
    const allowed = [
      'gaiahealers.app',
      'www.gaiahealers.app',
      'app.gaiahealers.app',
      'gaiagitshare.github.io',
      'crm.gaiahealers.com',
      'education.gaiahealers.com',
    ];
    return allowed.includes(url.host) ? value : fallback;
  } catch {
    return fallback;
  }
}

function sendRedirect(res, location, origin, extraHeaders = {}) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
    ...extraHeaders,
  });
  res.end();
}

async function resolveMemberRecord({ email = '', memberId = '', contactId = '' } = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedMemberId = String(memberId || contactId || '').trim();
  if (!normalizedEmail && !normalizedMemberId) return null;

  try {
    const ghlMember = await getMemberFromGhl({
      email: normalizedEmail,
      memberId: normalizedMemberId,
      contactId: normalizedMemberId,
    });
    if (ghlMember?.memberResolved) {
      return normalizeMemberIdentity({
        memberId: ghlMember.member?.memberId || normalizedMemberId,
        contactId: ghlMember.member?.contactId || normalizedMemberId,
        email: ghlMember.member?.email || normalizedEmail,
        displayName: ghlMember.member?.displayName || 'Gaia Healers member',
        role: ghlMember.member?.role || 'Member',
        cohort: ghlMember.member?.cohort || '',
        source: 'ghl-contact',
      });
    }
  } catch {}

  const baseContextUrl = new URL('http://localhost');
  if (normalizedEmail) baseContextUrl.searchParams.set('email', normalizedEmail);
  if (normalizedMemberId) {
    baseContextUrl.searchParams.set('memberId', normalizedMemberId);
    baseContextUrl.searchParams.set('contactId', normalizedMemberId);
  }

  try {
    const academy = await getAcademyProgress(baseContextUrl);
    if (academy?.configured && (academy?.liveData || academy?.member?.email || normalizedEmail)) {
      return normalizeMemberIdentity({
        memberId: normalizedMemberId,
        contactId: normalizedMemberId,
        email: academy.member?.email || normalizedEmail,
        name: academy.member?.name || 'Gaia Healers member',
        source: academy.source || 'academy-progress',
      });
    }
  } catch {}

  try {
    const hub = await getMemberHub(baseContextUrl, FALLBACK_ACADEMY);
    if (hub?.configured && (hub?.liveData || hub?.member?.displayName || normalizedEmail)) {
      return normalizeMemberIdentity({
        memberId: normalizedMemberId,
        contactId: normalizedMemberId,
        email: normalizedEmail,
        displayName: hub.member?.displayName || 'Gaia Healers member',
        role: hub.member?.role || 'Member',
        cohort: hub.member?.cohort || '',
        source: hub.source || 'member-hub',
      });
    }
  } catch {}

  if (AUTH_ALLOW_UNVERIFIED_EMAIL_MAGIC_LINK && normalizedEmail) {
    return normalizeMemberIdentity({
      memberId: normalizedMemberId,
      contactId: normalizedMemberId,
      email: normalizedEmail,
      displayName: normalizedEmail.split('@')[0].replace(/[._-]+/g, ' '),
      source: 'unverified-email',
    });
  }

  return null;
}

function memberContextFromRequest(req, url) {
  const sessionMember = sessionMemberContext(req);
  if (sessionMember) return { ...sessionMember, authenticated: true };
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const memberId = String(url.searchParams.get('memberId') || url.searchParams.get('contactId') || '').trim();
  if (email || memberId) {
    return normalizeMemberIdentity({ email, memberId, contactId: memberId, source: 'query' });
  }
  return null;
}

function withMemberContext(url, memberContext) {
  const scoped = new URL(url.toString());
  // Identity always comes from the signed session. Never pass caller-supplied
  // member identifiers through to an upstream service.
  scoped.searchParams.delete('memberId');
  scoped.searchParams.delete('contactId');
  scoped.searchParams.delete('email');
  if (!memberContext) return scoped;
  if (memberContext.memberId || memberContext.contactId) {
    const value = memberContext.memberId || memberContext.contactId;
    scoped.searchParams.set('memberId', value);
    scoped.searchParams.set('contactId', value);
  }
  if (memberContext.email) scoped.searchParams.set('email', memberContext.email);
  return scoped;
}

function ghlConfig() {
  const base = (process.env.GHL_API_BASE_URL || '').replace(/\/+$/, '');
  const token = String(process.env.GHL_API_TOKEN || '').trim();
  const locationId = String(process.env.GHL_LOCATION_ID || '').trim();
  const version = String(process.env.GHL_API_VERSION || '2021-07-28').trim();
  return {
    base,
    token,
    locationId,
    version,
    enabled: Boolean(base && token && locationId),
  };
}

function ghlHeaders(token, version) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Version: version,
  };
}

// ── Smart Webhook: one generic GHL Payment webhook for ALL events ───────────
// GHL can't hand us the purchased product in the body (only payment.transaction_id
// is available as a merge field), so a single generic webhook posts the
// transaction id + contact context here; we look the order up through the same
// authorized GHL API the reconciler uses, resolve the product against the ONE
// mapping source of truth (Event Manager ticket_mappings), and upsert the
// attendee through the SAME idempotent endpoint the reconciler calls. That makes
// the instant path race-safe with the 60s reconciler by construction: both funnel
// through reconcile-attendee, keyed on (event,email), so double-processing updates
// rather than duplicates. Nothing here hard-codes an event, product or tier.
function _swSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function _swGhlGetRetry(path, params, tries) {
  tries = tries || 3;
  for (let i = 0; i < tries; i++) {
    try { const r = await ghlGet(path, params); if (r !== null && r !== undefined) return r; } catch (e) { /* transient */ }
    await _swSleep(350 * (i + 1));
  }
  return null;
}
// Resolve the EXACT transaction by id — never assume the newest belongs to this
// webhook. Paginate so an old/delayed/out-of-order payment still resolves; a
// contactId keeps the scan bounded even for a prolific buyer.
async function _swFindTransaction(txId, contactId) {
  const limit = 100; const maxPages = 6;
  for (let page = 0; page < maxPages; page++) {
    const params = { altId: process.env.GHL_LOCATION_ID, altType: 'location', limit, offset: page * limit };
    if (contactId) params.contactId = contactId;
    const list = await _swGhlGetRetry('/payments/transactions', params);
    const arr = (list && (list.data || list.transactions)) || [];
    const hit = arr.find((t) => String(t._id) === String(txId));
    if (hit) return hit;
    if (arr.length < limit) break;
  }
  return null;
}

async function handleGhlPaymentWebhook(req, res, origin) {
  const EMBASE = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  const SVC = (process.env.IDENTITY_SERVICE_TOKEN || '').trim();
  const LOC = (process.env.GHL_LOCATION_ID || '').trim();
  const expected = (process.env.REGISTRATION_WEBHOOK_SECRET || '').trim();

  // 1) Auth — shared secret, header or ?secret=, timing-safe. Never logged.
  let qSecret = '';
  try { qSecret = new URL(req.url, 'http://localhost').searchParams.get('secret') || ''; } catch (e) { /* noop */ }
  const supplied = String(req.headers['x-gaia-secret'] || qSecret || '');
  if (!expected || !SVC) { sendJson(res, 503, { ok: false, error: 'webhook_not_configured' }, origin); return; }
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn(JSON.stringify({ evt: 'smart_webhook', outcome: 'forbidden_bad_secret' }));
    sendJson(res, 403, { ok: false, error: 'invalid_secret' }, origin); return;
  }

  // 2) Body — need a transaction id; contact fields are a best-effort fallback.
  let body = {};
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { ok: false, error: 'bad_json' }, origin); return; }
  const txId = String(body.transaction_id || body.transactionId || body.payment_transaction_id || '').trim();
  const log = (o) => { try { console.log(JSON.stringify({ evt: 'smart_webhook', transaction_id: txId || null, ...o })); } catch (e) { /* noop */ } };
  if (!txId) { log({ outcome: 'missing_transaction_id' }); sendJson(res, 400, { ok: false, error: 'missing_transaction_id' }, origin); return; }

  try {
    // 3) transaction -> order id (entityId) + buyer identity
    // Resolve by the EXACT transaction id (hardened: paginated + retried).
    const _cid = body.contact_id || body.contactId;
    const tx = await _swFindTransaction(txId, _cid);
    if (!tx) { log({ outcome: 'transaction_not_found' }); sendJson(res, 202, { ok: false, matched: 0, reason: 'transaction_not_found' }, origin); return; }
    if (!tx.entityId) { log({ outcome: 'no_order_on_transaction' }); sendJson(res, 202, { ok: false, matched: 0, reason: 'no_order_on_transaction' }, origin); return; }

    const entityId = tx.entityId || '';
    // A transaction is the payment representation of an ORDER *or* an INVOICE.
    // This branch used to be absent: every entityId was fetched as an order, so
    // an invoice-backed payment 404'd, produced no products, and was filed as an
    // unmapped sale. Five people paid for Elevate 2026 tickets on invoices and
    // got no attendee, no badge and no QR until an audit found them.
    const isInvoice = String(tx.entityType || '').toLowerCase().includes('invoice');
    const orderId = isInvoice ? '' : entityId;
    const invoiceId = isInvoice ? entityId : '';
    let productIds = [];
    let productNames = [];
    let lineQty = new Map();
    let orderAmount = null;
    let snap = {};
    if (isInvoice && invoiceId) {
      const inv = await _swGhlGetRetry(`/invoices/${encodeURIComponent(invoiceId)}`, { altId: LOC, altType: 'location' });
      const body_ = (inv && (inv.invoice || inv)) || {};
      const items = body_.invoiceItems || [];
      productIds = [...new Set(items.map((it) => it.productId).filter(Boolean))];
      productNames = items.map((it) => it.name).filter(Boolean);
      for (const it of items) lineQty.set(String(it.productId || ''), Math.max(1, Number(it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1))));
      orderAmount = body_.amountPaid != null ? body_.amountPaid : (body_.total != null ? body_.total : null);
      const cd = body_.contactDetails || {};
      snap = { email: cd.email, firstName: String(cd.name || '').split(' ')[0],
               lastName: String(cd.name || '').split(' ').slice(1).join(' '), phone: cd.phoneNo };
    } else if (orderId) {
      const order = await _swGhlGetRetry(`/payments/orders/${encodeURIComponent(orderId)}`, { altId: LOC, altType: 'location' });
      const items = (order && order.items) || [];
      productIds = [...new Set(items.map((it) => (it.product && it.product._id) || it.productId).filter(Boolean))];
      // Kept so an unmapped sale can be shown to staff as something they can
      // recognise, not just an opaque id.
      productNames = items.map((it) => (it.product && it.product.name) || it.name).filter(Boolean);
      for (const it of items) lineQty.set(String((it.product && it.product._id) || it.productId || ''), Math.max(1, Number(it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1))));
      orderAmount = (order && order.amount) || null;
      snap = (order && order.contactSnapshot) || {};
    }
    const email = String(tx.contactEmail || snap.email || body.email || '').trim().toLowerCase();
    const first = snap.firstName || body.first_name || '';
    const last = snap.lastName || body.last_name || '';
    const phone = snap.phone || body.phone || '';
    const contactId = tx.contactId || body.contact_id || body.contactId || '';
    if (!email) { log({ outcome: 'no_buyer_email', order_id: orderId }); sendJson(res, 202, { ok: false, matched: 0, reason: 'no_buyer_email' }, origin); return; }

    // 5) Resolve against the single mapping source of truth (Event Manager)
    let maps = [];
    for (let i = 0; i < 3 && maps.length === 0; i++) {
      try {
        const mr = await fetch(`${EMBASE}/identity/ticket-mappings`, { headers: { Authorization: `Bearer ${SVC}` } });
        maps = mr.ok ? await mr.json() : [];
      } catch (e) { maps = []; }
      if (!maps.length) await _swSleep(300 * (i + 1));
    }
    const byPid = new Map();
    const EVENT_TYPES = new Set(['EVENT_TICKET', 'EVENT_UPGRADE']);
    for (const m of maps) if (m.provider === 'ghl' && EVENT_TYPES.has(m.entitlement_type || 'EVENT_TICKET')) byPid.set(m.external_product_id, m);
    let targets = productIds.map((pid) => ({ pid, m: byPid.get(pid) })).filter((x) => x.m);
    // Preserve appropriate pass: apply base mappings first, upgrades last (upgrade wins).
    targets.sort((x, y) => (x.m.is_upgrade ? 1 : 0) - (y.m.is_upgrade ? 1 : 0));

    if (!targets.length) {
      log({ outcome: 'no_mapped_product', order_id: orderId, product_ids: productIds });
      try { recordEntitlementReview(productIds, orderId); } catch (e) { /* review is best-effort */ }
      // Somebody paid for something we do not recognise. A log line is not
      // enough — that is exactly how four people bought a day pass created that
      // morning and nobody noticed for a day. Put it in front of staff, without
      // ever turning a product name into event access.
      try {
        await fetch(`${EMBASE}/identity/report-unmapped-sale`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SVC}` },
          body: JSON.stringify({
            // Record it under the reference it actually has, so a later refund
            // or a Map & Reconcile replay can find the same payment again.
            reference: invoiceId || orderId || txId,
            source: invoiceId ? 'ghl_invoice' : 'ghl_order',
            product_id: productIds[0] || null, product_name: productNames[0] || null,
            buyer_email: email, buyer_name: [first, last].filter(Boolean).join(' '),
            contact_id: contactId, amount: orderAmount, quantity: 1,
            paid_at: new Date().toISOString().slice(0, 10),
          }),
        });
      } catch (e) { /* the sale is already logged; surfacing it must never break the webhook */ }
      // 202: accepted but nothing to do — fails safe, visible in logs, touches nothing.
      sendJson(res, 202, { ok: true, matched: 0, reason: 'no_mapped_product', product_ids: productIds }, origin); return;
    }

    // 6) Idempotent upsert per mapped product (same endpoint as the reconciler)
    const results = [];
    for (const t of targets) {
      let j = null;
      try {
        const qty = lineQty.get(String(t.pid)) || 1;
        // An invoice sale is ledgered under its own id. No order id is ever
        // invented for it, because a made-up reference cannot be refunded later.
        const endpoint = invoiceId ? '/identity/reconcile-invoice' : '/identity/reconcile-attendee';
        const payload = invoiceId
          ? {
            event_id: t.m.event_id, email, invoice_id: invoiceId, transaction_id: txId,
            contact_id: contactId, product_id: t.pid, amount: orderAmount, quantity: qty,
            status: 'paid', first_name: first, last_name: last, phone,
            issued_at: String(tx.createdAt || '').slice(0, 19) || null,
          }
          : {
            event_id: t.m.event_id, email, ticket_type_id: t.m.ticket_type_id,
            first_name: first, last_name: last, phone,
            contact_id: contactId, order_id: orderId || txId, is_upgrade: !!t.m.is_upgrade,
            product_id: t.pid, quantity: qty, amount: orderAmount,
            purchased_at: String(tx.createdAt || '').slice(0, 19) || null,
          };
        const er = await fetch(`${EMBASE}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SVC}` },
          body: JSON.stringify(payload),
        });
        j = er.ok ? await er.json() : null;
      } catch (e) { j = null; }
      results.push({ product_id: t.pid, event_id: t.m.event_id, ticket_type_id: t.m.ticket_type_id, ok: !!(j && j.ok), created: !!(j && j.created) });
      log({ outcome: 'reconciled', order_id: orderId, product_id: t.pid, event_id: t.m.event_id, ticket_type_id: t.m.ticket_type_id, created: !!(j && j.created) });
    }
    // Record the payment itself, whatever it did. The reconciler above only
    // acts on money that arrived; the Payments screen has to show the declined
    // card and the PayPal checkout still sitting in pending, because those are
    // the ones somebody needs to chase.
    try {
      await fetch(`${EMBASE}/identity/payments/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SVC}` },
        body: JSON.stringify({ source: 'webhook', transactions: [{
          transaction: tx,
          order: invoiceId
            ? { status: 'paid', items: productIds.map((p, i) => ({ productId: p, name: productNames[i] })) }
            : { status: 'completed', items: productIds.map((p, i) => ({ productId: p, name: productNames[i] })), amount: orderAmount },
        }] }),
      });
    } catch (e) { /* monitoring must never break a reconciliation */ }

    sendJson(res, 200, { ok: true, transaction_id: txId, order_id: orderId || null,
                         invoice_id: invoiceId || null, matched: results.length, results }, origin);
  } catch (e) {
    log({ outcome: 'error', error: String((e && e.message) || e) });
    // 502 so GHL retries; the 60s reconciler is the backstop regardless.
    sendJson(res, 502, { ok: false, error: 'lookup_failed' }, origin);
  }
}

async function ghlGet(path, params = {}) {
  const cfg = ghlConfig();
  if (!cfg.enabled) return null;
  const query = new URLSearchParams(
    Object.entries(params).reduce((acc, [key, value]) => {
      if (value === undefined || value === null || value === '') return acc;
      acc[key] = String(value);
      return acc;
    }, {}),
  );
  const url = `${cfg.base}${path}${query.toString() ? `?${query.toString()}` : ''}`;
  return fetchJsonIfOk(url, ghlHeaders(cfg.token, cfg.version));
}

async function ghlPost(path, body = {}, version = '') {
  const cfg = ghlConfig();
  if (!cfg.enabled) return null;
  const response = await fetch(`${cfg.base}${path}`, {
    method: 'POST',
    headers: {
      ...ghlHeaders(cfg.token, version || cfg.version),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Upsert a contact into GHL (create or update by email). Requires the PIT to
// carry contacts.write — returns scope_required until that scope is enabled.
async function ghlUpsertContact(fields = {}) {
  const cfg = ghlConfig();
  if (!cfg.enabled) return { ok: false, reason: 'ghl_unconfigured' };
  try {
    const r = await fetch(`${cfg.base}/contacts/upsert`, {
      method: 'POST',
      headers: { ...ghlHeaders(cfg.token, cfg.version), 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: cfg.locationId, ...fields }),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'scope_required' };
    if (!r.ok) return { ok: false, reason: 'ghl_error', status: r.status };
    const d = await r.json().catch(() => ({}));
    return { ok: true, contactId: (d && (d.contact?.id || d.id)) || '' };
  } catch (e) { return { ok: false, reason: 'network', error: String((e && e.message) || e) }; }
}

// Capture an app quiz result as a GHL lead (email + focus-chakra tag). Public,
// rate-limited, never leaks GHL internals, and falls back to a local store so a
// missing GHL write scope can never lose a lead.
const QUIZ_LEAD_REQUESTS = new Map();
async function quizLead(req, res, origin) {
  const body = await readJsonBody(req).catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    sendJson(res, 400, { ok: false, error: 'Valid email required.' }, origin); return;
  }
  const chakra = String(body.chakra || '').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 20);
  const tool = String(body.tool || 'chakra-balance').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const name = String(body.name || '').trim().slice(0, 80);
  const ip = firstNonEmptyString(req.headers['cf-connecting-ip'], String(req.headers['x-forwarded-for'] || '').split(',')[0], req.socket && req.socket.remoteAddress, 'unknown');
  const rlKey = crypto.createHash('sha256').update(ip + '|' + email).digest('hex');
  const cutoff = Date.now() - 15 * 60 * 1000;
  const hits = (QUIZ_LEAD_REQUESTS.get(rlKey) || []).filter((t) => t > cutoff);
  if (hits.length >= 6) { sendJson(res, 429, { ok: false, error: 'Too many requests. Please wait a few minutes.' }, origin, { 'Retry-After': '900' }); return; }
  hits.push(Date.now()); QUIZ_LEAD_REQUESTS.set(rlKey, hits);
  if (QUIZ_LEAD_REQUESTS.size > 10000) { for (const [k, t] of QUIZ_LEAD_REQUESTS) if (!t.some((x) => x > cutoff)) QUIZ_LEAD_REQUESTS.delete(k); }
  const tags = ['gaia-app-lead', 'quiz:' + tool];
  if (chakra) tags.push('focus-chakra:' + chakra);
  let up = { ok: false, reason: 'ghl_unconfigured' };
  try { up = await ghlUpsertContact({ email, ...(name ? { firstName: name.split(/\s+/)[0], name } : {}), tags, source: 'Gaia App - ' + tool }); } catch (_) {}
  if (!up.ok) {
    try {
      const f = path.join(process.cwd(), 'data', 'quiz-leads.json');
      let store; try { store = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { store = { version: 1, items: [] }; }
      store.items = Array.isArray(store.items) ? store.items : [];
      store.items.push({ at: new Date().toISOString(), email, chakra, tool, name, ghl_reason: up.reason || null });
      if (store.items.length > 5000) store.items = store.items.slice(-5000);
      writeJsonAtomic(f, store);
    } catch (_) {}
  }
  console.log('[Gaia Quiz Lead]', JSON.stringify({ ghl: up.ok === true, reason: up.ok ? null : (up.reason || 'error'), tool, chakra }));
  sendJson(res, 200, { ok: true }, origin);
}

/**
 * Operational alerts to whoever runs Gaia.
 *
 * Reuses the GHL conversations email that already delivers magic links in
 * production — no new dependency, no third party, and one place where outbound
 * mail is configured. The recipient is a GHL contact id in ALERT_CONTACT_ID; if
 * that is unset the alert still exists, is still recorded and is still shown in
 * Admin, and this reports `not_configured` rather than pretending to deliver.
 */
async function sendAlertEmail({ subject, html, text }) {
  const contactId = String(process.env.ALERT_CONTACT_ID || '').trim();
  if (!contactId) return { ok: false, reason: 'not_configured' };
  const body = html || String(text || '').split('\n').map((l) => (l ? `<p>${l}</p>` : '')).join('');
  const out = await ghlSendEmail({ contactId, subject, html: body });
  console.log('[Gaia Alerts] notification', JSON.stringify({
    outcome: out.ok ? 'sent' : 'failed', reason: out.reason || null,
    // The subject line only. Never the incident body, never a contact address.
    subject: String(subject || '').slice(0, 80),
  }));
  return out;
}

// Send a transactional email to a GHL contact via the conversations API.
// The PIT carries conversations/messages scope; returns { ok, reason } so
// callers can branch precisely (keeps all email inside GHL).
async function ghlSendEmail({ contactId = '', subject = '', html = '' } = {}) {
  const cfg = ghlConfig();
  if (!cfg.enabled) return { ok: false, reason: 'ghl_unconfigured' };
  if (!contactId) return { ok: false, reason: 'missing_contact' };
  try {
    const r = await fetch(`${cfg.base}/conversations/messages`, {
      method: 'POST',
      headers: {
        ...ghlHeaders(cfg.token, process.env.GHL_CONVERSATIONS_API_VERSION || 'v3'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'Email', contactId, subject, html, status: 'pending' }),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'scope_required' };
    if (r.status < 200 || r.status >= 300) {
      const b = await r.text().catch(() => '');
      return { ok: false, reason: 'ghl_error', status: r.status, detail: b.slice(0, 200) };
    }
    const d = await r.json().catch(() => ({}));
    return { ok: true, messageId: (d && (d.messageId || d.emailMessageId)) || '' };
  } catch (e) { return { ok: false, reason: 'network', error: String((e && e.message) || e) }; }
}

function maskEmailAddress(email = '') {
  const parts = String(email).split('@');
  const user = parts[0] || '';
  const domain = parts[1] || '';
  if (!domain) return email;
  const masked = user.length <= 2 ? (user[0] || '') + '*' : user[0] + '*'.repeat(Math.max(1, user.length - 2)) + user[user.length - 1];
  return masked + '@' + domain;
}

function magicLinkEmailHtml(member = {}, consumeUrl = '') {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const name = (String(member.displayName || '').trim().split(/\s+/)[0]) || 'there';
  const mins = Math.round(AUTH_MAGIC_LINK_TTL_SECONDS / 60);
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a2b20">',
    '<h2 style="margin:0 0 10px;font-size:20px;color:#12281c">Sign in to Gaia Healers</h2>',
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.55">Hi ' + esc(name) + ', tap the button below to sign in to the Gaia Healers app. This link is just for you and expires in ' + mins + ' minutes.</p>',
    '<p style="margin:0 0 22px"><a href="' + consumeUrl + '" style="display:inline-block;background:#2e7d32;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:999px;font-weight:600;font-size:15px">Sign in to Gaia Healers</a></p>',
    '<p style="margin:0 0 6px;font-size:12px;color:#66766c">If the button does not work, copy this link into your browser:</p>',
    '<p style="margin:0;font-size:12px;color:#2e7d32;word-break:break-all">' + consumeUrl + '</p>',
    '<p style="margin:22px 0 0;font-size:12px;color:#8a978f">If you did not request this, you can safely ignore this email.</p>',
    '</div>',
  ].join('');
}

function magicLinkAppUrl(token = '', returnTo = '') {
  // The exchange page lives on the API origin so it can set the HttpOnly API
  // session cookie before returning to the static app. The token remains in the
  // fragment, which is never included in the scanner's HTTP request.
  const target = new URL(`${PROXY_PUBLIC_URL}/api/auth/magic-link/start`);
  const fragment = new URLSearchParams();
  fragment.set('gaia_magic', token);
  target.hash = fragment.toString();
  return target.toString();
}

function authMagicLinkStart(_req, res) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const fallback = JSON.stringify(safeReturnUrl(APP_PUBLIC_URL));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing in · Gaia Healers</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7faf5;color:#173323;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(88vw,420px);padding:32px;border-radius:22px;background:#fff;box-shadow:0 18px 55px rgba(22,61,36,.12);text-align:center}h1{font-size:24px;margin:0 0 10px}p{color:#65756b;margin:0}.dot{display:inline-block;width:10px;height:10px;margin:0 3px;border-radius:50%;background:#5cb82e;animation:p 1s infinite alternate}.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}@keyframes p{to{opacity:.25;transform:translateY(-4px)}}a{color:#2f7d32}</style>
</head><body><main class="card"><h1 id="title">Signing you in</h1><p id="status">Verifying your Gaia Healers membership…</p><p id="loader" aria-hidden="true" style="margin-top:20px"><span class="dot"></span><span class="dot"></span><span class="dot"></span></p></main>
<script nonce="${nonce}">(async()=>{const fallback=${fallback};const status=document.getElementById('status');const title=document.getElementById('title');const loader=document.getElementById('loader');const fragment=new URLSearchParams(location.hash.slice(1));const token=fragment.get('gaia_magic')||'';history.replaceState({},'',location.pathname);if(!token){title.textContent='Sign-in link unavailable';status.innerHTML='Return to <a href="'+fallback+'">Gaia Healers</a> and request a new link.';loader.hidden=true;return}try{const response=await fetch('/api/auth/magic-link/consume',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},credentials:'include',body:JSON.stringify({token})});const data=await response.json();if(!response.ok||!data.authenticated)throw new Error(data.error||'This link could not be verified.');status.textContent='Verified. Opening your Gaia Healers…';location.replace(data.returnTo||fallback)}catch(error){title.textContent='Please request a new link';status.textContent=error.message||'This sign-in link is invalid or expired.';loader.hidden=true;}})();</script></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

function normalizeGhlContact(raw = {}, fallback = {}) {
  const tags = Array.isArray(raw.tags)
    ? raw.tags
    : Array.isArray(raw.contactTags)
      ? raw.contactTags
      : [];
  const customFieldsRaw = Array.isArray(raw.customFields)
    ? raw.customFields
    : Array.isArray(raw.customField)
      ? raw.customField
      : [];
  const customFields = customFieldsRaw
    .map((field) => ({
      id: firstNonEmptyString(field.id, field.fieldId, field.key),
      key: firstNonEmptyString(field.key, field.name, field.fieldName, field.id),
      value: firstNonEmptyString(field.value, field.fieldValue, field.val),
    }))
    .filter((field) => field.key);

  return normalizeMemberIdentity({
    memberId: firstNonEmptyString(raw.id, raw.contactId, fallback.memberId, fallback.contactId),
    contactId: firstNonEmptyString(raw.id, raw.contactId, fallback.contactId, fallback.memberId),
    email: firstNonEmptyString(raw.email, fallback.email),
    displayName: firstNonEmptyString(raw.name, `${raw.firstName || ''} ${raw.lastName || ''}`, fallback.displayName, fallback.name),
    role: firstNonEmptyString(raw.role, fallback.role, 'Member'),
    cohort: firstNonEmptyString(raw.cohort, raw.group, fallback.cohort),
    locationId: firstNonEmptyString(raw.locationId, fallback.locationId),
    source: 'ghl-contact',
    tags: uniqueStrings(tags),
    customFields,
  });
}

// Privacy-safe check for the wellness sign-up: is this email ALREADY a real
// Gaia Healers member (existing GHL contact with membership / community / product
// access)? Returns only { existing, member, name } — NEVER private access
// details, because an unverified email is not proof of ownership. The real
// profile sync only happens after the person signs in (magic link) and proves
// they own the email.
async function wellnessMemberLookup(email) {
  try {
    const v = await getMemberFromGhl({ email: String(email || '').trim().toLowerCase() });
    if (!v || !v.memberResolved || !v.member) return { existing: false, member: false, name: '' };
    let hasAccess = false;
    try {
      const contactId = v.member.contactId || v.member.memberId;
      const subscriptions = contactId ? await ghlMemberSubscriptions(contactId, 100) : [];
      const access = buildMemberAccess(v.tags || [], v.customFields || [], v.member, entitlementForContact(contactId), subscriptions);
      hasAccess = Boolean(
        access?.member?.membershipTier
        || access?.member?.practitioner
        || (access?.communities?.unlocked || []).length
        || (access?.products || []).length,
      );
    } catch (_) {}
    return { existing: true, member: hasAccess, name: String(v.member.displayName || '').trim() };
  } catch (_) {
    return { existing: false, member: false, name: '' };
  }
}

async function getMemberFromGhl({ email = '', memberId = '', contactId = '' } = {}) {
  const cfg = ghlConfig();
  if (!cfg.enabled) {
    return {
      configured: false,
      memberResolved: false,
      liveData: false,
      source: 'ghl-not-configured',
      member: null,
      rawContact: null,
      portalOnlyFields: ['academyProgress', 'courses', 'purchases', 'communities'],
    };
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedId = String(contactId || memberId || '').trim();
  let contactPayload = null;

  if (normalizedId) {
    const byId = await ghlGet(`/contacts/${encodeURIComponent(normalizedId)}`);
    contactPayload = byId?.contact || byId?.data?.contact || byId?.data || byId || null;
    const resolvedEmail = String(contactPayload?.email || '').trim().toLowerCase();
    if (contactPayload && normalizedEmail && resolvedEmail !== normalizedEmail) {
      return {
        configured: true,
        memberResolved: false,
        liveData: false,
        source: 'ghl-contact-identity-mismatch',
        member: null,
        rawContact: null,
        portalOnlyFields: ['academyProgress', 'courses', 'purchases', 'communities'],
      };
    }
  }

  if (!contactPayload && normalizedEmail) {
    // Use GHL's current advanced-search endpoint first. Login must resolve to
    // exactly one contact: silently choosing the first duplicate email could
    // expose the wrong member's profile or entitlements.
    const advanced = await ghlPost('/contacts/search', {
      page: 1,
      pageLimit: 100,
      locationId: cfg.locationId,
      filters: [{ operator: 'eq', field: 'email', value: normalizedEmail }],
    }, '2021-07-28');
    const advancedList = advanced?.contacts || advanced?.data?.contacts || advanced?.data || advanced?.results || [];
    const exactAdvanced = Array.isArray(advancedList)
      ? advancedList.filter((item) => String(item?.email || '').trim().toLowerCase() === normalizedEmail)
      : [];
    if (exactAdvanced.length > 1) {
      return {
        configured: true,
        memberResolved: false,
        liveData: false,
        source: 'ghl-contact-ambiguous-email',
        member: null,
        rawContact: null,
        portalOnlyFields: ['academyProgress', 'courses', 'purchases', 'communities'],
      };
    }
    if (exactAdvanced.length === 1) contactPayload = exactAdvanced[0];

    // Compatibility fallback while older GHL locations still expose GET
    // /contacts. It is intentionally used only when advanced search did not
    // return a match, and it keeps the same exact-one rule.
    const candidates = contactPayload ? [] : [
      await ghlGet('/contacts', { locationId: cfg.locationId, query: normalizedEmail, limit: 100 }),
      await ghlGet('/contacts', { locationId: cfg.locationId, email: normalizedEmail, limit: 100 }),
    ];
    for (const candidate of candidates) {
      const list = candidate?.contacts
        || candidate?.data?.contacts
        || candidate?.data
        || candidate?.results
        || [];
      if (!Array.isArray(list) || !list.length) continue;
      const exact = list.filter((item) => String(item?.email || '').trim().toLowerCase() === normalizedEmail);
      if (exact.length > 1) {
        return {
          configured: true,
          memberResolved: false,
          liveData: false,
          source: 'ghl-contact-ambiguous-email',
          member: null,
          rawContact: null,
          portalOnlyFields: ['academyProgress', 'courses', 'purchases', 'communities'],
        };
      }
      if (exact.length === 1) {
        contactPayload = exact[0];
        break;
      }
    }
  }

  if (!contactPayload) {
    return {
      configured: true,
      memberResolved: false,
      liveData: false,
      source: 'ghl-contact-not-found',
      member: null,
      rawContact: null,
      portalOnlyFields: ['academyProgress', 'courses', 'purchases', 'communities'],
    };
  }

  const member = normalizeGhlContact(contactPayload, {
    email: normalizedEmail,
    memberId: normalizedId,
    contactId: normalizedId,
  });
  return {
    configured: true,
    memberResolved: Boolean(member.email || member.memberId || member.contactId),
    liveData: true,
    source: 'ghl-contact',
    member,
    tags: uniqueStrings([...(contactPayload.tags || []), ...(contactPayload.contactTags || [])]),
    customFields: Array.isArray(contactPayload.customFields) ? contactPayload.customFields : [],
    rawContact: contactPayload,
    portalOnlyFields: ['academyProgress', 'courses', 'purchases', 'communities'],
  };
}

// ————————————————————————————————————————————————————————————————
// Phase 0 — Live member access map (read-only).
// Turns a signed-in member's LIVE GHL tags into a normalized access catalog
// result. No LMS clone, no course-content scraping: we only report which
// communities/products the member's tags grant, plus evidence (matchedBy).
// HealeeX + Abundant are placeholders (locked/unknown) until final tags exist.
// ————————————————————————————————————————————————————————————————
const ACCESS_CATALOG = {
  communities: [
    { id: 'all-gaia',  name: 'All Gaia Healers',            matchTags: ['gaia-community-all-gaia', 'community-active', 'community-starthere-access'] },
    { id: 'biowell',   name: 'Bio-Well Practitioners',      matchTags: ['community-biowell-member', 'community_biowell', 'product_biowell_interest'] },
    { id: 'biopulsar', name: 'BioPulsar Practitioners',     matchTags: ['community-biopulsar-member', 'product_biopulsar_interest'] },
    { id: 'biotekna',  name: 'Biotekna Practitioners',      matchTags: ['community-biotekna-member'] },
    { id: 'asea',      name: 'ASEA Community',               matchTags: ['community-asea-member', 'product_asea_interest'] },
    { id: 'braintap',  name: 'BrainTap Community',           matchTags: ['community-braintap-member'] },
    { id: 'lifewave',  name: 'LifeWave Community',           matchTags: ['community-lifewave-member', 'product_lifewave_interest'] },
    { id: 'golden-practitioner', name: 'Golden Practitioner Circle', matchTags: ['goldenpractitioner-community-member'] },
  ],
  productOwnerPattern: /^product_(.+)_owner$/i,
  // Product interest tags (product_*_interest) are how this GHL location marks
  // product interest/ownership today; owner tags (product_*_owner) are not used
  // yet. Matched interest tags surface a product as "interested" (owned: false)
  // — see addProduct() below. Owner tags still map to owned: true when present.
  productInterestPattern: /^product_(.+)_interest$/i,
  productNames: {
    biowell: 'Bio-Well', biowell_biocor: 'Bio-Well BioCor', biowell_sputnik: 'Bio-Well Sputnik',
    biowell_water: 'Bio-Well Water Sensor', biowell_water_sensor: 'Bio-Well Water Sensor',
    biopulsar: 'BioPulsar', biotekna: 'BioTekna', braintap: 'BrainTap', healy: 'Healy',
    asea: 'ASEA', lifewave: 'LifeWave', ans_control: 'ANS Control', bia: 'BIA', heg: 'HEG',
    miracleqst: 'Miracle QST', ppg: 'PPG Stress Flow', regmatex: 'RegMaTex', spiro: 'Spiro',
    tomeex: 'ToMeEx', other_devices: 'Other devices', healeex: 'HealeeX',
    // Keys observed as *_interest tags in the live GHL location.
    biocor: 'BioCor', jiva: 'Jiva', kangan: 'Kangan',
    quantum_sound_therapy: 'Quantum Sound Therapy', general_water: 'Water (general)',
    quantum_sound: 'Quantum Sound Therapy',
  },
  // Non-standard ownership tags (not in product_*_owner form). Only ones WITHOUT
  // a product_*_owner equivalent are listed, so they never double-count.
  productTagMap: {
    'glove owner': { id: 'glove', name: 'Bio-Well Glove' },
    'healeex owner': { id: 'healeex', name: 'HealeeX' },
    'healeex-owner': { id: 'healeex', name: 'HealeeX' },
    'smart ring owner': { id: 'smart_ring', name: 'Smart Ring' },
  },
  // Membership tiers — first match wins, so higher tiers are listed first.
  // Cancelled (ahc-gold-cancel) is intentionally NOT mapped.
  membershipTierTags: {
    'gaia-diamond-active': 'Diamond', 'ahc-diamond-active': 'Diamond', membership_diamond: 'Diamond', 'diamond-membership': 'Diamond',
    'ahc-gold-active': 'Gold', 'ahc-gold-trial': 'Gold',
    'ahc-silver-active': 'Silver', membership_silver: 'Silver', 'silver-membership': 'Silver',
    'gaia-free-active': 'Free', 'ahc-free-active': 'Free', membership_free: 'Free', 'free-membership': 'Free',
  },
  practitionerCertifiedTags: ['bio-well certified practitioner'],
  practitionerTags: ['bio-well practitioner', 'gaiapractitioner', 'gaia practitioner directory', 'goldenpractitionermember', 'gaia_practitioner_form_complete'],
  // Access-like tags used to surface "unknown access" the catalog did not map.
  accessLikePatterns: [/^community[-_]/i, /_owner$/i, /^membership/i, /-membership$/i, /-member$/i, /^ahc-/i, /^enrolled/i, /course/i],
};

// —— Phase 3: deep-link catalog ——
// Generated links (bookings/forms/surveys) come straight from live GHL ids/slugs
// (patterns verified live). Communities/courses/products/portal URLs are
// CONFIG-READY: fill the exact member-facing URLs below when provided; until
// then they fall back to the client portal. Never guess a URL.
const DEEPLINK = {
  widgetBase: 'https://api.leadconnectorhq.com',
  portalFallback: (process.env.GHL_CLIENT_PORTAL_BASE_URL || 'https://education.gaiahealers.com').replace(/\/+$/, ''),
  // Confirmed high-confidence URLs wired; empty string => portal fallback.
  communityUrls: {
    'all-gaia': 'https://www.lightworkersapp.com/spaces/13553216', // VERIFIED Mighty 'Gaiahealers Community' (active host of community + weekly events)
    biowell: '',                                                           // pending → portal
    biopulsar: 'https://education.gaiahealers.com/biopulsar-community',    // confirmed
    biotekna: '',                                                         // pending → portal
    asea: '',                                                             // pending → portal
    braintap: '',                                                         // pending → portal
    lifewave: '',                                                         // pending → portal
    'golden-practitioner': '',                                            // pending → portal
  },
  courseUrls: {},                                                          // per-course, pending
  academyHubUrl: 'https://education.gaiahealers.com/courses/library-v2',  // confirmed Client Portal course library
  productStoreUrl: '',                                                    // pending
  // Curated member-bookable calendars (widgetSlug verified live, active):
  bookings: [
    { id: 'biowell-scan', name: 'Bio-Well Scan', slug: 'scans' },
    { id: 'biowell-demo', name: 'Bio-Well Demo', slug: 'bio-welldemo' },
    { id: 'healeex-combo', name: 'Healeex Bio-Well Combo', slug: 'healeex-bio-well-combo' },
  ],
};
function bookingUrl(slug) { return slug ? `${DEEPLINK.widgetBase}/widget/bookings/${encodeURIComponent(slug)}` : ''; }
function formWidgetUrl(id) { return id ? `${DEEPLINK.widgetBase}/widget/form/${encodeURIComponent(id)}` : ''; }
function surveyWidgetUrl(id) { return id ? `${DEEPLINK.widgetBase}/widget/survey/${encodeURIComponent(id)}` : ''; }
function communityOpenUrl(id) { const u = DEEPLINK.communityUrls[id]; return { openUrl: u || DEEPLINK.portalFallback, openUrlIsFallback: !u }; }
function courseOpenUrl(id) { const u = DEEPLINK.courseUrls[id]; return { openUrl: u || DEEPLINK.portalFallback, openUrlIsFallback: !u }; }
function memberBookingLinks() { return DEEPLINK.bookings.map((b) => ({ id: b.id, name: b.name, type: 'booking', openUrl: bookingUrl(b.slug) })); }

function friendlyProductName(slug) {
  const key = String(slug || '').toLowerCase();
  if (ACCESS_CATALOG.productNames[key]) return ACCESS_CATALOG.productNames[key];
  return key.split(/[_-]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function subscriptionNames(subscription = {}) {
  return uniqueStrings([
    subscription.entitySourceName,
    subscription.name,
    subscription.recurringProduct?.name,
    ...(Array.isArray(subscription.products) ? subscription.products.map((item) => item?.name || item?.title) : []),
    ...(Array.isArray(subscription.lineItemDetails) ? subscription.lineItemDetails.map((item) => item?.name || item?.title) : []),
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function explicitTierFromOfferName(value = '') {
  const name = String(value || '').trim();
  // A tier word must be explicit in the subscribed offer/product name. The
  // surrounding membership/access wording prevents unrelated products whose
  // marketing copy happens to contain words such as "gold" from becoming a
  // membership signal.
  if (!/(gaia|ahc|member|membership|access|community)/i.test(name)) return null;
  const match = name.match(/\b(diamond|gold|silver|free)\b/i);
  return match ? normalizeTierName(match[1]) : null;
}

function resolveSubscriptionTier(subscriptions = []) {
  const candidates = [];
  for (const subscription of (Array.isArray(subscriptions) ? subscriptions : [])) {
    if (!/^(active|trial|trialing)$/i.test(String(subscription?.status || '').trim())) continue;
    for (const name of subscriptionNames(subscription)) {
      const tier = explicitTierFromOfferName(name);
      if (!tier) continue;
      const at = Date.parse(subscription.updatedAt || subscription.createdAt || subscription.subscriptionStartDate || '') || 0;
      candidates.push({ tier, name, at });
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  const tiers = uniqueStrings(candidates.map((item) => item.tier));
  const chosen = candidates[0] || null;
  return {
    tier: chosen?.tier || null,
    matchedBy: chosen ? `subscription:${chosen.name}` : null,
    conflict: tiers.length > 1,
    candidates: tiers,
  };
}

function buildMemberAccess(rawTags = [], customFields = [], member = {}, entitlements = null, subscriptions = []) {
  // Prefer live GHL subscription data. A GHL-exported backfill snapshot is only
  // used when the live payments lookup is unavailable or returns no records.
  const effectiveSubscriptions = Array.isArray(subscriptions) && subscriptions.length
    ? subscriptions
    : (Array.isArray(entitlements?.subscriptions) ? entitlements.subscriptions : []);
  const tags = uniqueStrings((rawTags || []).map((t) => String(t || '').trim()).filter(Boolean));
  const lower = new Map(tags.map((t) => [t.toLowerCase(), t]));
  const has = (tag) => lower.has(String(tag).toLowerCase());
  const matched = new Set();

  const unlocked = [];
  const locked = [];
  for (const c of ACCESS_CATALOG.communities) {
    const link = communityOpenUrl(c.id);
    if (c.placeholder || !c.matchTags.length) {
      locked.push({ id: c.id, name: c.name, state: 'unknown', reason: 'Membership tag not configured yet — ask Gaia Healers to unlock this.', matchedBy: null, ...link });
      continue;
    }
    // Mark every present match tag as "known" (not just the first hit) so a
    // secondary signal like community-starthere-access isn't mislabeled unknown.
    c.matchTags.forEach((t) => { if (has(t)) matched.add(t.toLowerCase()); });
    const hit = c.matchTags.find((t) => has(t));
    if (hit) {
      unlocked.push({ id: c.id, name: c.name, state: 'unlocked', matchedBy: lower.get(hit.toLowerCase()) || hit, ...link });
    } else {
      locked.push({ id: c.id, name: c.name, state: 'locked', reason: 'Not included in your membership', matchedBy: null, ...link });
    }
  }

  const products = [];
  const productIds = new Set();
  // addProduct: owned=true only for real ownership signals (product_*_owner,
  // productTagMap). Interest tags (product_*_interest) call addInterestProduct
  // so they show as owned=false and never overwrite a true owner entry.
  const addProduct = (id, name, tag) => {
    if (productIds.has(id)) {
      // An interest entry already added this product — upgrade it to owned.
      const existing = products.find((p) => p.id === id);
      if (existing) { existing.owned = true; existing.matchedBy = tag; }
      matched.add(tag.toLowerCase());
      return;
    }
    productIds.add(id); matched.add(tag.toLowerCase());
    products.push({ id, name, owned: true, matchedBy: tag });
  };
  const addInterestProduct = (id, name, tag) => {
    if (productIds.has(id)) { matched.add(tag.toLowerCase()); return; } // owned entry wins
    productIds.add(id); matched.add(tag.toLowerCase());
    products.push({ id, name, owned: false, matchedBy: tag, state: 'interested' });
  };
  for (const t of tags) {
    const m = ACCESS_CATALOG.productOwnerPattern.exec(t);
    if (m) addProduct(m[1].toLowerCase(), friendlyProductName(m[1]), t);
  }
  // Non-standard ownership tags (e.g. "glove owner") without a product_*_owner form.
  for (const t of tags) {
    const p = ACCESS_CATALOG.productTagMap[t.toLowerCase()];
    if (p) addProduct(p.id, p.name, t);
  }
  // Product interest tags (product_*_interest) — how this GHL location currently
  // marks product interest. Surfaced as owned:false / state:'interested'. A later
  // owner tag for the same product id upgrades it to owned:true (see addProduct).
  for (const t of tags) {
    const m = ACCESS_CATALOG.productInterestPattern.exec(t);
    if (m) addInterestProduct(m[1].toLowerCase(), friendlyProductName(m[1]), t);
  }

  let membershipTier = null;
  let tierMatchedBy = null;
  let tierConflict = false;
  let tierCandidates = [];
  // Secondary source: current GHL contact tags. Preserve the configured order
  // (Diamond, Gold, Silver, Free) only for the display label; course/community
  // authorization never depends on this choice.
  const tagTierCandidates = [];
  for (const [tag, tier] of Object.entries(ACCESS_CATALOG.membershipTierTags)) {
    if (has(tag)) {
      tagTierCandidates.push({ tag, tier });
      matched.add(tag.toLowerCase());
    }
  }
  if (tagTierCandidates.length) {
    membershipTier = tagTierCandidates[0].tier;
    tierMatchedBy = 'tag:' + tagTierCandidates[0].tag;
    tierCandidates = uniqueStrings(tagTierCandidates.map((item) => item.tier));
    tierConflict = tierCandidates.length > 1;
  }

  // Tertiary fallback: an explicit membership workflow mirror. It is useful
  // when tags have not caught up, but it must not override current live GHL
  // subscription or tag evidence.
  const mirroredTier = normalizeTierName(entitlements?.tier?.name);
  if (!membershipTier && mirroredTier) {
    membershipTier = mirroredTier;
    tierMatchedBy = entitlements.tier.matchedBy || 'ghl-workflow';
    tierCandidates = [mirroredTier];
  }

  // Primary source: a currently active/trialing GHL subscription whose offer
  // name explicitly contains Free/Silver/Gold/Diamond. Amounts are never used.
  const subscriptionTier = resolveSubscriptionTier(effectiveSubscriptions);
  if (subscriptionTier.tier) {
    membershipTier = subscriptionTier.tier;
    tierMatchedBy = subscriptionTier.matchedBy;
    tierCandidates = uniqueStrings([...subscriptionTier.candidates, ...tagTierCandidates.map((item) => item.tier)]);
    tierConflict = subscriptionTier.conflict
      || tagTierCandidates.some((item) => item.tier !== subscriptionTier.tier);
  }

  // A tier that rests ONLY on a legacy contact tag — no live subscription and no
  // canonical workflow mirror — is not proof of a paid membership. This location
  // carries ~200 stale ahc-gold/ahc-gold-trial tags with zero matching Gold
  // subscriptions; showing them "Gold Member" (and telling the assistant so)
  // overstates access and contradicts the canonical resolver. An unbacked tag
  // tier is surfaced as a hint only, never as the confident tier.
  let membershipTierUnverified = null;
  if (membershipTier && String(tierMatchedBy || '').startsWith('tag:')) {
    membershipTierUnverified = membershipTier;
    membershipTier = null;
    tierMatchedBy = 'tag-unverified';
  }

  // Merge exact GHL Group/Community grants delivered by access workflows.
  // These grants are authoritative and may exist even when a matching contact
  // tag has not been configured.
  for (const granted of (Array.isArray(entitlements?.communities) ? entitlements.communities : [])) {
    const id = String(granted.id || courseGroupKey(granted.name || '')).trim();
    const name = String(granted.name || id || 'Community').trim();
    if (!id && !name) continue;
    const already = unlocked.find((item) => (id && item.id === id) || item.name.toLowerCase() === name.toLowerCase());
    const link = granted.openUrl ? { openUrl: granted.openUrl, openUrlIsFallback: false } : communityOpenUrl(id);
    if (already) Object.assign(already, link, { matchedBy: granted.matchedBy || 'ghl-workflow' });
    else unlocked.push({ id, name, state: 'unlocked', matchedBy: granted.matchedBy || 'ghl-workflow', ...link });
    const lockedIndex = locked.findIndex((item) => (id && item.id === id) || item.name.toLowerCase() === name.toLowerCase());
    if (lockedIndex >= 0) locked.splice(lockedIndex, 1);
  }

  const certified = ACCESS_CATALOG.practitionerCertifiedTags.some((t) => has(t));
  const practitioner = certified || ACCESS_CATALOG.practitionerTags.some((t) => has(t));
  [...ACCESS_CATALOG.practitionerCertifiedTags, ...ACCESS_CATALOG.practitionerTags].forEach((t) => { if (has(t)) matched.add(t.toLowerCase()); });

  const unknownAccessTags = tags.filter((t) =>
    !matched.has(t.toLowerCase())
    && !/_interest$/i.test(t)
    && ACCESS_CATALOG.accessLikePatterns.some((re) => re.test(t)));

  return {
    member: {
      name: member.displayName || member.name || 'Gaia Healers member',
      email: member.email || '',
      practitioner,
      practitionerCertified: certified,
      membershipTier,
      membershipTierUnverified,
      tierMatchedBy,
      tierConflict,
      tierCandidates,
    },
    communities: { unlocked, locked },
    products,
    unknownAccessTags,
    counts: {
      unlocked: unlocked.length, locked: locked.length,
      products: products.length, unknown: unknownAccessTags.length, totalTags: tags.length,
    },
    customFieldsCount: Array.isArray(customFields) ? customFields.length : 0,
    entitlementSource: subscriptionTier.tier
      ? 'ghl-live-subscription'
      : (entitlements ? 'ghl-workflow-mirror' : 'ghl-tags'),
  };
}

async function memberAccess(req, res, origin, url) {
  const sessionMember = sessionMemberContext(req);
  if (!sessionMember) {
    sendJson(res, 401, { ok: false, authenticated: false, reason: 'auth_required', error: 'Sign in to view your access.' }, origin);
    return;
  }

  // ── synthetic profiles, for UI development only ───────────────────────────
  // Requires the process flag, a configured key AND a session that was minted
  // with fixture authority. On production none of those hold, so this branch is
  // unreachable and the request continues exactly as it did before.
  const rawSession = cookieForRequest(req);
  if (fixtureAccessGranted(rawSession)) {
    const fixtureId = requestedFixtureId(rawSession, url);
    const profile = fixtureProfile(fixtureId);
    if (!profile) {
      sendJson(res, 404, { ok: false, error: `Unknown fixture: ${fixtureId}`, available: fixtureIds() }, origin);
      return;
    }
    const resolvedFixture = resolveMemberAccess({
      record: profile.record,
      subscriptions: profile.subscriptions,
      tags: profile.tags,
    });
    const emptyAccess = buildMemberAccess(profile.tags, [], { name: profile.id, email: `${profile.id}@fixture.invalid` }, profile.record, profile.subscriptions);
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      source: 'fixture',
      generatedAt: new Date().toISOString(),
      ...emptyAccess,
      member: { ...emptyAccess.member, contactId: profile.id },
      membership: resolvedFixture.membership,
      entitlements: resolvedFixture.entitlements,
      sections: resolvedFixture.sections,
      upgrade: resolvedFixture.upgrade,
      meta: { ...resolvedFixture.meta, fixture: profile.id, live_source: 'fixture' },
    }, origin);
    return;
  }

  let tags = Array.isArray(sessionMember.tags) ? sessionMember.tags : [];
  let customFields = [];
  let liveMember = sessionMember;
  let live = false;
  let entitlements = entitlementForContact(sessionMember.contactId || sessionMember.memberId);
  let subscriptions = [];
  let sourceError = false;
  try {
    const verified = await getMemberFromGhl({
      email: sessionMember.email,
      contactId: sessionMember.contactId,
      memberId: sessionMember.memberId,
    });
    if (verified?.memberResolved) {
      tags = verified.tags || tags;
      customFields = verified.customFields || [];
      liveMember = verified.member || sessionMember;
      live = true;
      const cid = liveMember.contactId || liveMember.memberId || sessionMember.contactId || '';
      entitlements = entitlementForContact(cid) || entitlements;
      subscriptions = cid ? await ghlMemberSubscriptions(cid, 100) : [];
    }
  } catch (err) {
    console.error('[Gaia Access] live tag read failed', { error: err.message.split('\n')[0] });
    sourceError = true;
  }
  const access = buildMemberAccess(tags, customFields, liveMember, entitlements, subscriptions);

  // ── v2 read model, added alongside the legacy shape ───────────────────────
  // Every key the current frontend reads is left exactly where it was; the
  // canonical membership/entitlement view is added next to it so the UI can be
  // migrated screen by screen instead of in one breaking release.
  const contactId = liveMember.contactId || liveMember.memberId || sessionMember.contactId || '';
  // A successful live GHL read IS a confirmation of current state. Stamp it
  // (debounced) and drive freshness off it; on a failed read, fall back to the
  // last stored confirmation so the honesty banner still fires when it should.
  let confirmedAt = null;
  if (live && !sourceError) {
    confirmedAt = new Date().toISOString();
    recordConfirmation(contactId);
  } else {
    confirmedAt = confirmationIso(contactId);
  }
  const resolved = resolveMemberAccess({
    record: entitlements,
    subscriptions,
    tags,
    sourceError,
    confirmedAt,
  });

  sendJson(res, 200, {
    ok: true,
    authenticated: true,
    source: live ? 'ghl-live' : 'session-fallback',
    generatedAt: new Date().toISOString(),
    ...access,
    member: { ...access.member, contactId },
    membership: resolved.membership,
    entitlements: resolved.entitlements,
    sections: resolved.sections,
    upgrade: resolved.upgrade,
    meta: {
      ...resolved.meta,
      // `source` above describes how the live read went; this says plainly
      // whether the member is looking at data we consider current.
      live_source: live ? 'ghl-live' : 'session-fallback',
      unresolved_billing_ids: UNRESOLVED_BILLING_IDS.map((item) => item.id),
    },
  }, origin);
}

// ————————————————————————————————————————————————————————————————
// Phase 2 — Normalized member data layer.
// The frontend only ever calls /api/member/*; GHL concepts stay server-side.
// Every endpoint is session-gated (401 anon) and returns LIVE GHL data OR a
// documented placeholder (source + reason) — never mock. Read-only.
// ————————————————————————————————————————————————————————————————
function requireSessionMember(req, res, origin) {
  const m = sessionMemberContext(req);
  if (!m) {
    sendJson(res, 401, { ok: false, authenticated: false, reason: 'auth_required', error: 'Sign in required.' }, origin);
    return null;
  }
  return m;
}

async function fetchMemberBundle(sessionMember) {
  try {
    const v = await getMemberFromGhl({ email: sessionMember.email, contactId: sessionMember.contactId, memberId: sessionMember.memberId });
    if (v?.memberResolved) {
      const contactId = v.member?.contactId || v.member?.memberId || sessionMember.contactId || sessionMember.memberId || '';
      const subscriptions = contactId ? await ghlMemberSubscriptions(contactId, 100) : [];
      return {
        resolved: true,
        member: v.member || sessionMember,
        tags: v.tags || [],
        customFields: v.customFields || [],
        contactId,
        entitlements: entitlementForContact(contactId),
        subscriptions,
      };
    }
  } catch (err) {
    console.error('[Gaia Member] bundle fetch failed', { error: err.message.split('\n')[0] });
  }
  const contactId = sessionMember.contactId || sessionMember.memberId || '';
  const subscriptions = contactId ? await ghlMemberSubscriptions(contactId, 100).catch(() => []) : [];
  return { resolved: false, member: sessionMember, tags: Array.isArray(sessionMember.tags) ? sessionMember.tags : [], customFields: [], contactId, entitlements: entitlementForContact(contactId), subscriptions };
}

const BIOWELL_SERIAL_FIELD_ID = '9oJPmsGmdbhca85SeBbl';
function customFieldValue(customFields, fieldId) {
  const f = (customFields || []).find((x) => String(x.id || x.key || '') === fieldId);
  if (!f) return '';
  const v = f.value;
  return Array.isArray(v) ? v.join(', ') : String(v ?? '');
}
function memberEnvelope(b, extra) {
  return { ok: true, authenticated: true, source: b.resolved ? 'ghl-live' : 'session', generatedAt: new Date().toISOString(), ...extra };
}
function placeholderEnvelope(reason, extra) {
  return { ok: true, authenticated: true, source: 'placeholder', reason, generatedAt: new Date().toISOString(), ...extra };
}

async function memberProfile(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const access = buildMemberAccess(b.tags, b.customFields, b.member, b.entitlements, b.subscriptions);
  sendJson(res, 200, memberEnvelope(b, {
    profile: {
      name: b.member.displayName || b.member.name || 'Gaia Healers member',
      email: b.member.email || '',
      role: b.member.role || 'Member',
      cohort: b.member.cohort || '',
      practitioner: access.member.practitioner,
      practitionerCertified: access.member.practitionerCertified,
      membershipTier: access.member.membershipTier,
      tierMatchedBy: access.member.tierMatchedBy,
      tierConflict: access.member.tierConflict,
      bioWellSerial: customFieldValue(b.customFields, BIOWELL_SERIAL_FIELD_ID) || null,
      tagCount: b.tags.length,
      customFieldCount: Array.isArray(b.customFields) ? b.customFields.length : 0,
    },
  }), origin);
}

async function memberCommunities(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const access = buildMemberAccess(b.tags, b.customFields, b.member, b.entitlements, b.subscriptions);
  sendJson(res, 200, memberEnvelope(b, { communities: access.communities, unknownAccessTags: access.unknownAccessTags }), origin);
}

const DEVICE_SLUGS = new Set(['biowell', 'biowell_biocor', 'biowell_sputnik', 'biowell_water', 'biowell_water_sensor', 'biopulsar', 'biotekna', 'braintap', 'healy', 'asea', 'ans_control', 'bia', 'heg']);
async function memberDevices(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const devices = [];
  for (const t of b.tags) {
    const m = ACCESS_CATALOG.productOwnerPattern.exec(t);
    if (m && DEVICE_SLUGS.has(m[1].toLowerCase())) devices.push({ id: m[1].toLowerCase(), name: friendlyProductName(m[1]), owned: true, matchedBy: t });
  }
  const serial = customFieldValue(b.customFields, BIOWELL_SERIAL_FIELD_ID);
  if (serial) { const bw = devices.find((d) => d.id === 'biowell'); if (bw) bw.serialNumber = serial; }
  sendJson(res, 200, memberEnvelope(b, { devices, count: devices.length }), origin);
}

function normalizeAppointment(a = {}) {
  // GHL stores the video call link in `meeting_location` (e.g. the Zoom URL
  // when the calendar's meetingLocationType is 'zoom'). The `address` field
  // holds the location for in-person appointments. Surface both so the app can
  // show a "Join meeting" button for video calls and an address for in-person.
  const meetingLocation = String(a.meeting_location || a.meetingLocation || a.meetingLink || '').trim();
  const meetingLocationType = String(a.meetingLocationType || a.meetingLinkType || '').trim().toLowerCase();
  return {
    id: String(a.id || ''),
    title: String(a.title || 'Appointment'),
    startTime: a.startTime || '',
    endTime: a.endTime || '',
    status: String(a.appointmentStatus || a.status || ''),
    calendarId: String(a.calendarId || ''),
    address: String(a.address || ''),
    meetingLocation,
    meetingLocationType,
    isVideo: Boolean(meetingLocation && /^(https?:)?\/\//.test(meetingLocation)),
  };
}
async function memberAppointments(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  let appointments = [];
  if (b.contactId) {
    try {
      const r = await ghlGet(`/contacts/${encodeURIComponent(b.contactId)}/appointments`);
      const list = r?.events || r?.appointments || r?.data || [];
      appointments = (Array.isArray(list) ? list : []).map(normalizeAppointment);
    } catch (err) { console.error('[Gaia Member] appointments failed', { error: err.message.split('\n')[0] }); }
  }
  sendJson(res, 200, { ...memberEnvelope(b, {}), source: 'ghl-live', appointments, count: appointments.length, bookingLinks: memberBookingLinks() }, origin);
}

async function memberActivity(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const cfg = ghlConfig();
  const items = [];
  if (b.contactId) {
    const [notesR, tasksR, oppsR] = await Promise.all([
      ghlGet(`/contacts/${encodeURIComponent(b.contactId)}/notes`).catch(() => null),
      ghlGet(`/contacts/${encodeURIComponent(b.contactId)}/tasks`).catch(() => null),
      ghlGet('/opportunities/search', { location_id: cfg.locationId, contact_id: b.contactId, limit: 10 }).catch(() => null),
    ]);
    for (const n of (notesR?.notes || [])) items.push({ type: 'note', at: n.dateAdded || n.createdAt || '', text: String(n.body || '').slice(0, 200) });
    for (const t of (tasksR?.tasks || [])) items.push({ type: 'task', at: t.dueDate || t.dateAdded || '', text: String(t.title || t.body || '') });
    for (const o of (oppsR?.opportunities || [])) items.push({ type: 'opportunity', at: o.updatedAt || o.createdAt || '', text: `${o.name || 'Opportunity'}${o.status ? ` · ${o.status}` : ''}` });
  }
  items.sort((a, z) => String(z.at).localeCompare(String(a.at)));
  sendJson(res, 200, { ...memberEnvelope(b, {}), source: 'ghl-live', activity: items.slice(0, 25), count: items.length }, origin);
}

// —— Phase 2b: member-scoped GHL reads. Scopes are location-wide (admin), so
// every helper restricts to the signed-in member by contactId. Never mock. ——
async function ghlMemberOrders(cid, limit = 20) {
  const cfg = ghlConfig();
  const r = await ghlGet('/payments/orders', { altId: cfg.locationId, altType: 'location', contactId: cid, limit }).catch(() => null);
  return Array.isArray(r?.data) ? r.data : [];
}
async function ghlMemberSubscriptions(cid, limit = 20) {
  const cfg = ghlConfig();
  const r = await ghlGet('/payments/subscriptions', { altId: cfg.locationId, altType: 'location', contactId: cid, limit }).catch(() => null);
  return Array.isArray(r?.data) ? r.data : [];
}
async function ghlMemberTransactions(cid, limit = 20) {
  const cfg = ghlConfig();
  const r = await ghlGet('/payments/transactions', { altId: cfg.locationId, altType: 'location', contactId: cid, limit }).catch(() => null);
  return Array.isArray(r?.data) ? r.data : [];
}
async function ghlMemberSubmissions(cid, kind, limit = 100) {
  const cfg = ghlConfig();
  const r = await ghlGet(`/${kind}/submissions`, { locationId: cfg.locationId, contactId: cid, page: 1, limit }).catch(() => null);
  const rows = Array.isArray(r?.submissions) ? r.submissions : [];
  return cid ? rows.filter((s) => String(s.contactId || '') === String(cid)) : rows;
}
async function ghlMemberConversations(cid, limit = 20) {
  const cfg = ghlConfig();
  const r = await ghlGet('/conversations/search', { locationId: cfg.locationId, contactId: cid, limit }).catch(() => null);
  return Array.isArray(r?.conversations) ? r.conversations : [];
}
function orderIsPaid(o) { return /paid|success|complete|active|delivered/i.test(String(o.paymentStatus || o.status || '')); }

async function memberProducts(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const ownedFromTags = [];
  for (const t of b.tags) { const m = ACCESS_CATALOG.productOwnerPattern.exec(t); if (m) ownedFromTags.push({ id: m[1].toLowerCase(), name: friendlyProductName(m[1]), source: 'tag', matchedBy: t }); }
  const [orders, subs] = await Promise.all([
    b.contactId ? ghlMemberOrders(b.contactId, 50) : [],
    b.contactId ? ghlMemberSubscriptions(b.contactId, 50) : [],
  ]);
  const purchased = orders.filter(orderIsPaid).map((o) => ({ orderId: o._id || o.id, name: o.name || 'Order', amount: o.amount, currency: o.currency, status: o.paymentStatus || o.status, source: 'order' }));
  sendJson(res, 200, {
    ok: true, authenticated: true, source: 'ghl-live', generatedAt: new Date().toISOString(),
    ownedProducts: ownedFromTags,
    purchases: purchased,
    subscriptions: subs.map((s) => ({ id: s._id || s.id, status: s.status, amount: s.amount, currency: s.currency })),
    storeUrl: DEEPLINK.productStoreUrl || DEEPLINK.portalFallback,
    storeUrlIsFallback: !DEEPLINK.productStoreUrl,
    counts: { ownedFromTags: ownedFromTags.length, purchases: purchased.length, subscriptions: subs.length },
  }, origin);
}

async function memberPurchases(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const [orders, subs, tx] = await Promise.all([
    b.contactId ? ghlMemberOrders(b.contactId, 50) : [],
    b.contactId ? ghlMemberSubscriptions(b.contactId, 50) : [],
    b.contactId ? ghlMemberTransactions(b.contactId, 50) : [],
  ]);
  sendJson(res, 200, {
    ok: true, authenticated: true, source: 'ghl-live', generatedAt: new Date().toISOString(),
    orders: orders.map((o) => ({ id: o._id || o.id, name: o.name, amount: o.amount, currency: o.currency, status: o.status, paymentStatus: o.paymentStatus, createdAt: o.createdAt || o.updatedAt || '' })),
    subscriptions: subs.map((s) => ({ id: s._id || s.id, status: s.status, amount: s.amount, currency: s.currency, createdAt: s.createdAt || '' })),
    transactions: tx.map((t) => ({ id: t._id || t.id, amount: t.amount, currency: t.currency, status: t.status || t.paymentStatus, createdAt: t.createdAt || t.updatedAt || '' })),
    counts: { orders: orders.length, subscriptions: subs.length, transactions: tx.length },
  }, origin);
}

async function memberForms(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const [forms, surveys] = await Promise.all([
    b.contactId ? ghlMemberSubmissions(b.contactId, 'forms', 100) : [],
    b.contactId ? ghlMemberSubmissions(b.contactId, 'surveys', 100) : [],
  ]);
  const norm = (s, type) => {
    const fid = s.formId || s.surveyId || '';
    return { id: s.id, type, formId: fid, name: s.name || '', email: s.email || '', submittedAt: s.createdAt || '', openUrl: type === 'survey' ? surveyWidgetUrl(fid) : formWidgetUrl(fid) };
  };
  sendJson(res, 200, {
    ok: true, authenticated: true, source: 'ghl-live', generatedAt: new Date().toISOString(),
    formSubmissions: forms.map((s) => norm(s, 'form')),
    surveySubmissions: surveys.map((s) => norm(s, 'survey')),
    tagState: b.tags.filter((t) => /form_complete|form_incomplete/i.test(t)),
    counts: { forms: forms.length, surveys: surveys.length },
  }, origin);
}

async function memberNotifications(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const convos = b.contactId ? await ghlMemberConversations(b.contactId, 20) : [];
  const notifications = convos.map((c) => ({
    id: c.id, type: c.type || c.lastMessageType || 'conversation',
    unread: Number(c.unreadCount || 0),
    lastMessage: String(c.lastMessageBody || '').slice(0, 160),
    updatedAt: c.dateUpdated || c.lastMessageDate || '',
  }));
  sendJson(res, 200, {
    ok: true, authenticated: true, source: 'ghl-live', generatedAt: new Date().toISOString(),
    notifications,
    counts: { conversations: notifications.length, unread: notifications.reduce((n, x) => n + x.unread, 0) },
  }, origin);
}

async function memberCourses(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const tagHints = b.tags.filter((t) => /course|enrolled/i.test(t));
  const catalog = loadCourses().courses || [];
  const grants = Array.isArray(b.entitlements?.courses) ? b.entitlements.courses : [];
  const courses = grants.map((grant) => {
    const grantKey = courseGroupKey(grant.name || '');
    const catalogCourse = catalog.find((course) => String(course.id || '') === String(grant.id || ''))
      || catalog.find((course) => grantKey && courseGroupKey(course.title || '') === grantKey);
    const openUrl = firstNonEmptyString(grant.openUrl, catalogCourse?.portalUrl, DEEPLINK.courseUrls[grant.id], DEEPLINK.academyHubUrl, DEEPLINK.portalFallback);
    return {
      id: String(grant.id || catalogCourse?.id || grantKey),
      title: String(grant.name || catalogCourse?.title || 'Course'),
      description: String(catalogCourse?.description || ''),
      image: String(catalogCourse?.image || ''),
      category: String(catalogCourse?.category || ''),
      state: 'unlocked',
      openUrl,
      openUrlIsFallback: !grant.openUrl && !catalogCourse?.portalUrl && !DEEPLINK.courseUrls[grant.id],
      matchedBy: grant.matchedBy || 'ghl-workflow',
      updatedAt: grant.updatedAt || b.entitlements?.updatedAt || null,
      progressAvailable: false,
    };
  });
  sendJson(res, 200, memberEnvelope(b, {
    source: b.entitlements ? 'ghl-workflow-mirror' : (b.resolved ? 'ghl-live-no-course-grants' : 'session-no-course-grants'),
    reason: b.entitlements
      ? 'Exact GHL course/offer access mirrored by access-granted and access-removed workflows. Lesson progress is not exposed by the public GHL API.'
      : 'No GHL course access workflow event has been mirrored for this contact yet.',
    courses,
    count: courses.length,
    tagHints,
    portalUrl: DEEPLINK.academyHubUrl || DEEPLINK.portalFallback,
    portalUrlIsFallback: !DEEPLINK.academyHubUrl,
    catalogReady: true,
  }), origin);
}
async function memberEvents(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const event = await getEventSummary().catch((error) => ({
    liveData: false,
    source: 'event-manager-error',
    error: error.message,
  }));
  const events = event?.name && event.liveData !== false ? [event] : [];
  sendJson(res, 200, {
    ok: true,
    authenticated: true,
    source: events.length ? (event.source || 'event-manager-live') : 'event-manager-empty',
    generatedAt: new Date().toISOString(),
    events,
    count: events.length,
    communityEventsAvailable: false,
    reason: 'GHL Community live-session feeds are not exposed by the public API. Confirmed Gaia events come from the live Event Manager; member appointments are available separately.',
  }, origin);
}

function boolFlag(value) {
  return value === 'true' || value === '1';
}

function geminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

// Lazy singleton for the Google GenAI client — imported once, reused across
// all token requests. Avoids a dynamic import() on every /voice/token call.
let _geminiClient = null;
let _geminiClientPromise = null;
async function getGeminiClient() {
  if (_geminiClient) return _geminiClient;
  if (_geminiClientPromise) return _geminiClientPromise;
  _geminiClientPromise = (async () => {
    const apiKey = geminiApiKey();
    const { GoogleGenAI } = await import('@google/genai');
    _geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: 'v1alpha' },
    });
    return _geminiClient;
  })();
  try {
    return await _geminiClientPromise;
  } finally {
    _geminiClientPromise = null;
  }
}

function gaiaLiveVoiceConfig() {
  const geminiReady = Boolean(geminiApiKey());
  const explicit = process.env.GAIA_LIVE_VOICE_ENABLED ?? process.env.GAIA_REALTIME_VOICE_ENABLED;
  const enabled = explicit != null && explicit !== ''
    ? boolFlag(explicit)
    : (boolFlag(process.env.GAIA_ASSIST_VOICE_ENABLED) && geminiReady);
  return {
    enabled: enabled && geminiReady,
    provider: 'gemini',
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_LIVE_VOICE,
    maxSessionSeconds: GEMINI_LIVE_MAX_SECONDS,
  };
}

function buildGaiaLiveInstructions(context = {}) {
  const view = String(context.view || 'today').trim() || 'today';
  const memberContext = String(context.memberContext || '').trim();
  return [
    'You are Gaia Assist, the warm, knowledgeable voice concierge built into the Gaia Healers app. You help both first-time visitors and signed-in members from arrival through their next useful step.',
    gaiaKnowledgePrompt(),
    memberContext,
    `The person is currently on the ${view} screen. Assume questions relate to what they are looking at unless they say otherwise, and tailor your help to that screen first.`,
    memberContext
      ? 'SIGNED-IN MEMBER JOURNEY: use only the supplied private member context for personalization. Their active GHL subscription/offer is primary tier evidence; live tier tags are secondary. Course and community access comes only from exact GHL grants mirrored to Gaia. Never infer a course or community from a tier, price, product-interest tag, or ownership tag.'
      : 'VISITOR JOURNEY: welcome them, discover whether they want to explore, join free, compare memberships, sign in, find a practitioner, or book a session, then guide them to that exact next step. Do not imply they have an account, tier, course, or community access. If they already belong, offer sign-in with the email on their GHL contact.',
    'Speak in a calm, friendly, natural voice, like a helpful friend on a phone call. Keep replies short: one or two sentences, then a quick question or a clear next step. Give more detail only when asked.',
    'Listen for meaning, not isolated sounds. Ignore brief background noise, clicks, coughs, and incomplete fragments. If the audio is unclear or a sentence seems cut off, do not guess and do not abandon the conversation: ask one short confirmation such as "I caught part of that—would you say the last part again?" Preserve the topic and prior answers across turns so the member never has to restart.',
    'Handle corrections naturally. If the member says "no", "I meant", or changes direction, briefly acknowledge the correction and continue from the updated intent without repeating the whole introduction.',
    'Be proactive and specific: ask one short intent question when needed, tell them exactly where to go (for example "Open the Store and tap Membership" or "Go to Community to find a healer"), and after each answer or tool action offer the natural next step.',
    'MEMBERSHIP GUIDANCE \u2014 help people join and activate. Gaia Healers 2.0 has four practitioner paths: Free ($0), Silver ($97/mo or $997/yr), Gold ($497/mo or $4,997/yr), and Diamond ($997/mo or $9,997/yr), with benefits growing from community and education through directory exposure, CRM/software, implementation support, and lead generation. When someone wants to grow, go deeper, get certified, be listed as a practitioner, or asks what to join, warmly explain the paths, ask one short question about their stage and goal, recommend the single best-fit tier, and hand them its exact activation link so they can activate right away: Free join.gaiahealers.com/onboarding, Silver join.gaiahealers.com/silver, Gold join.gaiahealers.com/gold, Diamond join.gaiahealers.com/diamond (or say "Open the Store and tap Membership"). Guide, never pressure; frame it as the step that matches their goal. Their in-app access mirrors what GHL grants once they activate.',
    'You can help with anything in the app and verified Gaia Healers ecosystem: Today, Energy (with colour test, numerology, today sky and Bio-Well), Academy, Community (with Find a Healer, Events, Gaia Radio, Book a session and Messages), Shop and You, plus Bio-Well research, articles, demos, the practitioner directory, certification requests, affiliate access, CRM/software/marketplace, contact and the Elevate conference. If a live number, price, inventory count or member fact is not in the supplied context, say so plainly and open the correct live source instead of inventing one.',
    'Keep members in-app first. Course videos and community discussions open the separate education.gaiahealers.com portal, which has its own login — mention it only when they want the actual lessons or discussions, or need to sign in.',
    'Never narrate your reasoning, planning, hidden analysis, or drafting process. Do not say phrases like "I have crafted", "I am refining", or "finalizing".',
    'When asked to say exact words, say only those words and no extra explanation.',
    'Never claim you saved, booked, bought, imported, emailed, checked in, or changed anything. Explain how the member can do it instead.',
    'Do not diagnose or make medical claims.',
    'You have a navigate tool. When a member asks to open a screen or feature, call it. Energy routes are distinct: energy/body point → navigate(screen=wellness, tab=check); horoscope/daily guidance → navigate(screen=wellness, tab=horoscope); chakra match/seven centres → navigate(screen=wellness, tab=chakras). Other examples: event → events; session → bookings; messages → inbox; course → academy; community/practitioner access → community; shop → store; membership → store/membership; profile/account/your stuff → profile; colour test or numerology → navigate(screen=wellness); find a healer or practitioner directory → navigate(screen=directory). The app has six bottom-bar sections: Today (daily dashboard), Energy (energy check, horoscope, chakras, numerology, colour test, today sky, Bio-Well), Academy (courses, certifications, library), Community (circles/discussions, find a healer, schedule with Dr. Nima, book a session, events, Gaia Radio, messages/inbox), Shop (the live store), and You (membership, access, bookings, your communities, become-a-practitioner). The centre orb is Gaia Assist. Navigation is the start of helping, not the finish: explain what is available there and keep listening.',
    'You also have action tools. Use them to actually do things for the member, not just describe how. book_session: when the member asks to book, schedule, or reserve something — "book a call with Dr. Nima" or "I want to meet the founder" → book_session(session=nima); "book a Bio-Well scan" → book_session(session=scan); "I want a demo" → book_session(session=demo); "book a discovery call" → book_session(session=discovery); "schedule coaching" → book_session(session=coaching). It opens the real booking form (Nima uses Calendly, the others use GHL widgets); tell them to complete it there. open_community: when the member asks to open or visit a community — "open the Bio-Well community" → open_community(community=biowell); "take me to BioPulsar" → open_community(community=biopulsar); "all gaia healers group" → open_community(community=all-gaia). Some open directly, others open in the portal. open_portal: when the member wants the portal itself — "open the portal" → open_portal(section=home); "open my courses in the portal" → open_portal(section=courses); "portal login" → open_portal(section=login). sign_in: when the member says they want to sign in, log in, or access their account and they are not signed in — "sign me in" → sign_in(). Never call sign_in if the member is already signed in. After ANY action tool, STAY ENGAGED: confirm what you opened, then guide them through the next step and keep listening. Do not go silent after opening something — the conversation continues until the member says goodbye. You ALSO have: play_course (play a specific course in the in-app player — "play my Bio-Well Advanced course" -> play_course(courseTitle)); express_interest (when they say they are interested in a device, topic, membership, or getting certified -> express_interest(topic) records their interest and opens the best place for it); register_event ("sign me up for the event" -> register_event()); find_practitioner ("find me a healer" -> find_practitioner()). Prefer DOING with these tools over only describing.',
    'This is an ongoing conversation, not a single request-response. After every action — navigating, opening a booking form, opening a community, signing in — you are STILL their assistant on that screen. Keep helping: point out what they can do, answer follow-ups, navigate elsewhere if asked, and only go quiet when the member clearly ends the conversation. Never end your turn with just a confirmation and silence; end with either a useful observation about what is now on screen, or a concrete next step they can take, or a question.',
    'ANSWER ANYTHING — you can answer questions about the whole Gaia Healers world: this app, the store at gaiahealers.com (products and prices), the practitioner directory at gaiapractitioners.com, courses, events, the devices, membership, and Dr. Nima. For any LIVE or specific fact — a price, whether something is in stock, a specific product or practitioner, the current event, or which courses exist — CALL gaia_lookup(query) and answer only from what it returns; never invent a price, count, product, or name. For general questions use your knowledge. If you truly do not know, say so and offer to open the exact page (the store, the directory, or the right screen).',
    'MEMORY — you remember members across visits. If the member context includes WHAT YOU REMEMBER, use it to greet and continue naturally (reference it lightly, never recite it), do not re-ask what you already know, and never repeat a declined offer. When you learn something durable this conversation — a real interest, a goal, a decision, an objection, or a follow-up for next time — call remember_member({ facts: [short strings], summary? }) to save it. Never save trivia, one-off logistics, or sensitive personal/financial details.',
    'GUIDE FULLY — you are their hands-on in-app guide and you know every screen and flow. When they ask how to do ANYTHING, give the exact steps from the app task guide AND offer to take them there right now by calling navigate or the right action tool. For multi-step tasks, walk them one step at a time and confirm as they go; after you move them, say what they will see and what to tap next. Never leave them to figure it out alone.',
    'RAPPORT FIRST — answer the member\'s actual question before you suggest or offer anything; never pitch in your opening sentence unless they asked. Ask one thing at a time and confirm you understood before moving on.',
    'HANDLE HESITATION — if they hesitate about a membership, address their specific concern: price -> Free starts at $0 and annual billing saves; value -> tie the benefits to the goals they told you; timing -> they can start free and upgrade anytime. Guide, never pressure, and never repeat an offer they already declined in this conversation.',
    'PERSONALIZE — use what you know (their interests, devices, stage) so it feels one-to-one. After the onboarding survey, give a short warm recap of what you learned and the single best next step for them. If a TOP NUDGE is in the member context, lead your greeting with it.',
    'PATIENCE — never talk over the member or rush them. Wait until they have clearly finished before you respond; a brief pause is not a finished thought. Ignore background noise, coughs, and side comments — do not treat them as a new question. Keep each reply to one or two sentences so you hand the floor back quickly, and only expand when asked.',
    'EVENTS — if an event is currently published (it appears in your knowledge above), warmly and proactively mention it during the conversation and encourage the member to register, offering to take them there (navigate to the events screen). If they ask about events and none is published, say there is nothing on the calendar right now rather than inventing one.',
    'GATEKEEPER: First read the MEMBER CONTEXT. If there is NO member context, they are a VISITOR — your job is to warmly show the value and lead them to JOIN (Free to start, or the tier that matches their goal) or sign in. If there IS member context, they are a MEMBER — check ONBOARDING PROFILE: if NOT DONE, at a natural moment offer the quick getting-to-know-you and run the ONBOARDING SURVEY; if DONE, skip the survey and instead make tailored, relevant suggestions from their interests and the TARGETED RECOMMENDATIONS. If that member is a FREE (non-paying) member, prioritize warmly encouraging a paid membership (Silver/Gold/Diamond) — connect each benefit to what they told us in their profile — and give the exact activation link; never pressure.',
    'SURVEY SAVE MECHANISM (voice): to record each step, CALL the save_onboarding_step tool with { stepKey, selections: [exact option label(s)], freeText?, complete? }. The tool truly saves their preferences, so after it succeeds you MAY say you have noted/saved their answer (this is the one exception to "never claim you changed anything"). Never read tag names aloud.',
    onboarding.onboardingPromptBlock(),
        'Start every new visit with one warm, short welcome suited to visitor or signed-in-member status. Offer two or three relevant paths, ask what they want, and stay with them until they finish.',
  ].filter(Boolean).join('\n');
}

// Builds a private, per-member context block from the signed-in session so Gaia
// can greet by name and speak to the member's own courses/progress. Returns ''
// for anonymous visitors (Gaia stays generic). Never throws — personalization
// must never block the voice token.
// Phase 4 — builds the private, per-member AI context from the LIVE normalized
// data layer. Privacy-safe (no amounts/PII beyond first name + status), and
// honest: never fabricates course progress or community posts (not in the API).
// Returns '' for anonymous visitors (Gaia stays generic/public). Cached ~60s
// per contact so prewarm+start don't double-hit GHL.
const _memberAiCtxCache = new Map();
const ASSIST_MEMORY_FILE = path.join(process.cwd(), 'data', 'assist-memory.json');
function loadAssistMemory() { try { return JSON.parse(fs.readFileSync(ASSIST_MEMORY_FILE, 'utf8')) || { byContact: {} }; } catch (_) { return { byContact: {}, updatedAt: null }; } }
function saveAssistMemory(m) { try { writeJsonAtomic(ASSIST_MEMORY_FILE, m); } catch (e) {} }
function fmtSince(iso) { try { const d = Date.now() - Date.parse(iso); const day = 86400000; if (d < 3600000) return 'earlier today'; if (d < day) return 'today'; const days = Math.floor(d / day); if (days === 1) return 'yesterday'; if (days < 30) return days + ' days ago'; const mo = Math.floor(days / 30); return mo + ' month' + (mo > 1 ? 's' : '') + ' ago'; } catch (e) { return ''; } }
function rememberForContact(cid, facts, summary) {
  if (!cid) return { ok: false, reason: 'no_contact' };
  const store = loadAssistMemory();
  const now = new Date().toISOString();
  const rec = store.byContact[cid] || { facts: [], firstSeen: now, sessions: 0 };
  const gap = rec.lastSeen ? (Date.parse(now) - Date.parse(rec.lastSeen)) : Infinity;
  if (gap > 30 * 60 * 1000) rec.sessions = (rec.sessions || 0) + 1;
  rec.lastSeen = now;
  (Array.isArray(facts) ? facts : []).forEach((f) => {
    const t = String(f || '').trim().slice(0, 240);
    if (t && !rec.facts.some((x) => x.text.toLowerCase() === t.toLowerCase())) rec.facts.push({ text: t, at: now });
  });
  if (rec.facts.length > 40) rec.facts = rec.facts.slice(-40);
  if (summary) rec.summary = String(summary).slice(0, 600);
  store.byContact[cid] = rec; store.updatedAt = now; saveAssistMemory(store);
  return { ok: true, count: rec.facts.length };
}
function memoryContextLine(cid) {
  if (!cid) return '';
  const rec = loadAssistMemory().byContact[cid];
  if (!rec || !Array.isArray(rec.facts) || !rec.facts.length) return '';
  const when = rec.lastSeen ? fmtSince(rec.lastSeen) : '';
  const lines = ['WHAT YOU REMEMBER ABOUT THIS MEMBER (from past visits' + (when ? ', last seen ' + when : '') + ') — reference it lightly to continue naturally; never re-ask what you already know here, and never repeat an offer they declined:'];
  rec.facts.slice(-16).forEach((f) => lines.push('- ' + f.text));
  if (rec.summary) lines.push('Summary of them: ' + rec.summary);
  return lines.join('\n');
}
async function buildMemberVoiceContext(req) {
  try {
    const member = sessionMemberContext(req);
    if (!member) return ''; // anonymous / public → generic Gaia
    const b = await fetchMemberBundle(member);
    const cid = b.contactId;
    const cached = cid && _memberAiCtxCache.get(cid);
    if (cached && (Date.now() - cached.at) < 60000) return cached.text;

    const access = buildMemberAccess(b.tags, b.customFields, b.member, b.entitlements, b.subscriptions);
    const [apptsRaw, convos, orders, subs, formSubs, surveySubs] = await Promise.all([
      cid ? ghlGet(`/contacts/${encodeURIComponent(cid)}/appointments`).then((r) => r?.events || r?.appointments || []).catch(() => []) : [],
      cid ? ghlMemberConversations(cid, 5).catch(() => []) : [],
      cid ? ghlMemberOrders(cid, 20).catch(() => []) : [],
      Array.isArray(b.subscriptions) ? b.subscriptions : [],
      cid ? ghlMemberSubmissions(cid, 'forms', 100).catch(() => []) : [],
      cid ? ghlMemberSubmissions(cid, 'surveys', 100).catch(() => []) : [],
    ]);
    const firstName = (String(b.member.displayName || 'there').trim().split(/\s+/)[0]) || 'there';
    const unlocked = access.communities.unlocked.map((c) => c.name);
    const lockedNames = access.communities.locked.filter((c) => c.state === 'locked').map((c) => c.name);
    const owned = access.products.map((p) => p.name);
    const paid = (Array.isArray(orders) ? orders : []).filter(orderIsPaid);
    const now = Date.now();
    const upcoming = (Array.isArray(apptsRaw) ? apptsRaw : []).filter((a) => { const t = Date.parse(a.startTime || ''); return Number.isFinite(t) && t > now; });
    const unread = (Array.isArray(convos) ? convos : []).reduce((n, c) => n + Number(c.unreadCount || 0), 0);

    const lines = [
      'MEMBER CONTEXT (private — this is the currently signed-in member). Use it ONLY to personalize answers for this person. Never read it aloud verbatim, never disclose it to anyone else, and never reference data belonging to other members.',
      `You are speaking with ${b.member.displayName || firstName}. Greet them by first name ("${firstName}").`,
    ];
    const status = [b.member.role, b.member.cohort, access.member.membershipTier ? `${access.member.membershipTier} member` : '', access.member.practitioner ? (access.member.practitionerCertified ? 'certified practitioner' : 'practitioner') : ''].filter(Boolean).join(' · ');
    if (status) lines.push(`Status: ${status}.`);
    if (unlocked.length) lines.push(`Community access (unlocked): ${unlocked.join(', ')}.`);
    if (lockedNames.length) lines.push(`Not included yet: ${lockedNames.join(', ')} — if asked, offer to help them get access; never claim they already have it.`);
    if (owned.length) lines.push(`Owns/uses: ${owned.join(', ')}.`);
    const courseNames = Array.isArray(b.entitlements && b.entitlements.courses)
      ? b.entitlements.courses.map((c) => String((c && (c.name || c.id)) || '').trim()).filter(Boolean)
      : [];
    if (courseNames.length) {
      lines.push('Course access (unlocked, ' + courseNames.length + '): ' + courseNames.slice(0, 24).join(', ') + (courseNames.length > 24 ? ', and more' : '') + '. If they ask which courses they have, list these by name. Opening a course takes them to their course library in the education portal, where the lessons play.');
    }
    if (paid.length || subs.length) lines.push(`Account: ${paid.length} completed purchase(s), ${subs.length} subscription(s) on file. Do NOT say amounts, prices, or card details out loud.`);
    if (upcoming.length) lines.push(`Has ${upcoming.length} upcoming appointment(s) booked.`);
    if (formSubs.length || surveySubs.length) lines.push(`Has submitted ${formSubs.length} form(s) and ${surveySubs.length} survey(s).`);
    if (unread) lines.push(`Has ${unread} unread message(s) in their Gaia Healers conversations.`);

    lines.push('WHAT YOU CAN SEE: their profile, memberships/communities, which courses they are entitled to (by name), products/devices, purchases & subscriptions (counts only), appointments, forms/surveys submitted, and conversation notifications.');
    lines.push('WHAT YOU CANNOT SEE: how far along a lesson they are, grades, or community post/discussion content — the backend does not expose these. You CAN tell them which courses they have access to and open the course for them; you cannot report lesson-by-lesson progress or a scan reading. If asked for those, say plainly you can open the course or community in the portal but cannot read the detail from here. NEVER invent progress, grades, posts, scan numbers, or history.');
    lines.push('Privacy: discuss only THIS member’s own data, and only when they ask about it. Do not proactively recite sensitive details.');

    try {
      const mem = memoryContextLine(cid); if (mem) lines.push(mem);
      const obState = onboarding.onboardingState(b.tags);
      lines.push('ONBOARDING PROFILE: ' + (obState === 'complete'
        ? 'DONE — do NOT run the onboarding survey again; use their interests below to tailor suggestions.'
        : 'NOT DONE — when the moment fits, warmly offer the quick 2-minute getting-to-know-you and run the ONBOARDING SURVEY, saving each step.'));
      const interestTags = (b.tags || []).filter((t) => /^(interest_|product_.*_(interest|owner)|practice_stage_|invest_|community_feature_|need_)/.test(String(t).toLowerCase()));
      if (interestTags.length) lines.push('What we already know (profile tags): ' + interestTags.slice(0, 40).join(', ') + '.');
      const hasPaidSub = Array.isArray(b.subscriptions) && b.subscriptions.some((x) => /active|trialing/i.test(String(x.status || '')));
      lines.push('SUBSCRIPTION: ' + (hasPaidSub
        ? 'This member is a PAID subscriber — do NOT pitch a plan they already pay for; focus on helping them get more value from it.'
        : 'This member is a FREE member (no active paid subscription). If their onboarding is DONE, your priority is to warmly encourage upgrading to a paid membership (Silver/Gold/Diamond), tying each benefit to their own goals/tags, and hand them the exact activation link. Guide, never pressure.'));
      var nudge = '';
      if (obState !== 'complete') nudge = 'they have not finished the quick getting-to-know-you survey — warmly offer to do it now (about 2 minutes) so you can tailor everything to them.';
      else if (unread) nudge = 'they have ' + unread + ' unread message(s) in Gaia — mention it and offer to open their inbox.';
      else if (Array.isArray(upcoming) && upcoming.length) nudge = 'they have an upcoming session booked — acknowledge it warmly and ask if they want the details.';
      else if (_lastPublishedEvent && _lastPublishedEvent.name) nudge = 'the event "' + _lastPublishedEvent.name + '" is on the calendar — invite them to register.';
      else if (!hasPaidSub) nudge = 'they are on the free plan — when it fits, warmly show why a paid membership matches the goals they shared.';
      if (nudge) lines.push('TOP NUDGE (open your first greeting with this, in your own warm words, then ask what they want): ' + nudge);
      let storeProducts = [];
      try { const sc = loadStoreCatalog(); const pl = (sc && sc.products) ? Object.values(sc.products) : []; storeProducts = pl.filter((p) => p && !p.hidden && p.title).map((p) => ({ title: p.title, price: (p.priceVaries ? 'from ' : '') + priceFromCents(p.priceCents), available: p.available !== false, url: p.url || '' })); } catch (e) {}
      let courseTitles = []; try { courseTitles = (loadAcademyManifest().courses || []).map((c) => c.title); } catch (e) {}
      let ownedCourseTitles = []; try { ownedCourseTitles = (b.entitlements && Array.isArray(b.entitlements.courses)) ? b.entitlements.courses.map((c) => String((c && (c.name || c.id)) || '')).filter(Boolean) : []; } catch (e) {}
      const rec = onboarding.buildTargeting(b.tags, { storeProducts, courseTitles, ownedCourseTitles, hasPaidSub });
      const tblock = onboarding.formatTargeting(rec);
      if (tblock) lines.push(tblock);
    } catch (e) {}
    const text = lines.join('\n');
    if (cid) _memberAiCtxCache.set(cid, { at: Date.now(), text });
    return text;
  } catch {
    return '';
  }
}

function buildGaiaLiveConnectConfig(context = {}) {
  const cfg = gaiaLiveVoiceConfig();
  return {
    responseModalities: ['AUDIO'],
    temperature: 0.8,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: cfg.voice,
        },
      },
    },
    systemInstruction: {
      parts: [{ text: buildGaiaLiveInstructions(context) }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

async function assistLiveToken(req, res, origin, url) {
  const startedAt = Date.now();
  const cfg = gaiaLiveVoiceConfig();
  if (!cfg.enabled) {
    sendJson(res, 200, { ok: false, disabled: true, reason: 'gaia_voice_disabled' }, origin);
    return;
  }

  const apiKey = geminiApiKey();
  if (!apiKey) {
    sendJson(res, 503, { ok: false, reason: 'missing_gemini_api_key' }, origin);
    return;
  }

  const view = String(url.searchParams.get('view') || 'today').trim() || 'today';
  const memberContext = await buildMemberVoiceContext(req);
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();

  try {
    const client = await getGeminiClient();

    const authToken = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });

    const token = authToken?.name || authToken?.token || '';
    if (!token) {
      throw new Error('Gemini auth token missing name');
    }

    console.log('[Gaia Assist] gemini live token ready', {
      model: cfg.model,
      voice: cfg.voice,
      view,
      latencyMs: Date.now() - startedAt,
    });

    sendJson(res, 200, {
      ok: true,
      token,
      provider: cfg.provider,
      model: cfg.model,
      voice: cfg.voice,
      instructions: buildGaiaLiveInstructions({ view, memberContext }),
      personalized: Boolean(memberContext),
      maxSessionSeconds: cfg.maxSessionSeconds,
      expireTime,
    }, origin);
  } catch (error) {
    console.error('[Gaia Assist] gemini live token failed', {
      error: error.message,
      latencyMs: Date.now() - startedAt,
    });
    sendJson(res, 502, {
      ok: false,
      reason: 'gemini_live_token_failed',
      error: error.message.split('\n')[0],
    }, origin);
  }
}

async function getEventSummary() {
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    // Deliberately empty. Returning a remembered event name/venue here would
    // render a card that looks live while the Event Manager is unreachable; the
    // app shows its "no event published" state instead.
    _lastPublishedEvent = null;
    return { ...EMPTY_EVENT, source: 'not-connected', note: 'Event Manager endpoint is not configured.' };
  }

  const headers = {};
  if (process.env.EVENT_MANAGER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EVENT_MANAGER_TOKEN}`;
  }

  // Whichever published event is next. No pinned id: the featured event follows
  // the data, so a new event becomes the featured one by being published.
  const event = await fetchJson(`${base}/public/events/next`, headers);
  // Every field below comes from the Event Manager. Empty stays empty: the app
  // renders "to be announced" rather than a plausible-looking invention, and
  // nothing here is tied to one particular event.
  const summary = {
    id: `event-${event.id || 'next'}`,
    name: event.name || '',
    date: event.start_date && event.end_date ? `${event.start_date} - ${event.end_date}` : '',
    startDate: event.start_date || null,
    endDate: event.end_date || null,
    description: event.description || '',
    venue: event.location || '',
    location: event.location || '',
    timezone: event.timezone || 'UTC',
    startAt: event.start_at || null,
    endAt: event.end_at || null,
    serverTime: event.server_time || null,
    heroImageUrl: event.hero_image_url || '',
    registrationUrl: event.registration_url || event.source_url || '',
    registrationLabel: event.registration_label || 'Buy ticket',
    sourceUrl: event.source_url || '',
    source: 'event-manager',
    liveData: true,
    stats: {
      attendees: event.attendee_count || 0,
      paidMembers: 0,
      checkedIn: event.checked_in_count || 0,
      exhibitors: event.exhibitor_count || 0,
      leads: event.lead_count || 0,
      sessions: event.session_count || 0,
      speakers: event.speaker_count || 0,
      checkInRate: event.attendee_count ? Math.round(((event.checked_in_count || 0) / event.attendee_count) * 100) : 0,
    },
  };
  _lastPublishedEvent = summary;
  return summary;
}

// --- Event Manager public surface -------------------------------------------
// Agenda, speakers and the exhibitor directory, read from the Event Manager and
// re-served to the app. Only published rows ever leave the Event Manager, and
// its exhibitor payload already omits organiser-only contact details.
const EVENT_PUBLIC_CACHE_MS = 60 * 1000;
const _eventPublicCache = new Map();

async function eventManagerGet(path, maxAgeMs = EVENT_PUBLIC_CACHE_MS) {
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return null;

  const hit = _eventPublicCache.get(path);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;

  const headers = {};
  if (process.env.EVENT_MANAGER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EVENT_MANAGER_TOKEN}`;
  }
  let value = null;
  try {
    value = await fetchJsonIfOk(`${base}${path}`, headers);
  } catch (_) {
    // Service down or refusing connections: fetch throws rather than returning a
    // response. Callers render an empty state; a 500 here would break the app's
    // Events view entirely.
    return null;
  }
  if (value !== null) _eventPublicCache.set(path, { at: Date.now(), value });
  return value;
}

function normalizeEventCard(event = {}) {
  return {
    id: event.id,
    name: event.name || '',
    description: event.description || '',
    startDate: event.start_date || null,
    endDate: event.end_date || null,
    venue: event.location || '',
    location: event.location || '',
    // Session times are local to this zone — clients must not re-offset them.
    timezone: event.timezone || 'UTC',
    // Unambiguous instants from the server. startDate/endDate above stay
    // venue-local for display; these are what a countdown must use.
    startAt: event.start_at || null,
    endAt: event.end_at || null,
    serverTime: event.server_time || null,
    heroImageUrl: event.hero_image_url || '',
    // Where to buy. Falls back to the import source only while an operator has
    // not set a destination — the two are different things.
    registrationUrl: event.registration_url || event.source_url || '',
    registrationLabel: event.registration_label || 'Buy ticket',
    sourceUrl: event.source_url || '',
  };
}

async function eventsList(req, res, origin, url) {
  // The hub asks for past events too, to show a "Past events" section.
  const includePast = url && /^(1|true|yes)$/i.test(String(url.searchParams.get('include_past') || ''));
  const events = await eventManagerGet(`/public/events${includePast ? '?include_past=true' : ''}`);
  if (events === null) {
    sendJson(res, 200, { ok: true, events: [], source: 'not-connected' }, origin);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    source: 'event-manager',
    events: (Array.isArray(events) ? events : []).map(normalizeEventCard),
  }, origin);
}

async function eventDetail(req, res, origin, eventId) {
  const [event, agenda, speakers, exhibitors, sponsors, announcements, venueMap, info, resources] = await Promise.all([
    eventManagerGet(`/public/events/${eventId}`),
    eventManagerGet(`/public/events/${eventId}/agenda`),
    eventManagerGet(`/public/events/${eventId}/speakers`),
    eventManagerGet(`/public/events/${eventId}/exhibitors`),
    eventManagerGet(`/public/events/${eventId}/sponsors`),
    eventManagerGet(`/public/events/${eventId}/announcements`),
    eventManagerGet(`/public/events/${eventId}/map`),
    eventManagerGet(`/public/events/${eventId}/info`),
    eventManagerGet(`/public/events/${eventId}/resources`),
  ]);
  if (!event) {
    sendJson(res, 404, { ok: false, error: 'event_not_found' }, origin);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    source: 'event-manager',
    event: normalizeEventCard(event),
    agenda: agenda && Array.isArray(agenda.days) ? agenda : { days: [] },
    speakers: Array.isArray(speakers) ? speakers : [],
    exhibitors: Array.isArray(exhibitors) ? exhibitors : [],
    sponsors: Array.isArray(sponsors) ? sponsors : [],
    announcements: Array.isArray(announcements) ? announcements : [],
    // FAQ / help / event-info cards, grouped by section.
    info: (info && Array.isArray(info.items)) ? info.items : [],
    // Downloadable files / links the organiser published.
    resources: Array.isArray(resources) ? resources : [],
    // Absent (not empty) when the organiser has not built a map, so the app
    // can skip the tab entirely rather than show a blank floor plan.
    map: venueMap && (venueMap.map_image_url || (venueMap.places || []).length)
      ? venueMap : null,
  }, origin);
}

// The live surface changes minute to minute during an event, so it gets a much
// shorter cache than the agenda — but still enough to absorb a hall full of
// phones polling at once.
const EVENT_LIVE_CACHE_MS = 10 * 1000;

async function eventLive(req, res, origin, eventId) {
  const live = await eventManagerGet(`/public/events/${eventId}/live`, EVENT_LIVE_CACHE_MS);
  if (!live) {
    sendJson(res, 404, { ok: false, error: 'event_not_found' }, origin);
    return;
  }
  sendJson(res, 200, { ok: true, source: 'event-manager', live }, origin);
}

async function getGhlSummary() {
  const cfg = ghlConfig();
  if (!cfg.enabled) {
    return { configured: false };
  }

  const lookup = await ghlGet('/contacts', { locationId: cfg.locationId, limit: 1 });
  const contactsPreview = Array.isArray(lookup?.contacts)
    ? lookup.contacts.length
    : Array.isArray(lookup?.data?.contacts)
      ? lookup.data.contacts.length
      : 0;
  return {
    configured: true,
    normalized: false,
    liveData: Boolean(lookup),
    locationId: cfg.locationId,
    apiBaseUrl: cfg.base,
    contactsPreview,
    note: lookup
      ? 'GHL contact endpoint is reachable. Using direct contact/member reads with portal-only fallback for unavailable resources.'
      : 'GHL credentials are configured, but contact endpoint probe failed.',
  };
}

function clampPercent(value) {
  return clampNumber(value, 0, 100, 0);
}

function normalizeCourse(raw = {}, index = 0) {
  const completedLessons = Number(raw.completedLessons ?? raw.lessonsCompleted ?? raw.completed_lessons ?? 0);
  const totalLessons = Number(raw.totalLessons ?? raw.lessonsTotal ?? raw.total_lessons ?? raw.lessonCount ?? 0);
  const computedProgress = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
  const progressPercent = clampPercent(raw.progressPercent ?? raw.progress ?? raw.percentComplete ?? raw.completionPercentage ?? computedProgress);
  const status = String(raw.status || (progressPercent >= 100 ? 'completed' : progressPercent > 0 ? 'in_progress' : 'available')).toLowerCase();
  return {
    id: String(raw.id || raw.courseId || raw.course_id || `course-${index + 1}`),
    title: String(raw.title || raw.name || raw.courseName || 'Untitled course'),
    category: String(raw.category || raw.group || raw.track || 'Academy'),
    status,
    progressPercent,
    completedLessons: Number.isFinite(completedLessons) ? completedLessons : 0,
    totalLessons: Number.isFinite(totalLessons) ? totalLessons : 0,
    instructor: String(raw.instructor || raw.faculty || ''),
    lastActivity: String(raw.lastActivity || raw.last_activity || raw.updatedAt || raw.updated_at || ''),
    nextLessonTitle: String(raw.nextLessonTitle || raw.nextLesson || raw.next_lesson || raw.currentLesson || raw.current_lesson || ''),
    continueUrl: String(raw.continueUrl || raw.url || raw.href || raw.deepLink || raw.deep_link || ''),
    credential: String(raw.credential || raw.certificate || ''),
    ceCredits: Number(raw.ceCredits ?? raw.ce_credits ?? 0) || 0,
  };
}

function normalizeAcademyProgress(payload = {}) {
  const sourceCourses = Array.isArray(payload.courses)
    ? payload.courses
    : Array.isArray(payload.enrollments)
      ? payload.enrollments
      : [];
  const courses = sourceCourses.map(normalizeCourse);
  const activeCourse = courses.find((course) => course.status === 'in_progress')
    || courses.find((course) => course.progressPercent > 0 && course.progressPercent < 100)
    || courses[0]
    || {
      id: '',
      title: FALLBACK_ACADEMY.summary.nextCourseTitle,
      nextLessonTitle: FALLBACK_ACADEMY.summary.nextLessonTitle,
      continueUrl: FALLBACK_ACADEMY.summary.nextLessonUrl,
    };
  const completed = courses.filter((course) => course.status === 'completed' || course.progressPercent >= 100).length;
  const inProgress = courses.filter((course) => course.progressPercent > 0 && course.progressPercent < 100).length;
  const averageProgress = courses.length
    ? Math.round(courses.reduce((sum, course) => sum + course.progressPercent, 0) / courses.length)
    : 0;

  return {
    ok: true,
    configured: Boolean(payload.configured ?? true),
    liveData: Boolean(payload.liveData ?? payload.live_data ?? true),
    source: String(payload.source || 'academy-connector'),
    generatedAt: String(payload.generatedAt || payload.generated_at || new Date().toISOString()),
    member: {
      name: String(payload.member?.name || payload.contact?.name || 'Gaia Healers member'),
      email: String(payload.member?.email || payload.contact?.email || ''),
      portalUrl: String(payload.member?.portalUrl || payload.portalUrl || FALLBACK_ACADEMY.member.portalUrl),
    },
    summary: {
      enrolled: Number(payload.summary?.enrolled ?? courses.length) || courses.length,
      completed: Number(payload.summary?.completed ?? completed) || completed,
      inProgress: Number(payload.summary?.inProgress ?? inProgress) || inProgress,
      averageProgress: clampPercent(payload.summary?.averageProgress ?? averageProgress),
      nextCourseTitle: String(payload.summary?.nextCourseTitle || activeCourse.title),
      nextLessonTitle: String(payload.summary?.nextLessonTitle || activeCourse.nextLessonTitle || 'Continue course'),
      nextLessonUrl: String(payload.summary?.nextLessonUrl || activeCourse.continueUrl || ''),
      ceCreditsEarned: Number(payload.summary?.ceCreditsEarned ?? payload.summary?.ce_credits_earned ?? FALLBACK_ACADEMY.summary.ceCreditsEarned) || 0,
      ceCreditsRequired: Number(payload.summary?.ceCreditsRequired ?? payload.summary?.ce_credits_required ?? FALLBACK_ACADEMY.summary.ceCreditsRequired) || 0,
    },
    activeCourseId: String(payload.activeCourseId || payload.active_course_id || activeCourse.id),
    courses,
    credentials: Array.isArray(payload.credentials) ? payload.credentials : FALLBACK_ACADEMY.credentials,
    requirements: payload.requirements || FALLBACK_ACADEMY.requirements,
    portalOnlyFields: Array.isArray(payload.portalOnlyFields) ? payload.portalOnlyFields : [],
    memberResolved: Boolean(payload.memberResolved ?? false),
    authenticated: Boolean(payload.authenticated ?? false),
  };
}

function academyCourseToCommunityCourse(course = {}) {
  return {
    groupId: String(course.category || '').toLowerCase().includes('bio-well') ? 'biowell' : 'all',
    title: String(course.title || 'Course'),
    detail: `${course.progressPercent ? `${course.progressPercent}% complete` : 'Available'}${course.nextLessonTitle ? ` · ${course.nextLessonTitle}` : ''}`,
    href: String(course.continueUrl || 'home.html?view=academy'),
  };
}

function normalizeMemberHub(payload = {}, academy = FALLBACK_ACADEMY) {
  const sourceCourses = Array.isArray(payload.courses) && payload.courses.length
    ? payload.courses.map(normalizeCourse)
    : (Array.isArray(academy.courses) ? academy.courses.map((course, index) => normalizeCourse(course, index)) : []);
  const credentials = Array.isArray(payload.credentials) && payload.credentials.length
    ? payload.credentials
    : (Array.isArray(academy.credentials) ? academy.credentials : []);

  return {
    ok: true,
    configured: Boolean(payload.configured ?? true),
    liveData: Boolean(payload.liveData ?? payload.live_data ?? true),
    source: String(payload.source || 'member-hub'),
    generatedAt: String(payload.generatedAt || payload.generated_at || new Date().toISOString()),
    member: {
      displayName: String(payload.member?.displayName || payload.member?.name || 'Gaia Healers member'),
      role: String(payload.member?.role || 'Practitioner'),
      cohort: String(payload.member?.cohort || 'Bio-Well Practitioners'),
      portalUrl: String(payload.member?.portalUrl || payload.portal?.url || FALLBACK_MEMBER_HUB.portal.url),
    },
    portal: {
      url: String(payload.portal?.url || FALLBACK_MEMBER_HUB.portal.url),
      users: Number(payload.portal?.users ?? FALLBACK_MEMBER_HUB.portal.users) || FALLBACK_MEMBER_HUB.portal.users,
      invited: Number(payload.portal?.invited ?? FALLBACK_MEMBER_HUB.portal.invited) || FALLBACK_MEMBER_HUB.portal.invited,
      adminSections: Array.isArray(payload.portal?.adminSections) ? payload.portal.adminSections : FALLBACK_MEMBER_HUB.portal.adminSections,
      actions: Array.isArray(payload.portal?.actions) ? payload.portal.actions : FALLBACK_MEMBER_HUB.portal.actions,
    },
    dashboard: {
      welcomeTitle: String(payload.dashboard?.welcomeTitle || payload.overview?.welcomeTitle || FALLBACK_MEMBER_HUB.dashboard.welcomeTitle),
      welcomeDetail: String(payload.dashboard?.welcomeDetail || payload.overview?.welcomeDetail || FALLBACK_MEMBER_HUB.dashboard.welcomeDetail),
      nextLessonTitle: String(payload.dashboard?.nextLessonTitle || academy.summary?.nextLessonTitle || FALLBACK_MEMBER_HUB.dashboard.nextLessonTitle),
      nextLessonUrl: String(payload.dashboard?.nextLessonUrl || academy.summary?.nextLessonUrl || ''),
      nextMeetingTitle: String(payload.dashboard?.nextMeetingTitle || FALLBACK_MEMBER_HUB.dashboard.nextMeetingTitle),
      nextMeetingTime: String(payload.dashboard?.nextMeetingTime || FALLBACK_MEMBER_HUB.dashboard.nextMeetingTime),
      eventPassTitle: String(payload.dashboard?.eventPassTitle || FALLBACK_MEMBER_HUB.dashboard.eventPassTitle),
      eventPassDetail: String(payload.dashboard?.eventPassDetail || FALLBACK_MEMBER_HUB.dashboard.eventPassDetail),
      ceCreditsEarned: Number(payload.dashboard?.ceCreditsEarned ?? academy.summary?.ceCreditsEarned ?? FALLBACK_MEMBER_HUB.dashboard.ceCreditsEarned) || 0,
      ceCreditsRequired: Number(payload.dashboard?.ceCreditsRequired ?? academy.summary?.ceCreditsRequired ?? FALLBACK_MEMBER_HUB.dashboard.ceCreditsRequired) || 0,
      topCourse: String(payload.dashboard?.topCourse || FALLBACK_MEMBER_HUB.dashboard.topCourse),
      topCourseMeta: String(payload.dashboard?.topCourseMeta || FALLBACK_MEMBER_HUB.dashboard.topCourseMeta),
      revenueGenerated: String(payload.dashboard?.revenueGenerated || FALLBACK_MEMBER_HUB.dashboard.revenueGenerated),
      averageOrderValue: String(payload.dashboard?.averageOrderValue || FALLBACK_MEMBER_HUB.dashboard.averageOrderValue),
      totalCheckouts: Number(payload.dashboard?.totalCheckouts ?? FALLBACK_MEMBER_HUB.dashboard.totalCheckouts) || 0,
    },
    communities: Array.isArray(payload.communities) && payload.communities.length ? payload.communities : FALLBACK_MEMBER_HUB.communities,
    discussions: Array.isArray(payload.discussions) && payload.discussions.length ? payload.discussions : FALLBACK_MEMBER_HUB.discussions,
    events: Array.isArray(payload.events) && payload.events.length ? payload.events : FALLBACK_MEMBER_HUB.events,
    members: Array.isArray(payload.members) && payload.members.length ? payload.members : FALLBACK_MEMBER_HUB.members,
    newsletters: Array.isArray(payload.newsletters) && payload.newsletters.length ? payload.newsletters : FALLBACK_MEMBER_HUB.newsletters,
    products: Array.isArray(payload.products) && payload.products.length ? payload.products : FALLBACK_MEMBER_HUB.products,
    meetings: Array.isArray(payload.meetings) && payload.meetings.length ? payload.meetings : FALLBACK_MEMBER_HUB.meetings,
    marketplace: payload.marketplace || FALLBACK_MEMBER_HUB.marketplace,
    access: payload.access || FALLBACK_MEMBER_HUB.access,
    credentials,
    courses: sourceCourses,
    communityCourses: sourceCourses.map(academyCourseToCommunityCourse),
    portalOnlyFields: Array.isArray(payload.portalOnlyFields) ? payload.portalOnlyFields : [],
    memberResolved: Boolean(payload.memberResolved ?? false),
    authenticated: Boolean(payload.authenticated ?? false),
  };
}

async function getMemberHub(url = new URL('http://localhost'), academy = FALLBACK_ACADEMY) {
  const configuredUrl = String(process.env.MEMBER_HUB_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.MEMBER_HUB_TOKEN || '';
  const inlineJson = process.env.MEMBER_HUB_JSON || '';
  const memberId = String(url.searchParams.get('memberId') || process.env.MEMBER_HUB_MEMBER_ID || '').trim();
  const email = String(url.searchParams.get('email') || process.env.MEMBER_HUB_EMAIL || '').trim();

  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson);
      return normalizeMemberHub({
        ...parsed,
        configured: true,
        liveData: Boolean(parsed.liveData ?? parsed.live_data ?? true),
        source: parsed.source || 'member-hub-json',
      }, academy);
    } catch (error) {
      return { ...FALLBACK_MEMBER_HUB, error: `MEMBER_HUB_JSON is invalid: ${error.message}` };
    }
  }

  if (configuredUrl) {
    const apiUrl = new URL(configuredUrl);
    if (memberId) apiUrl.searchParams.set('memberId', memberId);
    if (email) apiUrl.searchParams.set('email', email);
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = await fetchJson(apiUrl.toString(), headers);
    return normalizeMemberHub({
      ...payload,
      configured: true,
      liveData: true,
      source: payload.source || 'member-hub-api',
    }, academy);
  }

  const member = await getMemberFromGhl({
    email,
    memberId,
    contactId: memberId,
  });
  if (member.configured && member.memberResolved) {
    const role = firstNonEmptyString(
      member.member.role,
      member.tags.find((tag) => /admin|faculty|staff|mentor/i.test(String(tag || ''))),
      'Member',
    );
    const cohort = firstNonEmptyString(
      member.member.cohort,
      member.tags.find((tag) => /bio-well|biopulsar|biotekna|healeex|abundant/i.test(String(tag || ''))),
      '',
    );
    return normalizeMemberHub({
      configured: true,
      liveData: true,
      source: 'ghl-contact-profile',
      generatedAt: new Date().toISOString(),
      memberResolved: true,
      authenticated: true,
      member: {
        displayName: member.member.displayName,
        role,
        cohort,
        portalUrl: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_MEMBER_HUB.portal.url,
      },
      portal: {
        ...FALLBACK_MEMBER_HUB.portal,
        url: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_MEMBER_HUB.portal.url,
      },
      access: {
        notes: [
          `Member resolved via GHL contact ${member.member.contactId || member.member.memberId || '(no id)'}.`,
          'Community posts, purchases, and membership-gated details remain portal-only until verified read APIs are mapped.',
          'Use secure portal links for gated content.',
        ],
      },
      portalOnlyFields: ['communitiesPrivateData', 'purchases', 'credentialsSourceOfTruth', 'courseProgress'],
    }, academy);
  }

  return normalizeMemberHub({
    ...FALLBACK_MEMBER_HUB,
    generatedAt: new Date().toISOString(),
    portalOnlyFields: ['communitiesPrivateData', 'purchases', 'credentialsSourceOfTruth', 'courseProgress'],
  }, academy);
}

function buildGaiaAppData(event, academy, memberHub) {
  return {
    members: memberHub.portal?.users || FALLBACK_GAIA.members,
    invited: memberHub.portal?.invited || 1,
    portalUrl: memberHub.portal?.url || FALLBACK_MEMBER_HUB.portal.url,
    clientPortal: {
      url: memberHub.portal?.url || FALLBACK_MEMBER_HUB.portal.url,
      users: memberHub.portal?.users || FALLBACK_MEMBER_HUB.portal.users,
      invited: memberHub.portal?.invited || FALLBACK_MEMBER_HUB.portal.invited,
      adminSections: memberHub.portal?.adminSections || FALLBACK_MEMBER_HUB.portal.adminSections,
      actions: memberHub.portal?.actions || FALLBACK_MEMBER_HUB.portal.actions,
    },
    communities: memberHub.communities || FALLBACK_MEMBER_HUB.communities,
    communityFeed: memberHub.discussions || FALLBACK_MEMBER_HUB.discussions,
    communityCourses: memberHub.communityCourses || memberHub.courses?.map(academyCourseToCommunityCourse) || [],
    communityEvents: memberHub.events || FALLBACK_MEMBER_HUB.events,
    communityMembers: memberHub.members || FALLBACK_MEMBER_HUB.members,
    communityNewsletter: memberHub.newsletters || FALLBACK_MEMBER_HUB.newsletters,
    marketplace: memberHub.marketplace || FALLBACK_MEMBER_HUB.marketplace,
    products: memberHub.products || FALLBACK_MEMBER_HUB.products,
    meetings: memberHub.meetings || FALLBACK_MEMBER_HUB.meetings,
    certifications: memberHub.credentials || academy.credentials || FALLBACK_ACADEMY.credentials,
    topCourse: memberHub.dashboard?.topCourse || FALLBACK_MEMBER_HUB.dashboard.topCourse,
    event,
    academy,
    memberHub,
  };
}

async function getAcademyProgress(url = new URL('http://localhost')) {
  const configuredUrl = String(process.env.ACADEMY_PROGRESS_BASE_URL || process.env.GHL_COURSE_PROGRESS_URL || '').replace(/\/+$/, '');
  const token = process.env.ACADEMY_PROGRESS_TOKEN || process.env.GHL_COURSE_PROGRESS_TOKEN || '';
  const inlineJson = process.env.ACADEMY_PROGRESS_JSON || '';
  const memberId = String(url.searchParams.get('memberId') || url.searchParams.get('contactId') || process.env.ACADEMY_PROGRESS_MEMBER_ID || '').trim();
  const email = String(url.searchParams.get('email') || process.env.ACADEMY_PROGRESS_EMAIL || '').trim();

  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson);
      return normalizeAcademyProgress({
        ...parsed,
        configured: true,
        liveData: Boolean(parsed.liveData ?? parsed.live_data ?? true),
        source: parsed.source || 'academy-progress-json',
      });
    } catch (error) {
      return { ...FALLBACK_ACADEMY, error: `ACADEMY_PROGRESS_JSON is invalid: ${error.message}` };
    }
  }

  if (configuredUrl) {
    const apiUrl = new URL(configuredUrl);
    if (memberId) apiUrl.searchParams.set('memberId', memberId);
    if (email) apiUrl.searchParams.set('email', email);
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = await fetchJson(apiUrl.toString(), headers);
    return normalizeAcademyProgress({
      ...payload,
      configured: true,
      liveData: true,
      source: payload.source || 'academy-progress-api',
    });
  }

  const member = await getMemberFromGhl({
    email,
    memberId,
    contactId: memberId,
  });
  if (member.configured && member.memberResolved) {
    return normalizeAcademyProgress({
      ok: true,
      configured: true,
      liveData: false,
      memberResolved: true,
      authenticated: true,
      source: 'ghl-portal-only',
      generatedAt: new Date().toISOString(),
      member: {
        name: member.member.displayName || 'Gaia Healers member',
        email: member.member.email || email,
        portalUrl: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_ACADEMY.member.portalUrl,
      },
      summary: {
        enrolled: 0,
        completed: 0,
        inProgress: 0,
        averageProgress: 0,
        nextCourseTitle: 'Open your secure Academy workspace',
        nextLessonTitle: 'Continue live lessons and locked content in the in-app GHL portal',
        nextLessonUrl: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_ACADEMY.member.portalUrl,
      },
      courses: [],
      credentials: [],
      requirements: {
        title: 'Portal verification required',
        description: 'Direct GHL lesson/progress API is not available in this integration yet. Use your secure portal session for progress.',
        scansCompleted: 0,
        scansRequired: 0,
        courseRequiredPercent: 0,
        currentCoursePercent: 0,
      },
      portalOnlyFields: ['academyProgress', 'courseLessons', 'certificateIssuance'],
    });
  }

  return {
    ...FALLBACK_ACADEMY,
    generatedAt: new Date().toISOString(),
    portalOnlyFields: ['academyProgress', 'courseLessons', 'certificateIssuance'],
  };
}

function applyMemberContextToAcademy(payload, memberContext) {
  if (!payload || !memberContext) return payload;
  const currentName = String(payload.member?.name || '').trim();
  return {
    ...payload,
    member: {
      ...(payload.member || {}),
      name: !currentName || currentName === 'Gaia Healers member' ? (memberContext.displayName || 'Gaia Healers member') : currentName,
      email: payload.member?.email || memberContext.email || '',
    },
  };
}

function applyMemberContextToMemberHub(payload, memberContext) {
  if (!payload || !memberContext) return payload;
  const currentName = String(payload.member?.displayName || '').trim();
  return {
    ...payload,
    member: {
      ...(payload.member || {}),
      displayName: !currentName || currentName === 'Gaia Healers member' ? (memberContext.displayName || 'Gaia Healers member') : currentName,
      role: payload.member?.role || memberContext.role || 'Member',
      cohort: payload.member?.cohort || memberContext.cohort || '',
      portalUrl: payload.member?.portalUrl || FALLBACK_MEMBER_HUB.member.portalUrl,
    },
  };
}

async function bootstrap(req, url) {
  const memberContext = sessionMemberContext(req);
  const academyUrl = withMemberContext(url, memberContext);
  const [event, ghl, academy] = await Promise.all([
    getEventSummary().catch((error) => ({ ...EMPTY_EVENT, source: 'event-manager-error', error: error.message })),
    getGhlSummary().catch((error) => ({ configured: false, error: error.message })),
    getAcademyProgress(academyUrl).catch((error) => ({ ...FALLBACK_ACADEMY, source: 'academy-error', error: error.message })),
  ]);
  const session = cookieForRequest(req);
  const authenticated = Boolean(session?.member);
  const memberResolved = Boolean(memberContext?.email || memberContext?.memberId || memberContext?.contactId);
  let academyScoped = applyMemberContextToAcademy(academy, memberContext);
  let memberHub = await getMemberHub(academyUrl, academyScoped).catch((error) => ({ ...FALLBACK_MEMBER_HUB, source: 'member-hub-error', error: error.message }));
  let memberHubScoped = applyMemberContextToMemberHub(memberHub, memberContext);

  if (!authenticated && !memberResolved) {
    academyScoped = normalizeAcademyProgress({
      configured: true,
      liveData: false,
      authenticated: false,
      memberResolved: false,
      source: 'anonymous-portal-login',
      member: {
        name: 'Gaia Healers member',
        email: '',
        portalUrl: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_ACADEMY.member.portalUrl,
      },
      summary: {
        enrolled: 0,
        completed: 0,
        inProgress: 0,
        averageProgress: 0,
        nextCourseTitle: 'Open your secure Academy workspace',
        nextLessonTitle: 'Member login unlocks your live lessons and course progress in-app',
        nextLessonUrl: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_ACADEMY.member.portalUrl,
        ceCreditsEarned: 0,
        ceCreditsRequired: FALLBACK_ACADEMY.summary.ceCreditsRequired,
      },
      courses: [],
      credentials: [],
      requirements: {
        title: 'Member login required',
        description: 'Sign in with your Gaia Healers portal account to unlock your own course progress, certificates, and gated lessons.',
        scansCompleted: 0,
        scansRequired: 0,
        courseRequiredPercent: 0,
        currentCoursePercent: 0,
      },
      portalOnlyFields: ['academyProgress', 'courseLessons', 'certificateIssuance'],
    });

    memberHubScoped = normalizeMemberHub({
      ...memberHubScoped,
      configured: true,
      liveData: false,
      authenticated: false,
      memberResolved: false,
      source: 'anonymous-portal-login',
      member: {
        displayName: 'Gaia Healers member',
        role: 'Member',
        cohort: 'Client portal',
        portalUrl: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_MEMBER_HUB.portal.url,
      },
      dashboard: {
        ...(memberHubScoped.dashboard || {}),
        welcomeTitle: 'Your Gaia Healers dashboard is ready',
        welcomeDetail: 'Sign in once to load your own courses, communities, products, and certificates inside the app.',
        topCourse: 'Secure Academy workspace',
        topCourseMeta: 'Member login unlocks your course progress',
        nextLessonTitle: 'Log in to continue your live lessons',
        eventPassTitle: event?.shortName || event?.name || '',
        eventPassDetail: 'Badge ops ready',
        ceCreditsEarned: 0,
        ceCreditsRequired: FALLBACK_ACADEMY.summary.ceCreditsRequired,
      },
      access: {
        notes: [
          'Public app shell is ready.',
          'Member-specific courses, purchases, communities, and certificates unlock after Gaia Healers portal login.',
        ],
      },
      portalOnlyFields: uniqueStrings([
        ...(memberHubScoped.portalOnlyFields || []),
        'communitiesPrivateData',
        'purchases',
        'credentialsSourceOfTruth',
        'courseProgress',
      ]),
    }, academyScoped);
  }

  const liveData = Boolean(event.liveData || ghl.liveData || ghl.normalized || academyScoped.liveData || memberHubScoped.liveData);
  const gaiaData = buildGaiaAppData(event, academyScoped, memberHubScoped);
  const portalOnlyFields = uniqueStrings([
    ...(academyScoped.portalOnlyFields || []),
    ...(memberHubScoped.portalOnlyFields || []),
  ]);

  return {
    ok: true,
    gaia: {
      ...FALLBACK_GAIA,
      ...gaiaData,
      sync: {
        generatedAt: new Date().toISOString(),
        liveData,
        mode: liveData ? 'live' : 'proxy-connected',
        authenticated,
        memberResolved,
        academyConfigured: Boolean(academyScoped.configured),
        academyLive: Boolean(academyScoped.liveData),
        hubConfigured: Boolean(memberHubScoped.configured),
        hubLive: Boolean(memberHubScoped.liveData),
        portalOnlyFields,
        ghl,
        auth: sessionPublicShape(session),
        voice: {
          configured: Boolean(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY),
          enabled: process.env.GAIA_ASSIST_VOICE_ENABLED === 'true',
          providerOrder: ASSIST_PROVIDER_ORDER,
          live: gaiaLiveVoiceConfig(),
          realtime: gaiaLiveVoiceConfig(),
          tts: {
            configured: hasAnyBackendTtsProvider(),
            providerOrder: publicTtsOrder(),
            openaiModel: OPENAI_TTS_MODEL,
            openaiVoice: OPENAI_TTS_VOICE,
            elevenLabsConfigured: Boolean(process.env.ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
            elevenLabsVoice: ELEVENLABS_VOICE_NAME,
            elevenLabsVoiceId: ELEVENLABS_VOICE_ID || '',
            elevenLabsModel: ELEVENLABS_MODEL,
          },
        },
      },
    },
  };
}

async function authSession(req, res, origin, url) {
  const session = cookieForRequest(req);
  const memberResolved = Boolean(session?.member?.email || session?.member?.memberId || session?.member?.contactId);
  sendJson(res, 200, {
    ok: true,
    ...sessionPublicShape(session),
    memberResolved,
    methods: {
      embeddedClaim: true,
      magicLinkRequest: true,
      externalPortal: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_MEMBER_HUB.portal.url,
    },
    hintedMember: memberContextFromRequest(req, url),
  }, origin);
}

async function authLogout(_req, res, origin) {
  sendJson(res, 200, { ok: true, authenticated: false }, origin, {
    'Set-Cookie': buildClearCookie(),
  });
}

async function authMagicLinkRequest(req, res, origin) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const returnTo = safeReturnUrl(body.returnTo || APP_PUBLIC_URL);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    sendJson(res, 400, { ok: false, error: 'Valid email required.' }, origin);
    return;
  }

  const requestIp = firstNonEmptyString(req.headers['cf-connecting-ip'], String(req.headers['x-forwarded-for'] || '').split(',')[0], req.socket?.remoteAddress, 'unknown');
  const rateKey = crypto.createHash('sha256').update(`${requestIp}|${email}`).digest('hex');
  const cutoff = Date.now() - (15 * 60 * 1000);
  const attempts = (MAGIC_LINK_REQUESTS.get(rateKey) || []).filter((time) => time > cutoff);
  if (attempts.length >= 5) {
    sendJson(res, 429, { ok: false, error: 'Too many sign-in requests. Please wait 15 minutes and try again.', code: 'rate_limited' }, origin, { 'Retry-After': '900' });
    return;
  }
  attempts.push(Date.now());
  MAGIC_LINK_REQUESTS.set(rateKey, attempts);
  if (MAGIC_LINK_REQUESTS.size > 10000) {
    for (const [key, times] of MAGIC_LINK_REQUESTS) {
      if (!times.some((time) => time > cutoff)) MAGIC_LINK_REQUESTS.delete(key);
    }
  }

  // Always mint a pollId (member or not) so the response cannot be used to
  // enumerate members: a non-member's poll simply never verifies.
  const pollId = crypto.randomBytes(24).toString('base64url');
  cleanupMagicPolls(Date.now());
  MAGIC_LINK_POLLS.set(pollId, { verified: false, member: null, exp: Date.now() + MAGIC_LINK_POLL_TTL_MS });
  const genericResponse = {
    ok: true,
    delivery: 'email-if-member',
    message: 'If this email belongs to a Gaia Healers member, a secure sign-in link will arrive shortly.',
    expiresInSeconds: AUTH_MAGIC_LINK_TTL_SECONDS,
    pollId,
  };

  // Every sign-in attempt is recorded. The response is deliberately identical
  // whether or not the email belongs to a member, which is right for the
  // caller and useless for an operator — so the outcome goes to the log, where
  // the answer to "did the link actually go out?" has to live. Emails are
  // hashed: enough to correlate one person's repeated attempts, not enough to
  // read their address out of a log file.
  const trace = crypto.createHash('sha256').update(email).digest('hex').slice(0, 10);
  const logOutcome = (outcome, extra = {}) => {
    console.log('[Gaia Auth] magic-link', JSON.stringify({ trace, outcome, ...extra }));
  };

  const member = await resolveMemberRecord({
    email,
    memberId: body.memberId || body.contactId || '',
    contactId: body.contactId || body.memberId || '',
  });

  if (!member) {
    // Do not reveal whether an email exists in GHL.
    logOutcome('no_member_for_email');
    sendJson(res, 200, genericResponse, origin);
    return;
  }

  const token = signTokenPayload({
    type: 'magic-link',
    member,
    returnTo,
    pollId,
    iat: Date.now(),
    exp: Date.now() + (AUTH_MAGIC_LINK_TTL_SECONDS * 1000),
  });
  // Keep the bearer token in the app URL fragment. Fragments are not sent in
  // HTTP requests or referrer headers, and most email-security link scanners do
  // not execute the app JavaScript that exchanges it for the HttpOnly session.
  const consumeUrl = magicLinkAppUrl(token, returnTo);

  // Deliver the sign-in link by email through GHL (email stays in GHL).
  if (member.contactId) {
    const sent = await ghlSendEmail({
      contactId: member.contactId,
      subject: 'Your Gaia Healers sign-in link',
      html: magicLinkEmailHtml(member, consumeUrl),
    });
    if (sent.ok) {
      logOutcome('sent', { contactId: member.contactId, messageId: sent.messageId || null });
      sendJson(res, 200, genericResponse, origin);
      return;
    }
    if (!AUTH_ALLOW_DEBUG_LINKS) {
      logOutcome('delivery_failed', {
        contactId: member.contactId,
        reason: sent.reason || 'ghl_error',
        status: sent.status || null,
        detail: sent.detail || null,
      });
      sendJson(res, 200, genericResponse, origin);
      return;
    }
  }

  if (AUTH_ALLOW_DEBUG_LINKS) {
    sendJson(res, 200, {
      ok: true,
      delivery: 'debug-link',
      authUrl: consumeUrl,
      member: { email: member.email, displayName: member.displayName },
      expiresInSeconds: AUTH_MAGIC_LINK_TTL_SECONDS,
    }, origin);
    return;
  }

  // A member with no contact id cannot be emailed at all — worth naming
  // distinctly, because it is a data problem rather than a delivery one.
  logOutcome('no_contact_to_email', { contactId: member.contactId || null });
  sendJson(res, 200, genericResponse, origin);
}

// In-app Join. Records a brand-new person in GHL (contacts.upsert — dedupes by
// email, never a second contact) and emails their sign-in link immediately,
// using the contact id the upsert returns so it never waits on GHL's search
// index. This is the fast path behind the app's own Join form; the full
// onboarding survey at join.gaiahealers.com stays available for anyone who
// wants it.
async function authJoin(req, res, origin) {
  const body = await readJsonBody(req).catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim().slice(0, 40);
  const returnTo = safeReturnUrl(body.returnTo || APP_PUBLIC_URL);
  if (!name) { sendJson(res, 400, { ok: false, reason: 'name_required', error: 'Please enter your name.' }, origin); return; }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { sendJson(res, 400, { ok: false, reason: 'email_invalid', error: 'Please enter a valid email.' }, origin); return; }

  // Joining writes to GHL and sends an email, so bound it per ip+email exactly
  // like the sign-in request (shares the same store, distinct key prefix).
  const requestIp = firstNonEmptyString(req.headers['cf-connecting-ip'], String(req.headers['x-forwarded-for'] || '').split(',')[0], req.socket?.remoteAddress, 'unknown');
  const rateKey = crypto.createHash('sha256').update(`join|${requestIp}|${email}`).digest('hex');
  const cutoff = Date.now() - (15 * 60 * 1000);
  const attempts = (MAGIC_LINK_REQUESTS.get(rateKey) || []).filter((t) => t > cutoff);
  if (attempts.length >= 5) { sendJson(res, 429, { ok: false, code: 'rate_limited', error: 'Too many attempts. Please wait a few minutes and try again.' }, origin, { 'Retry-After': '900' }); return; }
  attempts.push(Date.now());
  MAGIC_LINK_REQUESTS.set(rateKey, attempts);

  const trace = crypto.createHash('sha256').update(email).digest('hex').slice(0, 10);
  const parts = name.split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ');

  // 1) Record in GHL.
  const up = await ghlUpsertContact({
    firstName, lastName, email,
    ...(phone ? { phone } : {}),
    tags: ['gaia-app', 'gaia-join-free'],
    source: 'Gaia Healers app - Join free',
  });
  if (!up.ok || !up.contactId) {
    // GHL not writable (scope/network). Never strand the person — hand back the
    // onboarding funnel and say so honestly.
    console.log('[Gaia Auth] join', JSON.stringify({ trace, outcome: 'ghl_upsert_failed', reason: up.reason || 'unknown' }));
    sendJson(res, 200, { ok: false, reason: up.reason || 'ghl_error', delivery: 'funnel', joinUrl: 'https://join.gaiahealers.com/onboarding', message: 'We could not finish sign-up here just now — opening the full onboarding.' }, origin);
    return;
  }

  // 2) Email the sign-in link now, straight to the contact we just created.
  const member = normalizeMemberIdentity({ contactId: up.contactId, memberId: up.contactId, email, displayName: name, role: 'Member', source: 'ghl-join' });
  const token = signTokenPayload({ type: 'magic-link', member, returnTo, iat: Date.now(), exp: Date.now() + (AUTH_MAGIC_LINK_TTL_SECONDS * 1000) });
  const consumeUrl = magicLinkAppUrl(token, returnTo);
  const sent = await ghlSendEmail({ contactId: up.contactId, subject: 'Your Gaia Healers sign-in link', html: magicLinkEmailHtml(member, consumeUrl) });

  if (sent.ok) {
    console.log('[Gaia Auth] join', JSON.stringify({ trace, outcome: 'joined_and_emailed', contactId: up.contactId }));
    sendJson(res, 200, { ok: true, joined: true, delivery: 'email', email, message: 'You are in — we have emailed your sign-in link. Tap it to open Gaia Healers.', expiresInSeconds: AUTH_MAGIC_LINK_TTL_SECONDS }, origin);
    return;
  }
  if (AUTH_ALLOW_DEBUG_LINKS) {
    sendJson(res, 200, { ok: true, joined: true, delivery: 'debug-link', authUrl: consumeUrl, email }, origin);
    return;
  }
  // Contact exists but the email did not send — point them at Sign in rather
  // than claiming a link went out.
  console.log('[Gaia Auth] join', JSON.stringify({ trace, outcome: 'joined_email_failed', contactId: up.contactId, reason: sent.reason || 'send_failed' }));
  sendJson(res, 200, { ok: true, joined: true, delivery: 'created_no_email', email, message: 'Your account is ready. Tap Sign in and request your one-tap link with this email.' }, origin);
}

async function authMagicLinkPoll(req, res, origin, url) {
  const pollId = String(url.searchParams.get('pollId') || '').trim();
  cleanupMagicPolls(Date.now());
  const pending = pollId ? MAGIC_LINK_POLLS.get(pollId) : null;
  if (!pending) { sendJson(res, 200, { ok: true, authenticated: false, status: 'unknown' }, origin); return; }
  if (!pending.verified || !pending.member) { sendJson(res, 200, { ok: true, authenticated: false, status: 'pending' }, origin); return; }
  // The link was opened (email proven). Mint the session on THIS request so the
  // HttpOnly cookie lands in the caller's context (the installed PWA), not the
  // browser tab the email link happened to open. Single-use.
  MAGIC_LINK_POLLS.delete(pollId);
  const session = createMemberSession(pending.member, 'magic-link', { emailVerified: true });
  const token = signTokenPayload(session);
  sendJson(res, 200, {
    ok: true, authenticated: true, memberResolved: true,
    member: session.member, expiresAt: session.exp,
  }, origin, { 'Set-Cookie': buildSetCookie(req, token, session.exp) });
}

async function authMagicLinkConsume(req, res, origin, url) {
  const jsonMode = req.method === 'POST';
  let rawToken = url.searchParams.get('token') || '';
  if (jsonMode) {
    const body = await readJsonBody(req);
    rawToken = String(body.token || '').trim();
  }
  const payload = readSignedToken(rawToken);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = Date.now();
  for (const [hash, expiresAt] of CONSUMED_MAGIC_LINKS) {
    if (expiresAt <= now) CONSUMED_MAGIC_LINKS.delete(hash);
  }
  if (payload?.type !== 'magic-link' || !payload?.member || CONSUMED_MAGIC_LINKS.has(tokenHash)) {
    if (jsonMode) {
      sendJson(res, 401, { ok: false, authenticated: false, error: 'This sign-in link is invalid, expired, or already used.' }, origin);
    } else {
      const invalidReturn = new URL(safeReturnUrl(url.searchParams.get('returnTo')));
      invalidReturn.searchParams.set('auth', 'invalid');
      sendRedirect(res, invalidReturn.toString(), origin);
    }
    return;
  }
  CONSUMED_MAGIC_LINKS.set(tokenHash, Number(payload.exp) || (now + AUTH_MAGIC_LINK_TTL_SECONDS * 1000));
  // Bridge to the polling PWA: this proves the email was opened, so any app
  // polling on this pollId may now mint its own session (in its own context).
  if (payload.pollId && MAGIC_LINK_POLLS.has(payload.pollId)) {
    const pending = MAGIC_LINK_POLLS.get(payload.pollId);
    pending.verified = true;
    pending.member = payload.member;
    pending.exp = Date.now() + MAGIC_LINK_POLL_TTL_MS;
  }
  // They opened a link delivered to that mailbox, which is exactly what
  // verifying an email means.
  const session = createMemberSession(payload.member, 'magic-link', { emailVerified: true });
  const token = signTokenPayload(session);
  const sessionCookie = { 'Set-Cookie': buildSetCookie(req, token, session.exp) };
  if (jsonMode) {
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      memberResolved: true,
      member: session.member,
      expiresAt: session.exp,
      returnTo: safeReturnUrl(payload.returnTo),
    }, origin, sessionCookie);
  } else {
    sendRedirect(res, safeReturnUrl(payload.returnTo || url.searchParams.get('returnTo')), origin, sessionCookie);
  }
}

// ── OAuth / OIDC: Sign in with Google and Sign in with Apple ─────────────────
// Each provider proves an email address; identity here is GHL-contact based, so
// a verified non-member (or an Apple hidden-relay address that cannot match a
// contact) is routed to the join funnel rather than signed in. Providers are
// credential-gated: a button/flow exists only when its env config is complete.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_JWKS_CACHE = new Map(); // url -> { jwks, fetchedAt }
const JOIN_ONBOARDING_URL = (process.env.JOIN_ONBOARDING_URL
  || 'https://join.gaiahealers.com/onboarding').trim();

function logOAuth(provider, outcome, extra = '') {
  try { console.log('[Gaia OAuth]', JSON.stringify({ provider, outcome, extra })); } catch (_) {}
}

function oauthRedirectUri(provider) {
  return `${PROXY_PUBLIC_URL}/api/auth/oauth/${provider}/callback`;
}

function appAuthReturn(status) {
  try {
    const u = new URL(APP_PUBLIC_URL);
    u.searchParams.set('auth', status);
    return u.toString();
  } catch (_) { return APP_PUBLIC_URL; }
}

// State is a signed, self-expiring token — no server-side store. It also carries
// the nonce the id_token must echo, tying the callback to this exact start.
function makeOAuthState(provider, returnTo, nonce) {
  return signTokenPayload({
    type: 'oauth-state', provider, returnTo, nonce,
    iat: Date.now(), exp: Date.now() + OAUTH_STATE_TTL_MS,
  });
}
function readOAuthState(state, provider) {
  const payload = readSignedToken(state);
  if (!payload || payload.type !== 'oauth-state' || payload.provider !== provider) return null;
  if (!payload.exp || Date.now() > Number(payload.exp)) return null;
  return payload;
}

async function fetchJwks(url) {
  const cached = OAUTH_JWKS_CACHE.get(url);
  if (cached && (Date.now() - cached.fetchedAt) < 60 * 60 * 1000) return cached.jwks;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`jwks_fetch_${r.status}`);
  const jwks = await r.json();
  OAUTH_JWKS_CACHE.set(url, { jwks, fetchedAt: Date.now() });
  return jwks;
}

// Master switch for OAuth sign-in. The Apple/Google implementation stays fully
// built and tested but invisible until this is explicitly turned on: with it
// off, /providers reports nothing (so the sign-in sheet shows Magic Link only)
// and the start/callback routes refuse. Set AUTH_OAUTH_ENABLED=true (with the
// provider credentials in place) to re-enable social sign-in later.
function oauthMasterEnabled() {
  return String(process.env.AUTH_OAUTH_ENABLED || '').trim().toLowerCase() === 'true';
}

function authProviders(req, res, origin) {
  const cfg = oauthProviderConfig();
  const on = oauthMasterEnabled();
  sendJson(res, 200, { google: on && cfg.google.enabled, apple: on && cfg.apple.enabled }, origin);
}

function authOAuthStart(req, res, origin, url, provider) {
  const cfg = oauthProviderConfig();
  if (!oauthMasterEnabled() || !cfg[provider] || !cfg[provider].enabled) {
    sendRedirect(res, appAuthReturn('unavailable'), origin);
    return;
  }
  const returnTo = safeReturnUrl(url.searchParams.get('returnTo'));
  const nonce = crypto.randomBytes(16).toString('base64url');
  const state = makeOAuthState(provider, returnTo, nonce);
  const redirectUri = oauthRedirectUri(provider);
  const authUrl = provider === 'google'
    ? googleAuthUrl({ clientId: cfg.google.clientId, redirectUri, state, nonce })
    : appleAuthUrl({ servicesId: cfg.apple.servicesId, redirectUri, state, nonce });
  sendRedirect(res, authUrl, origin);
}

async function completeOAuth(req, res, origin, provider, code, statePayload) {
  const cfg = oauthProviderConfig();
  if (!oauthMasterEnabled() || !cfg[provider] || !cfg[provider].enabled) { sendRedirect(res, appAuthReturn('unavailable'), origin); return; }
  const redirectUri = oauthRedirectUri(provider);

  // ── token exchange ──
  const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (provider === 'google') {
    params.set('client_id', cfg.google.clientId);
    params.set('client_secret', cfg.google.clientSecret);
  } else {
    params.set('client_id', cfg.apple.servicesId);
    try {
      params.set('client_secret', appleClientSecret(cfg.apple));
    } catch (e) { logOAuth(provider, 'client_secret_error', e.message); sendRedirect(res, appAuthReturn('error'), origin); return; }
  }
  let tokenJson;
  try {
    const r = await fetch(OAUTH_ENDPOINTS[provider].token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    });
    tokenJson = await r.json().catch(() => ({}));
    if (!r.ok || !tokenJson.id_token) throw new Error(tokenJson.error || `token_${r.status}`);
  } catch (e) { logOAuth(provider, 'token_exchange_error', e.message); sendRedirect(res, appAuthReturn('error'), origin); return; }

  // ── id_token verification ──
  let claims;
  try {
    const jwks = await fetchJwks(OAUTH_ENDPOINTS[provider].jwks);
    const aud = provider === 'google' ? cfg.google.clientId : cfg.apple.servicesId;
    claims = verifyIdToken(tokenJson.id_token, jwks, {
      aud, iss: OAUTH_ENDPOINTS[provider].issuers, now: Date.now(),
      nonce: statePayload.nonce || null,
    });
  } catch (e) { logOAuth(provider, 'verify_error', e.message); sendRedirect(res, appAuthReturn('error'), origin); return; }

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || !claimEmailVerified(claims)) { logOAuth(provider, 'email_unverified', email); sendRedirect(res, appAuthReturn('unverified'), origin); return; }
  if (provider === 'apple' && isAppleRelayEmail(email)) {
    // A hidden-relay address cannot match a GHL contact — send them to onboarding.
    logOAuth(provider, 'apple_relay_email');
    sendRedirect(res, JOIN_ONBOARDING_URL, origin);
    return;
  }

  const member = await resolveMemberRecord({ email });
  if (!member) { logOAuth(provider, 'no_member'); sendRedirect(res, JOIN_ONBOARDING_URL, origin); return; }

  const session = createMemberSession(member, `oauth-${provider}`, { emailVerified: true });
  const token = signTokenPayload(session);
  const cookie = { 'Set-Cookie': buildSetCookie(req, token, session.exp) };
  logOAuth(provider, 'signed_in');
  sendRedirect(res, safeReturnUrl(statePayload.returnTo), origin, cookie);
}

async function authOAuthGoogleCallback(req, res, origin, url) {
  const err = url.searchParams.get('error');
  if (err) { logOAuth('google', 'provider_error', err); sendRedirect(res, appAuthReturn('cancelled'), origin); return; }
  const code = url.searchParams.get('code') || '';
  const state = readOAuthState(url.searchParams.get('state') || '', 'google');
  if (!code || !state) { logOAuth('google', 'bad_state'); sendRedirect(res, appAuthReturn('error'), origin); return; }
  await completeOAuth(req, res, origin, 'google', code, state);
}

async function authOAuthAppleCallback(req, res, origin) {
  // Apple POSTs the result as an x-www-form-urlencoded body (response_mode=form_post).
  let form;
  try { form = new URLSearchParams(await readRawBody(req, 256 * 1024)); }
  catch (_) { sendRedirect(res, appAuthReturn('error'), origin); return; }
  const err = form.get('error');
  if (err) { logOAuth('apple', 'provider_error', err); sendRedirect(res, appAuthReturn('cancelled'), origin); return; }
  const code = form.get('code') || '';
  const state = readOAuthState(form.get('state') || '', 'apple');
  if (!code || !state) { logOAuth('apple', 'bad_state'); sendRedirect(res, appAuthReturn('error'), origin); return; }
  await completeOAuth(req, res, origin, 'apple', code, state);
}

async function authEmbeddedClaim(req, res, origin) {
  if (!AUTH_ALLOW_LEGACY_EMBEDDED_CLAIM) {
    sendJson(res, 410, {
      ok: false,
      error: 'Embedded auto-claim is disabled. Use magic-link or OAuth sign-in.',
    }, origin);
    return;
  }
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const contactId = String(body.contactId || body.memberId || '').trim();
  const referrer = String(body.referrer || '').trim();
  const locationId = String(body.locationId || '').trim();
  if (!email && !contactId) {
    sendJson(res, 400, { ok: false, error: 'Email or contactId required for embedded claim.' }, origin);
    return;
  }
  const sharedSecret = String(body.sharedSecret || body.bridge || '').trim();
  const secretOk = Boolean(AUTH_EMBED_SHARED_SECRET) && safeSecretEqual(sharedSecret, AUTH_EMBED_SHARED_SECRET);
  if (AUTH_EMBED_SHARED_SECRET && !secretOk) {
    sendJson(res, 403, { ok: false, error: 'Embedded bridge secret mismatch.' }, origin);
    return;
  }
  // A valid shared secret is sufficient authorization on its own — this lets the
  // auto-login link work when clicked from a GHL email/SMS/workflow, where the
  // referrer is the mail client, not a GHL page. Only fall back to requiring a
  // trusted referrer when no shared secret is configured.
  if (!secretOk && !trustedReferrer(referrer)) {
    sendJson(res, 403, { ok: false, error: 'Embedded claim rejected: untrusted referrer.' }, origin);
    return;
  }
  const cfg = ghlConfig();
  if (cfg.locationId && locationId && locationId !== cfg.locationId) {
    sendJson(res, 403, { ok: false, error: 'Embedded claim rejected: location mismatch.' }, origin);
    return;
  }
  if (!cfg.locationId && locationId && !AUTH_ALLOWED_LOCATION_IDS.has(locationId)) {
    sendJson(res, 403, { ok: false, error: 'Embedded claim rejected: unknown location.' }, origin);
    return;
  }

  let member = null;
  const verified = await getMemberFromGhl({
    email,
    memberId: contactId,
    contactId,
  });
  if (verified.memberResolved && verified.member) {
    member = normalizeMemberIdentity({
      ...verified.member,
      locationId: cfg.locationId || locationId || verified.member.locationId,
      source: 'ghl-embedded-claim',
    });
  } else if (AUTH_ALLOW_UNVERIFIED_EMAIL_MAGIC_LINK && email) {
    member = normalizeMemberIdentity({
      email,
      memberId: contactId,
      contactId,
      displayName: body.displayName || body.name || '',
      role: body.role || body.userRole || 'Member',
      cohort: body.cohort || body.group || '',
      locationId: cfg.locationId || locationId,
      source: 'ghl-embedded-claim-unverified',
    });
  } else {
    sendJson(res, 403, {
      ok: false,
      error: 'Embedded claim rejected: member could not be verified by GHL.',
    }, origin);
    return;
  }

  // Verified only when GHL itself resolved the contact. The fallback branch
  // above accepts an email nobody checked, and that must not be treated as
  // proof — the contact id remains the usable evidence in that case.
  const session = createMemberSession(member, 'ghl-embedded-claim', {
    emailVerified: Boolean(verified.memberResolved && verified.member),
  });
  const token = signTokenPayload(session);
  sendJson(res, 200, {
    ok: true,
    authenticated: true,
    memberResolved: true,
    member: session.member,
    source: session.source,
  }, origin, {
    'Set-Cookie': buildSetCookie(req, token, session.exp),
  });
}

function fallbackAssistReply(prompt, intent = '') {
  const normalized = `${intent} ${prompt}`.toLowerCase();
  if (normalized.includes('sky-to-chakra') || normalized.includes('symbolic spotlight') || normalized.includes('7-day gaia energy path')) {
    const spotlight = (normalized.match(/spotlight (?:is )?(root|sacral|solar plexus|heart|throat|third eye|crown)/) || [])[1] || 'chakra';
    const represented = (normalized.match(/represented element is (air|earth|fire|water)|most represented element is (air|earth|fire|water)/) || []).slice(1).find(Boolean) || 'your strongest element';
    const invite = (normalized.match(/invite (?:is )?(air|earth|fire|water)|gently invite is (air|earth|fire|water)/) || []).slice(1).find(Boolean) || 'a balancing quality';
    const practices = {
      root: 'feel both feet and lengthen your exhale',
      sacral: 'place a hand over your lower belly and move gently',
      'solar plexus': 'sit tall, breathe steadily, and choose one small action',
      heart: 'rest a hand on your chest and offer yourself one kind sentence',
      throat: 'hum softly, then write one honest sentence',
      'third eye': 'soften your gaze and notice the first calm observation',
      crown: 'sit in stillness and name three points of gratitude',
      chakra: 'take five slow breaths and notice what shifts',
    };
    const invitations = {
      air: 'give the feeling language in one spoken or written sentence',
      earth: 'add a physical anchor such as your feet, a warm cup, or one practical task',
      fire: 'add gentle momentum with a short walk, one song, or one clear next action',
      water: 'add softness through slow hydration, free movement, or allowing one feeling without fixing it',
      'a balancing quality': 'choose one gentle quality that feels absent from the moment',
    };
    const colour = { root: 'Red', sacral: 'Orange', 'solar plexus': 'Yellow', heart: 'Green', throat: 'Blue', 'third eye': 'Indigo', crown: 'Violet' }[spotlight] || 'matching';
    return `Use this as reflection, not a measured energy result: your ${spotlight} spotlight and ${represented} emphasis suggest starting with two minutes to ${practices[spotlight]}; to invite ${invite}, ${invitations[invite] || invitations['a balancing quality']}. Repeat that once daily for seven days and journal: “What changed when I made room for this quality?” Optional next steps are ${colour} Colour Energy in Store, a Bio-Well scan or demo in Bookings if you want device-based measurement, time with Dr. Nima for guidance, the free Community for support, or Elevate for live learning and technology experiences. None of those is required, and this pathway does not diagnose or predict.`;
  }
  if (normalized.includes('difference') && (normalized.includes('bio-well') || normalized.includes('biowell')) && normalized.includes('biopulsar') && normalized.includes('biotekna')) {
    return 'Bio-Well uses electrophotonic imaging for biofield and stress-oriented assessment; BioPulsar shows live aura, chakra and organ-zone biofeedback; BioTekna focuses on nervous-system, stress, recovery and physiology-related measurements. Open the Store for current device details or ask which goal you have.';
  }
  if ((normalized.includes('bio-well') || normalized.includes('biowell')) && normalized.includes('research')) {
    return 'Bio-Well is Gaia Healers’ electrophotonic biofield-imaging system. Gaia Healers maintains a public Bio-Well research library at gaiahealers.com/pages/bio-well-research; use research as background information, not personal medical diagnosis.';
  }
  if (normalized.includes('join free') || normalized.includes('free member') || normalized.includes('free membership')) {
    return 'Open the Store’s Membership tab and choose Free, or use Join free on Today. Enrol with the same email you will use for your Gaia Healers Member Pass so GHL can connect your access.';
  }
  if (normalized.includes('crm') || normalized.includes('software') || normalized.includes('marketplace') || normalized.includes('affiliate') || normalized.includes('contact support') || normalized.includes('certification request')) {
    return 'Gaia Healers’ verified public tools include practitioner CRM at nextlevel.gaiahealers.com, software and marketplace through GaiaPractitioners, affiliate registration, certification requests, and the contact page. Tell me which one and I’ll point you to the exact source.';
  }
  if (normalized.includes('book') || normalized.includes('scan') || normalized.includes('appointment') || normalized.includes('session') || normalized.includes('demo')) {
    return 'You can book a session from the Home screen — there are options for a Bio-Well energy scan, a Bio-Well demo, a free discovery call, and wellness coaching. Want me to point you to the right one?';
  }
  if (normalized.includes('horoscope') || normalized.includes('sun sign')) {
    return 'Open Energy and choose Horoscope. Type at least three letters of your birth city and select it from the worldwide suggestions so Gaia can resolve the correct time zone. Add birth time if you know it; otherwise Gaia uses local noon and labels the map as an estimate. The seven planet placements are astronomical calculations, while the chakra spotlight, element reflection, practice, and journal question are symbolic wellness guidance—not prediction or medical advice.';
  }
  if (normalized.includes('birth map') || normalized.includes('birth date') || normalized.includes('birthday') || normalized.includes('year')) {
    return 'In Energy Check, choose your birth month and type the day and 4-digit year—there is no calendar to scroll through. Your Gaia birth map combines a birth-date-number chakra with a sun-sign reflection, then offers a gentle practice, journal prompt, and matching Gaia Healers support. It is reflective guidance, not a scan or prediction.';
  }
  if (normalized.includes('chakra match') || normalized.includes('seven centre') || normalized.includes('seven center')) {
    return 'Open Energy and choose Chakra match to explore all seven centres and the matching Colour Energy support. You can tap any centre without signing in.';
  }
  if (normalized.includes('chakra') || normalized.includes('wellness') || normalized.includes('energy') || normalized.includes('chart') || normalized.includes('colour') || normalized.includes('color')) {
    return 'Energy has three separate tools: Energy check for today’s body point and practice, Horoscope for reflective daily guidance, and Chakra match for the seven-centre guide. The five-question Colour Test now lives in Energy, alongside Numerology, Today\u2019s Sky and Bio-Well.';
  }
  if (normalized.includes('community') || normalized.includes('membership') || normalized.includes('healer') || normalized.includes('practitioner')) {
    return 'Community shows which Gaia Healers circles you have unlocked and links to the practitioner directory. The Store’s Membership tab shows the official Free, Silver, Gold, and Diamond Gaia 2.0 paths and opens enrolment inside the app. Want me to guide you there?';
  }
  if (normalized.includes('course') || normalized.includes('academy') || normalized.includes('certification') || normalized.includes('login') || normalized.includes('sign in') || normalized.includes('portal')) {
    return 'Academy has your courses — the lessons open in the education.gaiahealers.com portal, which has its own login. To sign in to the app, tap Sign in and use the one-tap link we email to your member address.';
  }
  if (normalized.includes('store') || normalized.includes('shop') || normalized.includes('buy') || normalized.includes('product') || normalized.includes('device') || normalized.includes('price')) {
    return 'The Store has a Shop tab (Bio-Well and devices, Colour Energy sprays, crystals, courses) where prices and checkout live on the Gaia Healers shop, plus a Membership tab. What are you looking for?';
  }
  if (normalized.includes('event') || normalized.includes('conference') || normalized.includes('gathering')) {
    // Describe whatever is published now, not a remembered event.
    const current = _lastPublishedEvent;
    if (current && current.name) {
      const when = current.date ? ` is ${current.date}` : '';
      const where = current.venue ? ` at ${current.venue}` : '';
      return `${current.name}${when}${where}. You can see it on the Events screen and register from there.`;
    }
    return 'No event is published right now. When one is, it appears on the Events screen with its agenda, speakers and exhibitors.';
  }
  if (normalized.includes('research') || normalized.includes('blog') || normalized.includes('article') || normalized.includes('contact')) {
    return 'I can open the verified Gaia Healers source for Bio-Well research, articles, affiliate access, practitioner CRM/software/marketplace, certification requests, or contact support. Tell me which one you need.';
  }
  return 'I can help across the full Gaia Healers ecosystem: Energy, Academy, Community, events, bookings, membership, live products, practitioners, research, articles, demos, certification, practitioner tools, contact, or Dr. Nima. What would you like to explore?';
}

function assistSystemPrompt(memberContext = '') {
  return [
    'You are Gaia Assist, the smart concierge for the Gaia Healers mobile app. You guide first-time visitors and signed-in members from arrival through their next useful step.',
    memberContext
      ? 'This is a signed-in member. Personalize only from the supplied member context. Treat active GHL subscriptions/offers as primary tier evidence and tags as secondary. Show courses and communities only from exact GHL entitlements; never infer them from tier.'
      : 'This is a visitor unless they say otherwise. Help them explore, join free, compare memberships, sign in with their GHL-contact email, find a practitioner, or book a session. Never imply they already own access.',
    'Answer with deep, accurate awareness of the Gaia Healers app screens and features, the products and devices, the communities and membership, the courses, the events, and the store.',
    'The app can run embedded inside the Gaia Healers GHL menu. Keep users inside the app first: Today for the daily dashboard and free tools, Energy for the wellness tools (energy check, horoscope, chakras, numerology, colour test, Bio-Well), Academy for courses and certifications, Community for circles, Find a Healer, events, Gaia Radio and booking, Shop for live products and plans, and You for the GHL-linked Member Pass, access and bookings. Course videos and community discussions open the authorized education.gaiahealers.com portal.',
    'When asked how to do something, name the exact screen and step. Never invent course progress, scan numbers, community posts, prices, or personal history.',
    'MEMBERSHIP GUIDANCE \u2014 help people join and activate. Gaia Healers 2.0 has four practitioner paths: Free ($0), Silver ($97/mo or $997/yr), Gold ($497/mo or $4,997/yr), and Diamond ($997/mo or $9,997/yr), with benefits growing from community and education through directory exposure, CRM/software, implementation support, and lead generation. When someone wants to grow, go deeper, get certified, be listed as a practitioner, or asks what to join, warmly explain the paths, ask one short question about their stage and goal, recommend the single best-fit tier, and hand them its exact activation link so they can activate right away: Free join.gaiahealers.com/onboarding, Silver join.gaiahealers.com/silver, Gold join.gaiahealers.com/gold, Diamond join.gaiahealers.com/diamond (or say "Open the Store and tap Membership"). Guide, never pressure; frame it as the step that matches their goal. Their in-app access mirrors what GHL grants once they activate.',
    'Never claim that you saved, imported, checked in, emailed, booked, purchased, or changed data. Explain how the member can do it.',
    'ANSWER ANYTHING — you can answer about the whole Gaia Healers world (app, the gaiahealers.com store + prices, the practitioner directory, courses, events, devices, membership, Dr. Nima). When LIVE GAIA HEALERS DATA is provided for the question, answer using ONLY those real facts and never invent a price, count, product, or name. For general questions use your knowledge; if you do not know, say so and point them to the exact page.',
    'MEMORY — you remember members across visits. Use WHAT YOU REMEMBER (if present) to continue naturally; do not re-ask or repeat declined offers. When you learn something durable (interest, goal, decision, objection, follow-up), append a line <<REMEMBER: fact one ;; fact two>> which the app saves and hides. Never save trivia or sensitive details.',
    'GUIDE FULLY — you are their in-app guide and know every screen and flow. For any "how do I…" give the exact steps from the app task guide and offer to open the right screen for them; walk multi-step tasks one step at a time and say what to tap next.',
    'RAPPORT FIRST — answer the actual question before offering anything; do not pitch in the first sentence unless asked. One question at a time; confirm understanding.',
    'HANDLE HESITATION — address the specific concern (price -> Free is $0 and annual saves; value -> tie to their goals; timing -> start free, upgrade anytime); never pressure or repeat a declined offer. PERSONALIZE from what you know; after the survey give a short recap + best next step; if a TOP NUDGE is present, lead with it.',
    'EVENTS — if an event is currently published (in your knowledge above), proactively mention it and encourage the member to register; offer to open the events screen. If none is published, say the calendar is clear rather than inventing one.',
    'GATEKEEPER: read the member context. No context = VISITOR: show value and lead them to JOIN or sign in. Has context = MEMBER: if ONBOARDING PROFILE is NOT DONE, at a natural moment offer the quick getting-to-know-you and run the ONBOARDING SURVEY; if DONE, skip it and give tailored suggestions from their interests and TARGETED RECOMMENDATIONS. If that member is a FREE (non-paying) member, prioritize warmly encouraging a paid membership (Silver/Gold/Diamond), tying benefits to their profile, with the activation link; never pressure.',
    'SURVEY SAVE MECHANISM (text): after a member answers a step, append on its OWN LINE at the very end of your message exactly: <<ONBOARD step=STEPKEY | SELECTIONS: label one ;; label two | complete=false>> (use complete=true on the final step). The app records it and REMOVES that line, so the member never sees it. Put nothing after the marker.',
    onboarding.onboardingPromptBlock(),
        'Keep responses concise, practical, warm, proactive, and wellness-safe. End with one useful next step or a short question, and continue helping until they are finished. Do not provide medical diagnosis.',
    gaiaKnowledgePrompt(),
    String(memberContext || '').trim(),
  ].filter(Boolean).join(' ');
}

function assistUserPrompt(prompt, context = {}) {
  const source = String(context.source || '').toLowerCase();
  const voiceInstruction = source.includes('voice')
    ? 'Voice mode: answer immediately in 35-55 spoken words. Start with the direct answer. No long preamble.'
    : 'Screen mode: keep the answer concise but include useful details.';
  return [
    `Prompt: ${prompt}`,
    `Intent: ${context.intent || 'general'}`,
    `Page: ${context.page || 'unknown'}`,
    `Source: ${context.source || 'unknown'}`,
    voiceInstruction,
  ].join('\n');
}

function chatOutputText(payload) {
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

function providerConfig(provider) {
  const configs = {
    groq: {
      key: process.env.GROQ_API_KEY,
      model: GROQ_MODEL,
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      headers: {},
    },
    openrouter: {
      key: process.env.OPENROUTER_API_KEY,
      model: OPENROUTER_MODEL,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'HTTP-Referer': process.env.APP_PUBLIC_URL || 'https://gaiagitshare.github.io/gaia-healers-mobile-app/',
        'X-Title': 'Gaia Healers Mobile App',
      },
    },
    openai: {
      key: process.env.OPENAI_API_KEY,
      model: OPENAI_MODEL,
      endpoint: 'https://api.openai.com/v1/chat/completions',
      headers: {},
    },
  };
  return configs[provider];
}

// Lean text completion for internal features (e.g. daily wellness tips).
// Tries the configured providers in order; returns '' if none are available.
async function aiComplete(system, user, { maxTokens = 160, temperature = 0.6 } = {}) {
  for (const provider of ASSIST_PROVIDER_ORDER) {
    const config = providerConfig(provider);
    if (!config || !config.key) continue;
    try {
      const r = await fetch(config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', ...config.headers },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature,
          max_tokens: maxTokens,
        }),
      });
      if (!r.ok) continue;
      const text = chatOutputText(await r.json());
      if (text) return text;
    } catch (_) { /* try next provider */ }
  }
  return '';
}

async function callGeminiChat(prompt, context = {}) {
  const key = geminiApiKey();
  if (!key) return { skipped: true, reason: 'missing-api-key' };
  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
  const isVoice = String(context.source || '').includes('voice');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: assistSystemPrompt(context.memberContext) }] },
      contents: [{ role: 'user', parts: [{ text: assistUserPrompt(prompt, context) }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: isVoice ? 220 : 640 },
    }),
  });
  if (!res.ok) { const d = await res.text(); throw new Error(`gemini chat request failed with ${res.status}: ${d.slice(0, 280)}`); }
  const j = await res.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  return { provider: 'gemini', model, reply: text || fallbackAssistReply(prompt, context.intent) };
}
async function callChatProvider(provider, prompt, context = {}) {
  if (provider === 'gemini') return callGeminiChat(prompt, context);
  const config = providerConfig(provider);
  if (!config) {
    return { skipped: true, reason: 'unknown-provider' };
  }
  if (!config.key) {
    return { skipped: true, reason: 'missing-api-key' };
  }

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...config.headers,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: assistSystemPrompt(context.memberContext) },
        { role: 'user', content: assistUserPrompt(prompt, context) },
      ],
      temperature: 0.35,
      max_tokens: String(context.source || '').includes('voice') ? 150 : 520,
      presence_penalty: 0.1,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`${provider} chat request failed with ${response.status}: ${details.slice(0, 280)}`);
  }

  const payload = await response.json();
  return {
    provider,
    model: config.model,
    reply: chatOutputText(payload) || fallbackAssistReply(prompt, context.intent),
  };
}

async function streamChatProvider(provider, prompt, context = {}, onDelta = () => {}) {
  const config = providerConfig(provider);
  if (!config) {
    return { skipped: true, reason: 'unknown-provider' };
  }
  if (!config.key) {
    return { skipped: true, reason: 'missing-api-key' };
  }

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...config.headers,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: assistSystemPrompt(context.memberContext) },
        { role: 'user', content: assistUserPrompt(prompt, context) },
      ],
      temperature: 0.35,
      max_tokens: String(context.source || '').includes('voice') ? 150 : 520,
      presence_penalty: 0.1,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const details = await response.text();
    throw new Error(`${provider} stream request failed with ${response.status}: ${details.slice(0, 280)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data);
        const delta = payload.choices?.[0]?.delta?.content || '';
        if (delta) {
          reply += delta;
          onDelta(delta);
        }
      } catch {
        // Ignore malformed provider keepalive chunks.
      }
    }
  }

  return {
    provider,
    model: config.model,
    reply: reply.trim() || fallbackAssistReply(prompt, context.intent),
  };
}

async function callAssistProviders(prompt, context = {}) {
  const attempts = [];
  if (process.env.GAIA_ASSIST_VOICE_ENABLED !== 'true') {
    return {
      provider: 'local-fallback',
      reply: fallbackAssistReply(prompt, context.intent),
      attempts: [{ provider: 'assist', status: 'disabled' }],
    };
  }

  for (const provider of ASSIST_PROVIDER_ORDER) {
    const started = Date.now();
    try {
      console.log('[Gaia Assist] provider attempt', { provider });
      const result = await callChatProvider(provider, prompt, context);
      if (result.skipped) {
        attempts.push({ provider, status: 'skipped', reason: result.reason });
        console.log('[Gaia Assist] provider skipped', { provider, reason: result.reason });
        continue;
      }
      attempts.push({ provider, status: 'ok', latencyMs: Date.now() - started, model: result.model });
      return { ...result, attempts };
    } catch (error) {
      attempts.push({
        provider,
        status: 'failed',
        latencyMs: Date.now() - started,
        error: error.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]'),
      });
      console.error('[Gaia Assist] provider failed', { provider, error: error.message.split('\n')[0] });
    }
  }

  return {
    provider: 'local-fallback',
    reply: fallbackAssistReply(prompt, context.intent),
    warning: 'All configured assistant providers failed; showing safe local fallback.',
    attempts,
  };
}

const ONBOARD_MARKER_RE = /<<\s*ONBOARD\s+step\s*=\s*([a-z_]+)\s*\|\s*SELECTIONS\s*:\s*([^|]*)\|\s*complete\s*=\s*(true|false)\s*>>/gi;
async function executeOnboardingMarkers(req, text) {
  const out = { clean: String(text || ''), ran: 0 };
  if (!out.clean || out.clean.indexOf('ONBOARD') < 0) return out;
  let sm = null;
  try { sm = sessionMemberContext(req); } catch (e) {}
  const markers = [];
  out.clean = out.clean.replace(ONBOARD_MARKER_RE, function (_m, step, sel, complete) {
    markers.push({ step: String(step).trim(), selections: String(sel).split(';;').map((x) => x.trim()).filter(Boolean), complete: /true/i.test(complete) });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  var remFacts = [];
  out.clean = out.clean.replace(/<<\s*REMEMBER\s*:\s*([^>]*)>>/gi, function (_m, body) { String(body).split(';;').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (f) { remFacts.push(f); }); return ''; }).replace(/\n{3,}/g, '\n\n').trim();
  if (!markers.length && !remFacts.length) return out;
  if (!sm) return out;
  if (remFacts.length) { try { var bb = await fetchMemberBundle(sm); if (bb && bb.contactId) { rememberForContact(bb.contactId, remFacts, ''); out.ran += remFacts.length; } } catch (e) {} }
  if (!markers.length) return out;
  try {
    const b = await fetchMemberBundle(sm);
    if (b && b.contactId) {
      for (const mk of markers) { await applyOnboardingStep(b.contactId, mk.step, mk.selections, '', mk.complete); out.ran++; }
    }
  } catch (e) {}
  return out;
}
async function applyOnboardingStep(contactId, stepKey, selections, freeText, complete) {
  const r = onboarding.mapStep(stepKey, selections);
  const tags = r.tags.slice();
  if (complete) tags.push(onboarding.COMPLETE_TAG);
  if (tags.length) await ghlPost(`/contacts/${encodeURIComponent(contactId)}/tags`, { tags }).catch(() => null);
  if (freeText) { try { await ghlPost(`/contacts/${encodeURIComponent(contactId)}/notes`, { body: 'Gaia Assist onboarding (' + stepKey + '): ' + String(freeText).slice(0, 800) }); } catch (e) {} }
  return { tagsAdded: tags, matched: r.matched, unmatched: r.unmatched, complete: !!complete };
}
function priceFromCents(c) { if (c == null || isNaN(c)) return ''; const n = Number(c) / 100; return '$' + (Number.isInteger(n) ? n : n.toFixed(2)); }
async function gaiaLookup(query) {
  const q = String(query || '').toLowerCase();
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const score = (text) => { const t = String(text || '').toLowerCase(); let sc = 0; terms.forEach((w) => { if (t.indexOf(w) >= 0) sc++; }); return sc; };
  const out = { ok: true, query: String(query || '') };
  try {
    const cat = loadStoreCatalog(); const prods = (cat && cat.products) ? Object.values(cat.products) : [];
    out.storeTotal = prods.length;
    out.store = prods.filter((p) => p && !p.hidden && p.title)
      .map((p) => ({ p, s: score(p.title + ' ' + (p.productType || '') + ' ' + ((p.tags || []).join(' ')) + ' ' + String(p.description || '').slice(0, 200)) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6)
      .map((x) => ({ title: x.p.title, price: (x.p.priceVaries ? 'from ' : '') + priceFromCents(x.p.priceCents), available: x.p.available !== false, type: x.p.productType || '', url: x.p.url || '' }));
  } catch (e) { out.store = []; }
  try {
    const dir = await fetch('http://127.0.0.1:8787/api/directory').then((r) => r.json()).catch(() => null);
    const list = (dir && dir.practitioners) || [];
    out.practitionerTotal = list.length;
    out.practitioners = list.map((p) => ({ p, s: score(p.name + ' ' + (p.city || '') + ' ' + (p.state || '') + ' ' + (p.specialty || '') + ' ' + ((p.tags || []).join(' '))) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6)
      .map((x) => ({ name: x.p.name, location: [x.p.city, x.p.state].filter(Boolean).join(', '), specialty: x.p.specialty || '', link: x.p.profileLink || '' }));
  } catch (e) { out.practitioners = []; }
  try { const cs = (loadAcademyManifest().courses || []).map((c) => c.title); out.courseTotal = cs.length; out.courses = cs.filter((t) => score(t) > 0).slice(0, 8); } catch (e) { out.courses = []; }
  try { if (_lastPublishedEvent && _lastPublishedEvent.name) out.event = { name: _lastPublishedEvent.name, date: _lastPublishedEvent.date || '', venue: _lastPublishedEvent.venue || '' }; } catch (e) {}
  return out;
}
function formatLookup(r, query) {
  const parts = [];
  if (r.store && r.store.length) parts.push('Store products: ' + r.store.map((p) => p.title + (p.price ? ' — ' + p.price : '') + (p.available ? '' : ' (sold out)')).join(' | '));
  if (r.practitioners && r.practitioners.length) parts.push('Practitioners (' + r.practitionerTotal + ' total): ' + r.practitioners.map((p) => p.name + (p.location ? ' (' + p.location + ')' : '') + (p.specialty ? ' — ' + p.specialty : '')).join(' | '));
  else if (/practitioner|healer|how many|directory/i.test(String(query || '')) && r.practitionerTotal) parts.push('The directory has ' + r.practitionerTotal + ' practitioners.');
  if (r.courses && r.courses.length) parts.push('Courses: ' + r.courses.join(', '));
  if (r.event) parts.push('Current event: ' + r.event.name + (r.event.date ? ' — ' + r.event.date : ''));
  return parts.join('\n');
}
const LIVE_Q_RE = /\b(price|prices|cost|costs|how much|buy|purchase|order|shop|store|in stock|available|product|products|device|devices|bio-?well|biopulsar|biotekna|braintap|healy|asea|lifewave|spray|sprays|crystal|crystals|mala|malas|practitioner|practitioners|healer|healers|near me|how many|course|courses|class|classes|event|events|conference|elevate)\b/i;
async function assistLiveDataBlock(query) {
  if (!LIVE_Q_RE.test(String(query || ''))) return '';
  try { const r = await gaiaLookup(query); const body = formatLookup(r, query); return body ? ('LIVE GAIA HEALERS DATA for this question (use ONLY these real facts for prices/products/practitioners/courses/events; never invent others):\n' + body) : ''; } catch (e) { return ''; }
}
async function assistChat(body) {
  const prompt = String(body.prompt || body.transcript || '').trim();
  if (!prompt) {
    return { ok: false, error: 'Prompt is required' };
  }

  console.log('[Gaia Assist] request received', {
    intent: body.intent || 'general',
    source: body.source || 'unknown',
    hasPrompt: true,
  });

  try {
    const result = await callAssistProviders(prompt, {
      intent: body.intent,
      page: body.page,
      source: body.source || 'chat',
      memberContext: body.memberContext,
    });
    console.log('[Gaia Assist] proxy response ready', { provider: result.provider, model: result.model || 'none' });
    return {
      ok: true,
      reply: result.reply,
      provider: result.provider,
      model: result.model,
      attempts: result.attempts,
      warning: result.warning,
      transcript: body.transcript || prompt,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[Gaia Assist] provider chain error', error);
    return {
      ok: true,
      reply: fallbackAssistReply(prompt, body.intent),
      provider: 'local-fallback-after-error',
      warning: 'Assistant provider chain returned an error; showing safe local fallback.',
      transcript: body.transcript || prompt,
      generatedAt: new Date().toISOString(),
    };
  }
}

async function assistChatStream(body, res, origin) {
  const prompt = String(body.prompt || body.transcript || '').trim();
  if (!prompt) {
    sendJson(res, 400, { ok: false, error: 'Prompt is required' }, origin);
    return;
  }

  sendSseHeaders(res, origin);
  writeSse(res, 'meta', { ok: true, source: body.source || 'stream', generatedAt: new Date().toISOString() });

  const context = { intent: body.intent, page: body.page, source: body.source || 'chat-stream', memberContext: body.memberContext };
  const attempts = [];

  if (process.env.GAIA_ASSIST_VOICE_ENABLED !== 'true') {
    const reply = fallbackAssistReply(prompt, body.intent);
    writeSse(res, 'delta', { text: reply });
    writeSse(res, 'done', { ok: true, provider: 'local-fallback', reply, attempts: [{ provider: 'assist', status: 'disabled' }] });
    res.end();
    return;
  }

  for (const provider of ASSIST_PROVIDER_ORDER) {
    const started = Date.now();
    try {
      const result = await streamChatProvider(provider, prompt, context, (text) => {
        writeSse(res, 'delta', { text });
      });
      if (result.skipped) {
        attempts.push({ provider, status: 'skipped', reason: result.reason });
        continue;
      }
      const latencyMs = Date.now() - started;
      attempts.push({ provider, status: 'ok', latencyMs, model: result.model });
      console.log('[Gaia Assist] stream response ready', {
        provider: result.provider,
        model: result.model,
        latencyMs,
        source: body.source || 'chat-stream',
      });
      writeSse(res, 'done', {
        ok: true,
        provider: result.provider,
        model: result.model,
        reply: result.reply,
        attempts,
        generatedAt: new Date().toISOString(),
      });
      res.end();
      return;
    } catch (error) {
      attempts.push({
        provider,
        status: 'failed',
        latencyMs: Date.now() - started,
        error: error.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]').slice(0, 320),
      });
      console.error('[Gaia Assist] stream provider failed', { provider, error: error.message.split('\n')[0] });
    }
  }

  const reply = fallbackAssistReply(prompt, body.intent);
  writeSse(res, 'delta', { text: reply });
  writeSse(res, 'done', {
    ok: true,
    provider: 'local-fallback',
    reply,
    warning: 'All configured assistant providers failed; showing safe local fallback.',
    attempts,
    generatedAt: new Date().toISOString(),
  });
  res.end();
}

async function assistTts(body) {
  const text = String(body.text || '').trim();
  if (!text) {
    return { ok: false, status: 400, error: 'Text is required for TTS' };
  }
  const requestedProvider = String(body.provider || '').trim().toLowerCase();
  if (requestedProvider === 'browser') {
    return { ok: false, status: 503, error: 'Browser speech requested; use SpeechSynthesis fallback.', provider: 'browser' };
  }
  const providers = requestedProvider && requestedProvider !== 'auto'
    ? [requestedProvider]
    : TTS_PROVIDER_ORDER;
  const attempts = [];

  for (const provider of providers) {
    const started = Date.now();
    try {
      const payload = await callTtsProvider(provider, text, body);
      if (payload.skipped) {
        attempts.push({ provider, status: 'skipped', reason: payload.reason });
        console.log('[Gaia Assist] TTS provider skipped', { provider, reason: payload.reason });
        continue;
      }
      const latencyMs = Date.now() - started;
      attempts.push({ provider, status: 'ok', latencyMs, model: payload.model });
      console.log('[Gaia Assist] TTS response ready', { provider, bytes: payload.audio.length, latencyMs, model: payload.model });
      return { ...payload, attempts };
    } catch (error) {
      attempts.push({
        provider,
        status: 'failed',
        latencyMs: Date.now() - started,
        error: error.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]').slice(0, 320),
      });
      console.error('[Gaia Assist] TTS provider failed', { provider, error: error.message.split('\n')[0] });
    }
  }

  return {
    ok: false,
    status: 503,
    error: 'Backend TTS providers failed or are not configured; use browser SpeechSynthesis fallback.',
    provider: 'browser',
    attempts,
  };
}

async function callTtsProvider(provider, text, body = {}) {
  const speed = clampNumber(body.speed, 0.75, 1.25, 1);
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) return { skipped: true, reason: 'missing-api-key' };
    const voice = safeOpenAiVoice(body.voice, OPENAI_TTS_VOICE);
    console.log('[Gaia Assist] TTS provider attempt', { provider: 'openai', model: OPENAI_TTS_MODEL, voice });
    return openAiCompatibleTts({
      endpoint: 'https://api.openai.com/v1/audio/speech',
      apiKey: process.env.OPENAI_API_KEY,
      model: OPENAI_TTS_MODEL,
      voice,
      text,
      speed,
      provider: 'openai',
    });
  }

  if (provider === 'elevenlabs') {
    if (!process.env.ELEVENLABS_API_KEY) return { skipped: true, reason: 'missing-api-key' };
    const voiceId = String(body.voiceId || ELEVENLABS_VOICE_ID).trim();
    if (!voiceId) return { skipped: true, reason: 'missing-voice-id' };
    console.log('[Gaia Assist] TTS provider attempt', { provider: 'elevenlabs', model: ELEVENLABS_MODEL, voice: voiceId, outputFormat: ELEVENLABS_OUTPUT_FORMAT });
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}&optimize_streaming_latency=3`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 4500),
        model_id: ELEVENLABS_MODEL,
        voice_settings: {
          stability: 0.44,
          similarity_boost: 0.74,
          style: 0.18,
          use_speaker_boost: true,
        },
      }),
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`elevenlabs TTS request failed with ${response.status}: ${details.slice(0, 280)}`);
    }
    return {
      ok: true,
      provider: 'elevenlabs',
      model: ELEVENLABS_MODEL,
      voice: ELEVENLABS_VOICE_NAME || voiceId,
      audio: Buffer.from(await response.arrayBuffer()),
    };
  }

  if (provider === 'compatible') {
    const base = (process.env.OPENAI_COMPATIBLE_TTS_BASE_URL || '').replace(/\/+$/, '');
    const apiKey = process.env.OPENAI_COMPATIBLE_TTS_API_KEY;
    if (!base) return { skipped: true, reason: 'missing-base-url' };
    if (!apiKey) return { skipped: true, reason: 'missing-api-key' };
    const endpoint = base.endsWith('/audio/speech') ? base : `${base}/v1/audio/speech`;
    const voice = safeOpenAiVoice(body.voice, COMPAT_TTS_VOICE);
    console.log('[Gaia Assist] TTS provider attempt', { provider: 'compatible', model: COMPAT_TTS_MODEL, voice });
    return openAiCompatibleTts({
      endpoint,
      apiKey,
      model: COMPAT_TTS_MODEL,
      voice,
      text,
      speed,
      provider: 'compatible',
    });
  }

  return { skipped: true, reason: 'unknown-provider' };
}

async function openAiCompatibleTts({ endpoint, apiKey, model, voice, text, speed, provider }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text.slice(0, 4000),
      response_format: 'mp3',
      speed,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`${provider} TTS request failed with ${response.status}: ${details.slice(0, 280)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  return { ok: true, provider, model, voice, audio };
}

async function assistTranscribe(body) {
  const started = Date.now();
  const audioBase64 = String(body.audioBase64 || '').trim();
  if (!audioBase64) {
    return { ok: false, status: 400, error: 'audioBase64 is required' };
  }
  if (audioBase64.length > 3 * 1024 * 1024) {
    return { ok: false, status: 413, error: 'Audio payload is too large' };
  }

  const mimeType = String(body.mimeType || 'audio/webm').trim() || 'audio/webm';
  const extension = mimeType.includes('mp4') || mimeType.includes('aac') ? 'voice.m4a' : 'voice.webm';
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  console.log('[Gaia Assist] STT request received', { bytes: audioBuffer.length, mimeType });

  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const providerStarted = Date.now();
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mimeType }), extension);
      form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');
      const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        body: form,
      });
      if (response.ok) {
        const payload = await response.json();
        const transcript = String(payload.text || payload.transcript || '').trim();
        if (transcript) {
          const latencyMs = Date.now() - started;
          console.log('[Gaia Assist] STT response ready', {
            provider: 'elevenlabs',
            model: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
            latencyMs,
            providerLatencyMs: Date.now() - providerStarted,
          });
          return {
            ok: true,
            transcript,
            provider: 'elevenlabs',
            model: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
          };
        }
      } else {
        const details = await response.text();
        console.error('[Gaia Assist] ElevenLabs STT failed', { status: response.status, details: details.slice(0, 180) });
      }
    } catch (error) {
      console.error('[Gaia Assist] ElevenLabs STT error', { error: error.message.split('\n')[0] });
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, status: 503, error: 'Speech transcription is not configured on the proxy' };
  }

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), extension);
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
  form.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Whisper transcription failed with ${response.status}: ${details.slice(0, 280)}`);
  }

  const payload = await response.json();
  const transcript = String(payload.text || '').trim();
  console.log('[Gaia Assist] STT response ready', {
    provider: 'openai-whisper',
    model: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
    latencyMs: Date.now() - started,
  });
  return {
    ok: true,
    transcript,
    provider: 'openai-whisper',
    model: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
  };
}

async function listHostedVoices() {
  if (!process.env.ELEVENLABS_API_KEY) {
    return {
      ok: true,
      provider: 'none',
      voices: ELEVENLABS_VOICE_ID
        ? [{ id: ELEVENLABS_VOICE_ID, name: ELEVENLABS_VOICE_NAME, provider: 'elevenlabs' }]
        : [],
    };
  }
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`voices ${response.status}`);
    const payload = await response.json();
    const voices = (payload.voices || [])
      .map((voice) => ({
        id: voice.voice_id,
        name: voice.name,
        provider: 'elevenlabs',
        category: voice.category || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, provider: 'elevenlabs', voices };
  } catch (error) {
    return {
      ok: true,
      provider: 'elevenlabs',
      voices: ELEVENLABS_VOICE_ID
        ? [{ id: ELEVENLABS_VOICE_ID, name: ELEVENLABS_VOICE_NAME, provider: 'elevenlabs' }]
        : [],
      warning: error.message,
    };
  }
}


// Every GHL order and invoice containing one of these exact product ids.
// GETs only. Returns line-item quantity, which is what separates a second seat
// from an upgrade, and the payment status, which is what excludes the rest.
// Order and invoice LINE ITEMS need a detail call each, and there are >1200 of
// them -- far too slow to do inside a click. They are also immutable once paid,
// so they are cached on disk and only new ids are fetched. The hourly mirror
// keeps the cache warm.
const GHL_ITEM_CACHE = '/root/gaia-staging-proxy/data/ghl-line-items.json';
function loadItemCache() {
  try { return JSON.parse(fs.readFileSync(GHL_ITEM_CACHE, 'utf8')); }
  catch (e) { return { orders: {}, invoices: {} }; }
}
function saveItemCache(c) {
  try {
    fs.mkdirSync('/root/gaia-staging-proxy/data', { recursive: true });
    fs.writeFileSync(GHL_ITEM_CACHE, JSON.stringify(c));
  } catch (e) { /* cache is an optimisation, never a correctness requirement */ }
}

async function ghlSalesForProducts(wanted) {
  const LOC = process.env.GHL_LOCATION_ID;
  const G = (process.env.GHL_API_BASE_URL || 'https://services.leadconnectorhq.com').replace(/\/+$/, '');
  const H = { Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
              Version: process.env.GHL_API_VERSION || '2021-07-28', Accept: 'application/json' };
  const get = async (path) => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(G + path, { headers: H });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 700 + i * 500)); continue; }
      try { return await r.json(); } catch (e) { return {}; }
    }
    return {};
  };
  const page = async (u, k) => { const o = []; let off = 0;
    for (;;) { const j = await get(`${u}&limit=100&offset=${off}`); const rows = j[k] || j.data || [];
      o.push(...rows); if (rows.length < 100 || off > 4000) break; off += 100; } return o; };

  const cache = loadItemCache();
  let fetched = 0;

  const orders = [];
  for (const o of await page(`/payments/orders?altId=${LOC}&altType=location`, 'data')) {
    let all = cache.orders[o._id];
    if (!all) {
      const f = await get(`/payments/orders/${o._id}?altId=${LOC}&altType=location`);
      const body = (f && (f.order || f)) || {};
      all = (body.items || []).map((it) => ({
        product_id: String((it.product && it.product._id) || it.productId || ''),
        price_id: (it.price && it.price._id) || it.priceId || null,
        name: (it.product && it.product.name) || it.name || null,
        qty: Number(it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1)) }));
      cache.orders[o._id] = all;
      if (++fetched % 100 === 0) saveItemCache(cache);
    }
    const items = all.filter((it) => wanted.has(String(it.product_id || '')));
    if (!items.length) continue;
    orders.push({ id: o._id, status: String(o.status || '').toLowerCase(), amount: o.amount,
      created_at: o.createdAt, contact_id: o.contactId,
      email: String(o.contactEmail || '').toLowerCase(), name: o.contactName,
      items });
  }

  const invoices = [];
  for (const iv of await page(`/invoices/?altId=${LOC}&altType=location`, 'invoices')) {
    let all = cache.invoices[iv._id];
    if (!all) {
      const f = await get(`/invoices/${iv._id}?altId=${LOC}&altType=location`);
      const body = (f && (f.invoice || f)) || {};
      all = (body.invoiceItems || iv.invoiceItems || []).map((it) => ({
        product_id: String(it.productId || ''), price_id: it.priceId || null,
        name: it.name || null,
        qty: Number(it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1)) }));
      cache.invoices[iv._id] = all;
      if (++fetched % 100 === 0) saveItemCache(cache);
    }
    const items = all.filter((it) => wanted.has(String(it.product_id || '')));
    if (!items.length) continue;
    const cd = iv.contactDetails || {};
    invoices.push({ id: iv._id, status: String(iv.status || '').toLowerCase(),
      amount_paid: iv.amountPaid, total: iv.total,
      created_at: iv.issueDate || iv.createdAt, contact_id: cd.id,
      email: String(cd.email || '').toLowerCase(), name: cd.name,
      items });
  }

  // A refunded payment must not be replayed into a seat.
  const reversed = {};
  for (const t of await page(`/payments/transactions?altId=${LOC}&altType=location`, 'data')) {
    const st = String(t.status || '').toLowerCase();
    if (st === 'refunded' || st === 'partially_refunded') reversed[String(t.entityId || '')] = st;
  }
  saveItemCache(cache);
  return { orders, invoices, reversed, cache_misses: fetched };
}

// The card verifier sends its codes through the same transactional channel the
// sign-in magic link already uses. Injected rather than imported so the
// identity module stays testable without a mail server.
eventIdentity.setCardMailer(ghlSendEmail);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/entitlement-review') {
      const sec = String(req.headers['x-webhook-secret'] || url.searchParams.get('secret') || '').trim();
      if (!(GHL_WORKFLOW_WEBHOOK_SECRET.length>=32 && safeSecretEqual(sec, GHL_WORKFLOW_WEBHOOK_SECRET))) { sendJson(res,403,{ok:false,error:'forbidden'},origin); return; }
      const reg = loadProductRegistry(); let rev={items:{}}; try { rev=JSON.parse(fs.readFileSync(PAYMENT_REVIEW_FILE,'utf8')); } catch(_){}
      const counts={}; for (const p of Object.values(reg.products||{})) counts[p.classification]=(counts[p.classification]||0)+1;
      const reviewRequired = Object.entries(reg.products||{}).filter(([,p])=>p.classification==='REVIEW_REQUIRED').map(([id,p])=>({product_id:id,name:p.name,orders:p.orders,note:p.note}));
      sendJson(res,200,{ok:true,summary:counts,review_required:reviewRequired,recent_unclassified_payments:Object.values(rev.items||{})},origin); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/courses') {
      await coursesList(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/academy/manifest') {
      await academyManifest(req, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/academy/sync') {
      await academySync(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/academy/me') {
      await academyMe(req, res, origin, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/academy/progress') {
      await academyProgress(req, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/academy/webhook') {
      await academyWebhook(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      await eventsList(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+$/.test(url.pathname)) {
      await eventDetail(req, res, origin, url.pathname.split('/').pop());
      return;
    }
    // My Events / My Ticket. Identity comes from the session cookie only —
    // there is deliberately no way to ask for someone else's by id.
    // In-app reader for Gaia pages that refuse to be framed (Shopify sends
    // X-Frame-Options: DENY). Same principle as the Store: render Shopify
    // content natively rather than trying to embed the storefront.
    if (req.method === 'GET' && url.pathname === '/api/reader') {
      const target = url.searchParams.get('url') || '';
      const result = await reader.read(target);
      sendJson(res, result.ok ? 200 : 400, result, origin, {
        'Cache-Control': 'public, max-age=600',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/ghl-payment') {
      await handleGhlPaymentWebhook(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events/mine') {
      const session = cookieForRequest(req);
      sendJson(res, 200, await eventIdentity.myEvents(session), origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events/push/vapid-key') {
      sendJson(res, 200, await eventIdentity.pushVapidKey(), origin, { 'Cache-Control': 'public, max-age=3600' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/push\/subscribe$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await eventIdentity.pushSubscribe(session, url.pathname.split('/')[3], body.subscription);
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/push\/unsubscribe$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await eventIdentity.pushUnsubscribe(session, body.endpoint);
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+\/upgrades$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const result = await eventIdentity.myUpgrades(session, url.pathname.split('/')[3]);
      // Fill each option's price from GHL (authoritative), never hard-coded.
      if (result && result.ok && Array.isArray(result.upgrades) && result.upgrades.length) {
        const LOC = (process.env.GHL_LOCATION_ID || '').trim();
        await Promise.all(result.upgrades.map(async (u) => {
          u.price = null;
          if (!u.external_product_id) return;
          try {
            const pr = await ghlGet(`/products/${u.external_product_id}/price`, { locationId: LOC, limit: 100 });
            const list = (pr && (pr.prices || pr.data)) || [];
            const match = u.external_price_id ? list.find((p) => String(p._id) === String(u.external_price_id)) : list[0];
            if (match) u.price = { amount: match.amount, currency: String(match.currency || 'USD').toUpperCase() };
          } catch (e) { /* price stays null; the app shows "see price at checkout" */ }
        }));
      }
      sendJson(res, result && result.authenticated === false ? 401 : 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+\/updates$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const result = await eventIdentity.announcements(session, url.pathname.split('/')[3]);
      sendJson(res, 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+\/posts$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const since = Number(url.searchParams.get('since') || 0) || 0;
      const result = await eventIdentity.communityFeed(session, url.pathname.split('/')[3], since);
      sendJson(res, 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/posts$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await eventIdentity.createPost(session, url.pathname.split('/')[3], body);
      sendJson(res, result.authenticated === false ? 401 : (result.ok ? 200 : 400), result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/posts\/\d+\/like$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const parts = url.pathname.split('/');
      const result = await eventIdentity.postAction(session, parts[3], parts[5], 'like');
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/posts\/\d+\/report$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const parts = url.pathname.split('/');
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await eventIdentity.postAction(session, parts[3], parts[5], 'report', body.reason);
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/posts\/image$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const ct = req.headers['content-type'] || '';
      const chunks = [];
      let total = 0; let tooBig = false;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 6 * 1024 * 1024) { tooBig = true; break; }
        chunks.push(chunk);
      }
      if (tooBig) { sendJson(res, 413, { ok: false, reason: 'too_large', detail: 'Image is too large (max 5MB)' }, origin); return; }
      const result = await eventIdentity.uploadPostImage(session, url.pathname.split('/')[3], ct, Buffer.concat(chunks));
      sendJson(res, result.authenticated === false ? 401 : (result.ok ? 200 : 400), result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    // ── The digital badge card (behind the printed QR) ───────────────────
    // The member's permanent badge card, with no event in the path: it belongs
    // to the person and outlives every event it was ever issued at.
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/card') {
      const session = cookieForRequest(req);
      const result = req.method === 'POST'
        ? await eventIdentity.updateCard(session, 0, await readJsonBody(req).catch(() => ({})))
        : await eventIdentity.myCard(session, 0);
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin,
               { 'Cache-Control': 'private, no-store' });
      return;
    }
    // Ownership of a printed badge token, from the session only. The card page
    // on card.gaiahealers.app asks this to decide whether to show "Edit my card".
    // Read-only: every GHL sale of ONE exact product id, for Map & Reconcile.
    // The Event Manager holds no GHL credentials by design, so it asks here.
    // Matching is on the immutable product id only -- never on a product name,
    // which is exactly how a renamed product would silently split in two.
    if (req.method === 'GET' && url.pathname === '/api/event/ghl-sales') {
      const svc = (process.env.IDENTITY_SERVICE_TOKEN || '').trim();
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!svc || auth !== svc) { sendJson(res, 401, { ok: false, error: 'unauthorized' }, origin); return; }
      const wantedRaw = String(url.searchParams.get('product_id') || '').trim();
      if (!wantedRaw) { sendJson(res, 400, { ok: false, error: 'product_id required' }, origin); return; }
      const wanted = new Set(wantedRaw.split(',').map((x) => x.trim()).filter(Boolean));
      try {
        const sales = await ghlSalesForProducts(wanted);
        sendJson(res, 200, { ok: true, product_ids: [...wanted], ...sales }, origin,
                 { 'Cache-Control': 'private, no-store' });
      } catch (e) {
        sendJson(res, 502, { ok: false, error: String((e && e.message) || e) }, origin);
      }
      return;
    }
    // Identity verification for the card's protected fields. Every one of these
    // needs a real Gaia session -- a public badge token can view a card and can
    // never change one, so none of them accept a token.
    if (req.method === 'POST' && url.pathname.startsWith('/api/card/verify')) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      let result;
      if (url.pathname === '/api/card/verify/destinations') result = await eventIdentity.cardVerifyDestinations(session);
      else if (url.pathname === '/api/card/verify/start') result = await eventIdentity.cardVerifyStart(session, body || {});
      else if (url.pathname === '/api/card/verify/confirm') result = await eventIdentity.cardVerifyConfirm(session, body || {});
      else if (url.pathname === '/api/card/verify/new/start') result = await eventIdentity.cardVerifyNewStart(session, body || {});
      else if (url.pathname === '/api/card/verify/new/confirm') result = await eventIdentity.cardVerifyNewConfirm(session, body || {});
      else { sendJson(res, 404, { ok: false, error: 'not_found' }, origin); return; }
      const code = result.authenticated === false ? 401
        : result.reason === 'rate_limited' ? 429 : 200;
      sendJson(res, code, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if ((req.method === 'GET' || req.method === 'POST') && (url.pathname === '/api/card/owner' || url.pathname === '/api/card/claim')) {
      const session = cookieForRequest(req);
      const body = req.method === 'POST' ? await readJsonBody(req).catch(() => ({})) : {};
      const token = String((body && body.token) || url.searchParams.get('token') || '');
      const result = await eventIdentity.cardOwner(session, token);
      sendJson(res, 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+\/card$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const result = await eventIdentity.myCard(session, url.pathname.split('/')[3]);
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/card$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await eventIdentity.updateCard(session, url.pathname.split('/')[3], body || {});
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && (/^\/api\/events\/\d+\/card\/photo$/.test(url.pathname) || url.pathname === '/api/card/photo')) {
      const session = cookieForRequest(req);
      const ct = req.headers['content-type'] || '';
      const chunks = [];
      let total = 0; let tooBig = false;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 6 * 1024 * 1024) { tooBig = true; break; }
        chunks.push(chunk);
      }
      if (tooBig) { sendJson(res, 413, { ok: false, reason: 'too_large', detail: 'Image is too large (max 5MB)' }, origin); return; }
      const photoEvent = url.pathname === '/api/card/photo' ? 0 : url.pathname.split('/')[3];
      const result = await eventIdentity.uploadCardPhoto(session, photoEvent, ct, Buffer.concat(chunks));
      sendJson(res, result.authenticated === false ? 401 : (result.ok ? 200 : 400), result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+\/ticket$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const result = await eventIdentity.myTicket(session, url.pathname.split('/')[3]);
      // A ticket is personal: never cached, by any hop.
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, {
        'Cache-Control': 'private, no-store',
      });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+\/schedule$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const result = await eventIdentity.mySchedule(session, url.pathname.split('/')[3]);
      // A signed-out reader is a normal state, not an error: every anonymous
      // event view asks this question, and answering 401 painted three red
      // lines in the console per visit. 401 stays for the POST actions.
      sendJson(res, 200, result, origin, { 'Cache-Control': 'private, no-store' });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/schedule$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const action = body.action === 'unsave' ? 'unsave' : 'save';
      const result = await eventIdentity.changeSchedule(
        session, url.pathname.split('/')[3], body.sessionId, action,
      );
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, {
        'Cache-Control': 'private, no-store',
      });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/workshops$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const action = body.action === 'unregister' ? 'unregister' : 'register';
      const result = await eventIdentity.changeWorkshop(
        session, url.pathname.split('/')[3], body.sessionId, action,
      );
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, {
        'Cache-Control': 'private, no-store',
      });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/networking$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const extra = {};
      if (body.action === 'profile') { extra.visible = body.visible === true; extra.bio = String(body.bio || ''); }
      if (body.action === 'connect') extra.target_attendee_id = Number(body.targetAttendeeId) || 0;
      if (body.action === 'respond') { extra.connection_id = Number(body.connectionId) || 0; extra.accept = body.accept === true; }
      if (body.action === 'connectByToken') extra.token = String(body.token || '').trim().toUpperCase().slice(0, 16);
      const result = await eventIdentity.networking(
        session, url.pathname.split('/')[3], String(body.action || ''), extra,
      );
      // Reads (directory, connections) run on every event view and answer 200
      // for the signed-out; mutations still refuse with 401.
      const isRead = body.action === 'directory' || body.action === 'connections';
      sendJson(res, result.authenticated === false && !isRead ? 401 : 200, result, origin, {
        'Cache-Control': 'private, no-store',
      });
      return;
    }
    if (req.method === 'POST' && /^\/api\/events\/\d+\/feedback$/.test(url.pathname)) {
      const session = cookieForRequest(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await eventIdentity.feedback(session, url.pathname.split('/')[3], body);
      sendJson(res, result.authenticated === false ? 401 : 200, result, origin, {
        'Cache-Control': 'private, no-store',
      });
      return;
    }
    if (req.method === 'GET' && /^\/api\/events\/\d+\/live$/.test(url.pathname)) {
      await eventLive(req, res, origin, url.pathname.split('/')[3]);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/courses/sync') {
      await coursesSync(req, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/ghl/member-access') {
      await memberAccessWebhook(req, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/ghl/member-backfill') {
      await memberBackfill(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      await authSession(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      await authSession(req, res, origin, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      await authLogout(req, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/magic-link/request') {
      await authMagicLinkRequest(req, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/quiz/lead') {
      await quizLead(req, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/join') {
      await authJoin(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/magic-link/poll') {
      await authMagicLinkPoll(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/magic-link/start') {
      authMagicLinkStart(req, res);
      return;
    }
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/auth/magic-link/consume') {
      await authMagicLinkConsume(req, res, origin, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/embedded/claim') {
      await authEmbeddedClaim(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/providers') {
      authProviders(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/oauth/google/start') {
      authOAuthStart(req, res, origin, url, 'google');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/oauth/google/callback') {
      await authOAuthGoogleCallback(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/oauth/apple/start') {
      authOAuthStart(req, res, origin, url, 'apple');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/oauth/apple/callback') {
      await authOAuthAppleCallback(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/app/bootstrap') {
      const boot = await bootstrap(req, url);
      try {
        if (boot && boot.gaia) {
          boot.gaia.announcements = adminRouter.publishedAnnouncements();
          boot.gaia.adminEvents = adminRouter.publishedEvents();
        }
      } catch (_) { /* admin store optional */ }
      sendJson(res, 200, boot, origin);
      return;
    }
    if (url.pathname.startsWith('/api/admin/')) {
      await adminRouter.handle(req, res, url, {
        origin, sendJson, readJsonBody, signTokenPayload, readSignedToken,
        parseCookies, ghlGet, ghlConfig, ghlHeaders,
        loadLedger: loadMemberEntitlements, saveLedger: saveMemberEntitlements,
        loadStoreCatalog, runStoreSync,
        sendAlertEmail,
      });
      return;
    }
    if (url.pathname.startsWith('/api/wellness/')) {
      await wellnessRouter.handle(req, res, url, {
        origin, sendJson, readJsonBody, signTokenPayload, readSignedToken, parseCookies, aiComplete, ghlUpsertContact, memberLookup: wellnessMemberLookup, memberSession: cookieForRequest(req),
      });
      return;
    }
    if (url.pathname === '/api/directory' || url.pathname.startsWith('/api/directory/')) {
      await directoryRouter.handle(req, res, url, { origin, sendJson });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/academy/progress') {
      const memberContext = requireSessionMember(req, res, origin);
      if (!memberContext) return;
      const payload = applyMemberContextToAcademy(await getAcademyProgress(withMemberContext(url, memberContext)), memberContext);
      payload.authenticated = Boolean(memberContext);
      payload.memberResolved = Boolean(memberContext?.email || memberContext?.memberId || memberContext?.contactId);
      sendJson(res, 200, payload, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/member/hub') {
      const memberContext = requireSessionMember(req, res, origin);
      if (!memberContext) return;
      const scopedUrl = withMemberContext(url, memberContext);
      const academy = applyMemberContextToAcademy(await getAcademyProgress(scopedUrl).catch(() => FALLBACK_ACADEMY), memberContext);
      const hub = applyMemberContextToMemberHub(await getMemberHub(scopedUrl, academy), memberContext);
      hub.authenticated = Boolean(memberContext);
      hub.memberResolved = Boolean(memberContext?.email || memberContext?.memberId || memberContext?.contactId);
      sendJson(res, 200, hub, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/member/access') {
      await memberAccess(req, res, origin, url);
      return;
    }
    // Public plan catalogue. Presentation data only — this endpoint has no
    // access to the ledger and nothing it returns can grant anything.
    // The Gaia shelf. Served from Gaia's own synced copy so the app does not
    // depend on Shopify being reachable, and so the catalogue can be organised
    // by Gaia's categories rather than Shopify's. Buying still leaves for
    // Shopify — Gaia never sees a payment.
    if (req.method === 'GET' && url.pathname === '/api/store/catalog') {
      let registry = { mappings: {}, canonical: {} };
      try { registry = loadMembershipRegistry(); } catch (_) { /* unmapped is fine */ }
      sendJson(res, 200, { ok: true, ...storeView(loadStoreCatalog(), registry) }, origin);
      return;
    }
    // One product, as a member sees it. Public: the Store is browsable signed
    // out, and nothing here depends on who is asking.
    if (req.method === 'GET' && url.pathname === '/api/store/product') {
      let registry = { mappings: {}, canonical: {} };
      let model = { products: {} };
      try { registry = loadMembershipRegistry(); } catch (_) { /* unmapped is fine */ }
      try { model = loadCommerceModel(); } catch (_) { /* unmodelled is fine */ }
      const catalog = loadStoreCatalog();
      const detail = productDetail(catalog, registry, model, url.searchParams.get('id'), {
        currency: catalog.currency || 'USD',
        showPrices: catalog.priceVerified === true && Boolean(catalog.currency),
      });
      if (!detail) { sendJson(res, 404, { ok: false, error: 'Not found.' }, origin); return; }
      sendJson(res, 200, { ok: true, product: detail }, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/membership/plans') {
      // Served from the policy an operator edits, so the Store and the Control
      // Center can never disagree about what a plan costs or promises.
      sendJson(res, 200, { ok: true, plans: membershipPlans(loadMembershipPolicy()) }, origin);
      return;
    }
    // Dev-only: mint a session carrying fixture authority. Inert unless the
    // process has fixtures enabled AND the caller presents the fixture key.
    if (req.method === 'POST' && url.pathname === '/api/dev/fixture-session') {
      if (!fixturesAvailable() || !fixtureKeyMatches(req.headers['x-gaia-fixture-key'])) {
        sendJson(res, 404, { ok: false, error: 'Not found.' }, origin);
        return;
      }
      const requested = String(url.searchParams.get('fixture') || 'fixture-gold-annual').trim();
      const fixture = requested.startsWith('fixture-') ? requested : `fixture-${requested}`;
      const token = signTokenPayload({
        member: { contactId: fixture, email: `${fixture}@fixture.invalid`, name: fixture },
        source: 'fixture',
        fixtureAccess: true,
        fixture,
        exp: Date.now() + 8 * 60 * 60 * 1000,
      });
      res.setHeader('Set-Cookie', buildSetCookie(req, token, Date.now() + 8 * 60 * 60 * 1000));
      sendJson(res, 200, { ok: true, fixture, available: fixtureIds() }, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/member/profile') { await memberProfile(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/communities') { await memberCommunities(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/devices') { await memberDevices(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/appointments') { await memberAppointments(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/activity') { await memberActivity(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/products') { await memberProducts(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/purchases') { await memberPurchases(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/courses') { await memberCourses(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/events') { await memberEvents(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/forms') { await memberForms(req, res, origin); return; }
    if (req.method === 'GET' && url.pathname === '/api/member/notifications') { await memberNotifications(req, res, origin); return; }
    // Gaia Assist routes are member-only: they proxy paid LLM/voice/tts calls,
    // so every request must carry a valid Gaia Healers member session cookie.
    if (url.pathname.startsWith('/api/assist/')) {
      /* Gaia Assist is open to all visitors (member or not); nginx rate-limits /api/assist/ for quota protection. Sign-in gate disabled per product decision. */
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/lookup') {
      const body = await readJsonBody(req).catch(() => ({}));
      const r = await gaiaLookup(String(body.query || body.q || '')).catch(() => ({ ok: false }));
      sendJson(res, 200, { ok: true, summary: formatLookup(r, body.query || ''), data: r }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/memory') {
      const sm = sessionMemberContext(req);
      if (!sm) { sendJson(res, 200, { ok: false, reason: 'not_signed_in' }, origin); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      let facts = body.facts; if (typeof facts === 'string') facts = [facts]; if (!Array.isArray(facts)) facts = [];
      try { const b = await fetchMemberBundle(sm); const r = rememberForContact(b && b.contactId, facts, body.summary || ''); sendJson(res, 200, r, origin); } catch (e) { sendJson(res, 200, { ok: false }, origin); }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/interest') {
      const sm = sessionMemberContext(req);
      const body = await readJsonBody(req).catch(() => ({}));
      const info = onboarding.interestFromTopic(String(body.topic || ''));
      let saved = false;
      if (sm && info.tags.length) { try { const b = await fetchMemberBundle(sm); if (b && b.contactId) { await ghlPost(`/contacts/${encodeURIComponent(b.contactId)}/tags`, { tags: info.tags }).catch(() => null); saved = true; } } catch (e) {} }
      sendJson(res, 200, { ok: true, matched: info.matched, saved, tags: info.tags, route: info.route }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/onboarding') {
      const sm = sessionMemberContext(req);
      if (!sm) { sendJson(res, 200, { ok: false, reason: 'not_signed_in' }, origin); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const b = await fetchMemberBundle(sm);
      if (!b || !b.contactId) { sendJson(res, 200, { ok: false, reason: 'no_contact' }, origin); return; }
      const result = await applyOnboardingStep(b.contactId, String(body.stepKey || ''), Array.isArray(body.selections) ? body.selections : [], String(body.freeText || ''), Boolean(body.complete));
      sendJson(res, 200, { ok: true, stepKey: body.stepKey || '', ...result }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/chat') {
      const body = await readJsonBody(req);
      const memberContext0 = await buildMemberVoiceContext(req);
      const liveData = await assistLiveDataBlock(String(body.prompt || body.transcript || '')).catch(() => '');
      const memberContext = [memberContext0, liveData].filter(Boolean).join('\n\n');
      const payload = await assistChat({ ...body, source: body.source || 'chat', memberContext });
      try { if (payload && payload.reply) { const ex = await executeOnboardingMarkers(req, payload.reply); payload.reply = ex.clean; if (ex.ran) payload.onboardingSaved = ex.ran; } } catch (e) {}
      sendJson(res, payload.ok === false ? 400 : 200, payload, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/chat/stream') {
      const body = await readJsonBody(req);
      const memberContext0 = await buildMemberVoiceContext(req);
      const liveData = await assistLiveDataBlock(String(body.prompt || body.transcript || '')).catch(() => '');
      const memberContext = [memberContext0, liveData].filter(Boolean).join('\n\n');
      await assistChatStream({ ...body, source: body.source || 'chat-stream', memberContext }, res, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/voice') {
      const body = await readJsonBody(req);
      const transcript = String(body.transcript || body.prompt || '').trim();
      if (!transcript) {
        sendJson(res, 400, {
          ok: false,
          error: 'Voice route expects a browser transcript. Raw audio upload is not enabled in staging.',
        }, origin);
        return;
      }
      const memberContext = await buildMemberVoiceContext(req);
      const payload = await assistChat({ ...body, prompt: transcript, transcript, source: body.source || 'voice', memberContext });
      sendJson(res, payload.ok === false ? 400 : 200, payload, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/transcribe') {
      const body = await readJsonBody(req, 3 * 1024 * 1024);
      try {
        const payload = await assistTranscribe(body);
        sendJson(res, payload.ok === false ? (payload.status || 503) : 200, payload, origin);
      } catch (error) {
        console.error('[Gaia Assist] transcription failed', { error: error.message.split('\n')[0] });
        sendJson(res, 503, { ok: false, error: error.message }, origin);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/assist/voices') {
      sendJson(res, 200, await listHostedVoices(), origin);
      return;
    }
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/assist/voice/token') {
      await assistLiveToken(req, res, origin, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/tts') {
      const body = await readJsonBody(req);
      try {
        const payload = await assistTts(body);
        if (!payload.ok) {
          sendJson(res, payload.status || 503, payload, origin);
          return;
        }
        res.setHeader('X-Gaia-Voice-Provider', payload.provider);
        res.setHeader('X-Gaia-Voice-Model', payload.model);
        res.setHeader('X-Gaia-Voice-Name', payload.voice || '');
        sendBuffer(res, 200, payload.audio, 'audio/mpeg', origin);
      } catch (error) {
        console.error('[Gaia Assist] TTS chain failed', { error: error.message.split('\n')[0] });
        sendJson(res, 503, {
          ok: false,
          error: 'Backend TTS failed; use browser SpeechSynthesis fallback.',
          provider: 'browser',
        }, origin);
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not found' }, origin);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Gaia staging proxy listening on ${HOST}:${PORT}`);

  // Evaluate alerts on a timer, not on page load.
  //
  // This is the whole point of the exercise: a stopped pipeline at 2am has to
  // be noticed without anybody opening Admin. The incident model makes running
  // this often free — ten failures of one problem stay one incident and one
  // notification — so the cadence is chosen for how fast we want to know, not
  // for how much noise it makes.
  //
  // Skipped entirely under test, where suites boot the server themselves and a
  // background timer would fire against their fixtures.
  if (!process.env.GAIA_DISABLE_ALERT_TIMER) {
    const ALERT_INTERVAL_MS = Number(process.env.ALERT_INTERVAL_MS || 5 * 60 * 1000);
    const runAlertSweep = async () => {
      try {
        const out = await adminRouter.evaluateAlerts({
          ghlGet, ghlConfig, ghlHeaders,
          loadLedger: loadMemberEntitlements, saveLedger: saveMemberEntitlements,
          loadStoreCatalog, sendAlertEmail,
        });
        if (out.opened || out.resolved || out.notificationsFailed) {
          console.log('[Gaia Alerts] sweep', JSON.stringify({
            opened: out.opened, resolved: out.resolved,
            delivered: out.notificationsDelivered, failed: out.notificationsFailed,
          }));
        }
      } catch (e) {
        console.warn('[Gaia Alerts] sweep failed', String((e && e.message) || e).slice(0, 160));
      }
    };
    setTimeout(runAlertSweep, 20 * 1000).unref?.();
    setInterval(runAlertSweep, ALERT_INTERVAL_MS).unref?.();
  }

  // Daily store sync. Disabled under test so the suite never reaches out to a
  // real storefront, and staggered a minute after boot so a restart loop
  // cannot turn into a request loop.
  if (process.env.STORE_SYNC_ENABLED !== 'false' && !process.env.MEMBER_ENTITLEMENTS_FILE?.includes('tmp')) {
    setTimeout(() => { runStoreSync({ reason: 'startup' }); }, 60_000).unref();
    setInterval(() => { runStoreSync({ reason: 'daily' }); }, STORE_SYNC_INTERVAL_MS).unref();
  }
});
