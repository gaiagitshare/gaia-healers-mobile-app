import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import * as adminRouter from './admin-router.js';
import * as wellnessRouter from './wellness-router.js';

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
const AUTH_ALLOW_DEBUG_LINKS = process.env.AUTH_ALLOW_DEBUG_LINKS === 'true';
const AUTH_ALLOW_UNVERIFIED_EMAIL_MAGIC_LINK = process.env.AUTH_ALLOW_UNVERIFIED_EMAIL_MAGIC_LINK === 'true';
const AUTH_EMBED_SHARED_SECRET = process.env.AUTH_EMBED_SHARED_SECRET || process.env.APP_PROXY_SHARED_SECRET || '';
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

const FALLBACK_GAIA = {
  members: 1252,
  portalUrl: 'https://education.gaiahealers.com',
  event: {
    id: 'elevate-2026',
    name: 'Gaia Healers Elevate 2026',
    date: 'Nov 20-22, 2026',
    venue: 'Rosen Shingle Creek',
    location: 'Orlando, FL',
    source: 'staging-proxy',
    stats: {
      attendees: 0,
      paidMembers: 0,
      checkedIn: 0,
      exhibitors: 0,
      leads: 0,
      checkInRate: 0,
    },
  },
};

const FALLBACK_ACADEMY = {
  ok: true,
  configured: false,
  liveData: false,
  source: 'staging-snapshot',
  generatedAt: '',
  member: {
    name: 'Gaia member',
    email: '',
    portalUrl: 'https://education.gaiahealers.com',
  },
  summary: {
    enrolled: 8,
    completed: 2,
    inProgress: 1,
    averageProgress: 38,
    nextCourseTitle: 'Bio-Well Advanced Level 1',
    nextLessonTitle: 'Module 4 · Scan interpretation lab',
    nextLessonUrl: '',
    ceCreditsEarned: 18.5,
    ceCreditsRequired: 24,
  },
  activeCourseId: 'biowell-advanced-l1',
  courses: [
    {
      id: 'biowell-orientation',
      title: 'BIO-WELL Orientation',
      category: 'Bio-Well',
      status: 'completed',
      progressPercent: 100,
      completedLessons: 8,
      totalLessons: 8,
      instructor: 'Gaia Faculty',
      lastActivity: 'Credential issued',
      nextLessonTitle: 'Complete',
      continueUrl: '',
      credential: 'BIO-WELL Orientation Training',
      ceCredits: 2,
    },
    {
      id: 'biowell-basic',
      title: 'BIO-WELL Basic Certification',
      category: 'Bio-Well',
      status: 'completed',
      progressPercent: 100,
      completedLessons: 18,
      totalLessons: 18,
      instructor: 'Gaia Faculty',
      lastActivity: 'Credential issued',
      nextLessonTitle: 'Complete',
      continueUrl: '',
      credential: 'BIO-WELL Basic Certification',
      ceCredits: 8,
    },
    {
      id: 'biowell-advanced-l1',
      title: 'Bio-Well Advanced Level 1',
      category: 'Bio-Well',
      status: 'in_progress',
      progressPercent: 62,
      completedLessons: 9,
      totalLessons: 15,
      instructor: 'Dr. Nina Bashkir',
      lastActivity: 'Scanned 7:42 AM',
      nextLessonTitle: 'Module 4 · Scan interpretation lab',
      continueUrl: '',
      credential: 'Advanced Level 1',
      ceCredits: 8.5,
    },
    {
      id: 'biowell-advanced-l2',
      title: 'Bio-Well Advanced Level 2',
      category: 'Bio-Well',
      status: 'locked',
      progressPercent: 0,
      completedLessons: 0,
      totalLessons: 12,
      instructor: 'Gaia Faculty',
      lastActivity: 'Unlocks at 80% Level 1',
      nextLessonTitle: 'Locked',
      continueUrl: '',
      credential: 'Advanced Level 2',
      ceCredits: 10,
    },
    {
      id: 'biopulsar-basic',
      title: 'BioPulsar Basic Technical & Business',
      category: 'BioPulsar',
      status: 'available',
      progressPercent: 0,
      completedLessons: 0,
      totalLessons: 10,
      instructor: 'BioPulsar Faculty',
      lastActivity: '105 enrolled',
      nextLessonTitle: 'Start course',
      continueUrl: '',
      credential: '',
      ceCredits: 4,
    },
    {
      id: 'biotekna-live',
      title: 'BioTekna Live Trainings',
      category: 'BioTekna',
      status: 'available',
      progressPercent: 0,
      completedLessons: 0,
      totalLessons: 6,
      instructor: 'BioTekna Practitioners',
      lastActivity: 'Live sessions',
      nextLessonTitle: 'Join next training',
      continueUrl: '',
      credential: '',
      ceCredits: 4,
    },
    {
      id: 'healeex-start',
      title: 'Healeex Getting Started',
      category: 'Healeex',
      status: 'available',
      progressPercent: 0,
      completedLessons: 0,
      totalLessons: 5,
      instructor: 'Healeex Community',
      lastActivity: 'Onboarding',
      nextLessonTitle: 'Start course',
      continueUrl: '',
      credential: '',
      ceCredits: 2,
    },
    {
      id: 'chakra-challenge',
      title: '9-Week Chakra Challenge',
      category: 'Chakras',
      status: 'available',
      progressPercent: 0,
      completedLessons: 0,
      totalLessons: 9,
      instructor: 'Gaia Community',
      lastActivity: 'Self-paced',
      nextLessonTitle: 'Start week 1',
      continueUrl: '',
      credential: '',
      ceCredits: 0,
    },
  ],
  credentials: [
    { title: 'BIO-WELL Basic', issuer: 'Gaia Credentials', status: 'issued', issuedAt: '2024' },
    { title: 'BIO-WELL Orientation', issuer: 'Gaia Credentials', status: 'issued', issuedAt: '2024' },
  ],
  requirements: {
    title: 'Level 1 proctored exam',
    description: '20 documented scans · 80% course completion',
    scansCompleted: 14,
    scansRequired: 20,
    courseRequiredPercent: 80,
    currentCoursePercent: 62,
  },
};

const FALLBACK_MEMBER_HUB = {
  ok: true,
  configured: false,
  liveData: false,
  source: 'observed-ghl-memberships',
  generatedAt: '',
  member: {
    displayName: 'Gaia member',
    role: 'Practitioner',
    cohort: 'Bio-Well Practitioners',
    portalUrl: 'https://education.gaiahealers.com',
  },
  portal: {
    url: 'https://education.gaiahealers.com',
    users: 1254,
    invited: 1,
    adminSections: ['Client Portal', 'Courses', 'Communities', 'Credentials', 'Gokollab Marketplace'],
    actions: ['Generate magic link', 'Invite to client portal', 'Send login email'],
  },
  dashboard: {
    welcomeTitle: 'Your Gaia dashboard is ready',
    welcomeDetail: 'Courses, communities, live sessions, credentials, and products from GHL Memberships.',
    nextLessonTitle: 'Module 4 · Scan interpretation lab',
    nextLessonUrl: '',
    nextMeetingTitle: 'Colour Vibrational Energy',
    nextMeetingTime: 'Jun 16 · 2:30 AM',
    eventPassTitle: 'Elevate 2026',
    eventPassDetail: 'Badge ops ready',
    ceCreditsEarned: 18.5,
    ceCreditsRequired: 24,
    topCourse: 'GaiaPractitioners CRM Mastery',
    topCourseMeta: '0.53% completion · 377 enrollments',
    revenueGenerated: '$8,400',
    averageOrderValue: '$1,200',
    totalCheckouts: 7,
  },
  communities: [
    {
      id: 'all',
      name: '[Start Here] All Gaia Healers',
      members: 255,
      posts: 28,
      admins: 3,
      owner: 'Nima Farshid',
      privacy: 'Public',
      badge: 'Start here',
      channels: ['Home', 'Start Here', 'Healers Lounge', 'Ask A Mentor', 'Wins Wall'],
      tabs: ['Discussion', 'Learning', 'Events', 'Members', 'About'],
    },
    {
      id: 'abundant',
      name: 'The Abundant Healer Collective',
      members: 117,
      posts: 0,
      admins: 3,
      owner: 'Nima Farshid',
      privacy: 'Private',
      badge: 'Membership',
      channels: ['Home', 'Mentorship', 'Resources', 'Wins'],
      tabs: ['Discussion', 'Learning', 'Events', 'Members', 'About'],
    },
    {
      id: 'biowell',
      name: 'Bio-Well Practitioners',
      members: 382,
      posts: 11,
      admins: 3,
      owner: 'Nima Farshid',
      privacy: 'Public',
      badge: 'Primary',
      channels: ['Orientation', 'Tech Support', 'Case Studies', 'Bio Cor', 'Bio-Well', 'Glove', 'Sputnik', 'Water Sensor', 'Leaderboard'],
      tabs: ['Discussion', 'Learning', 'Events', 'Members', 'About', 'Leaderboard'],
    },
    {
      id: 'biopulsar',
      name: 'BioPulsar Practitioners',
      members: 508,
      posts: 0,
      admins: 3,
      owner: 'Nima Farshid',
      privacy: 'Public',
      badge: null,
      channels: ['Aura', 'Chakra', 'Reports'],
      tabs: ['Discussion', 'Learning', 'Events', 'Members', 'About'],
    },
    {
      id: 'biotekna',
      name: 'Biotekna Practitioners',
      members: 154,
      posts: 0,
      admins: 3,
      owner: 'Nima Farshid',
      privacy: 'Public',
      badge: null,
      channels: ['Biotekna', 'Nervous System', 'Case Notes'],
      tabs: ['Discussion', 'Learning', 'Events', 'Members', 'About'],
    },
    {
      id: 'healeex',
      name: 'Healeex',
      members: 31,
      posts: 0,
      admins: 3,
      owner: 'Nima Farshid',
      privacy: 'Public',
      badge: 'New',
      channels: ['Introductions', 'Calls', 'Protocols'],
      tabs: ['Discussion', 'Learning', 'Events', 'Members', 'About'],
    },
  ],
  discussions: [
    { group: '[Start Here] All Gaia Healers', channel: 'Featured', title: 'Which Path Will You Take?', author: 'Nima Farshid', time: '5mo ago', type: 'Welcome', replies: 0, likes: 3 },
    { group: '[Start Here] All Gaia Healers', channel: 'Featured', title: 'Welcome! Start Here', author: 'Nima Farshid', time: '6mo ago', type: 'Start', replies: 0, likes: 7 },
    { group: '[Start Here] All Gaia Healers', channel: 'Start Here', title: 'Coming Soon Inside the Gaiahealers Community', author: 'Ruffa C.', time: '1w ago', type: 'Chakra Challenge', replies: 0, likes: 1 },
    { group: 'Bio-Well Practitioners', channel: 'Tech Support', title: 'My Bio-Well is giving me an error', author: 'Practitioner', time: '2w ago', type: 'Support', replies: 4, likes: 2 },
    { group: 'Bio-Well Practitioners', channel: 'Orientation', title: 'Happening Today: Advanced Level 1 Live Training', author: 'Faculty', time: '1mo ago', type: 'Training', replies: 1, likes: 5 },
  ],
  events: [
    { day: 16, month: 'Jun', title: 'Colour Vibrational Energy', time: '2:30 AM', group: 'All Gaia Healers', tz: 'Community calendar', provider: 'google_meet' },
    { day: 16, month: 'Jun', title: 'GaiaPractitioners CRM Mastery', time: '10:00 PM', group: 'All Gaia Healers', tz: 'Community calendar', provider: 'google_meet' },
    { day: 19, month: 'Jun', title: '[Bio-Well] Advanced Level 1', time: '2:00 AM', group: 'Bio-Well Practitioners', tz: 'Training room', provider: 'google_meet' },
    { day: 23, month: 'Jun', title: '[Marketing] Master Your Follow-Up', time: '11:00 PM', group: 'Practitioner growth', tz: 'Live session', provider: 'google_meet' },
  ],
  members: [
    { name: 'Gaia Healers', initials: 'GH', role: 'Admin', activity: 'active 1d ago', group: 'All Gaia Healers' },
    { name: 'Kellie Putman', initials: 'KP', role: 'Bio-Well', activity: 'active 2d ago', group: 'Bio-Well Practitioners' },
    { name: 'Isabel Azprua-Sosa', initials: 'IA', role: 'Contributor', activity: 'active 4d ago', group: 'All Gaia Healers' },
    { name: 'Pari Mahinpey', initials: 'PM', role: 'Contributor', activity: 'active 3d ago', group: 'All Gaia Healers' },
  ],
  newsletters: [
    { id: 'training', title: 'Training reminders', detail: 'Course launches, live labs, CE deadlines', on: true },
    { id: 'chakra', title: 'Chakra challenge', detail: 'Weekly challenge prompts and community highlights', on: true },
    { id: 'events', title: 'Events and Elevate', detail: 'Badge status, room blocks, and event updates', on: true },
    { id: 'offers', title: 'Device and store offers', detail: 'Bio-Well kits, renewals, and bundle pricing', on: false },
  ],
  products: [
    { id: 'biowell-kit', title: 'Bio-Well device kits', category: 'Devices', detail: 'Bio-Well 3.0, Sputnik, Glove, Water Sensor', href: 'home.html?view=wellness&tab=biowell', cta: 'Open wellness' },
    { id: 'biopulsar', title: 'BioPulsar practitioner tools', category: 'Devices', detail: 'Aura and chakra reporting workflows', href: 'home.html?view=wellness&tab=chakras', cta: 'Explore map' },
    { id: 'biotekna', title: 'BioTekna nervous-system programs', category: 'Training', detail: 'Live trainings and certification bundles', href: 'home.html?view=academy', cta: 'Open academy' },
    { id: 'event-pass', title: 'Elevate 2026 passes', category: 'Events', detail: 'VIP, 3-day, workshop, and conference access', href: 'home.html?view=community&tab=events', cta: 'Open events' },
    { id: 'gokollab', title: 'Gokollab Marketplace', category: 'Store', detail: 'Digital offers and member checkout surface inside GHL', href: 'home.html?view=profile', cta: 'Open profile' },
  ],
  meetings: [
    { id: 'colour-vibrational-energy', title: 'Colour Vibrational Energy', startsAt: '2026-06-16T02:30:00+04:00', timezone: 'Asia/Dubai', provider: 'google_meet', visibility: 'community', group: 'All Gaia Healers' },
    { id: 'crm-mastery', title: 'GaiaPractitioners CRM Mastery', startsAt: '2026-06-16T22:00:00+04:00', timezone: 'Asia/Dubai', provider: 'google_meet', visibility: 'community', group: 'All Gaia Healers' },
    { id: 'advanced-level-1', title: '[Bio-Well] Advanced Level 1', startsAt: '2026-06-19T02:00:00+04:00', timezone: 'Asia/Dubai', provider: 'google_meet', visibility: 'cohort', group: 'Bio-Well Practitioners' },
  ],
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
    embeddedRule: 'When the app is embedded in the GHL menu, keep people inside the Gaia app: Home for the next event and member access, Energy for public daily chakra guidance, the top Menu for Academy and Community, Store for shop and membership, and Profile for account and bookings. Only send them to education.gaiahealers.com for actual course videos, community discussions, or portal login.',
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
    '(Course videos are watched in the education.gaiahealers.com portal; the app does not track lesson-by-lesson progress.)',
  ],
  event: {
    name: 'Gaia Healers Elevate Conference 2026',
    date: 'November 20-22, 2026',
    venue: 'Rosen Shingle Creek, Orlando, FL',
    positioning: 'a three-day integrative wellness conference bridging ancient healing traditions and modern energy science',
  },
  app: {
    shell: 'The app is gaiahealers.app (home.html). The bottom bar, left to right, is: Home, Energy, the centre Gaia orb (this is Gaia Assist / you, live voice), Store, Profile. The top-right Menu opens Academy, Community, Membership, Meet the Founder, Find a Practitioner, and Member sign in.',
    screens: [
      'Home (view=today): the calm default screen with the dynamically fetched next event, admin announcements when present, member access / sign-in, and a compact Meet Dr. Nima card that opens his appointment calendar inside the app. The next-event button opens the specific event destination rather than a generic events page.',
      'Energy (view=wellness): public wellness guidance with the birth-date chakra chart and interactive seven-centre guide. It does not require sign-in. It is wellness guidance, not medical advice.',
      'Academy (view=academy, opened from the top Menu): courses and certification. It opens the education.gaiahealers.com portal for the actual lessons and never shows fake progress.',
      'Community (view=community, opened from the top Menu): "My Access" — which communities you have unlocked versus still locked — plus Find a Practitioner. Communities: All Gaia Healers, Bio-Well, BioPulsar, BioTekna, ASEA, BrainTap, LifeWave, Golden Practitioner.',
      'Store (view=store): two tabs — Shop (the live Shopify catalogue by category: Featured, Colour Energy, Courses, Bio-Well, BioPulsar, BioTekna, Crystals; tapping a product opens its image, description, and purchase action in a native in-app sheet; Shopify opens only for the final current-price and secure-payment step) and Membership (the official Free / Silver / Gold / Diamond Gaia 2.0 tiers).',
      'Profile (view=profile, bottom-right): your account — devices, purchases, bookings, messages, membership status, booking tools, and the Colour Personality Test.',
    ],
    features: [
      'Birth-date chakra chart — free on Energy; enter your birth date to see your chakra focus.',
      'Wellness sign-up (name, birth date, location, email) — unlocks your daily body-point and a daily wellness horoscope tip.',
      '8-Week Chakra Challenge — join, then check in daily; one chakra per week with a practice and an affirmation.',
      'Book a session — a Bio-Well energy scan, a Bio-Well demo, a free discovery call, or wellness coaching (real booking links).',
      'Colour Personality Test — 5 questions reveal your chakra colour and suggest the matching Colour Energy spray.',
      'Find a Healer — opens gaiapractitioners.com to browse certified practitioners.',
    ],
    navigation: 'To guide someone, use the exact current structure: bottom Home, Energy, Gaia Assist, Store, Profile; top Menu for Academy, Community, Membership, Meet the Founder, Find a Practitioner, and sign-in. Gaia Assist can route requests to these destinations and can offer the direct founder or booking action. Deep links: home.html?view=today|wellness|academy|community|store|profile (the Store also takes &tab=shop or &tab=membership). Keep people inside the app; only send them to education.gaiahealers.com for actual course videos, community discussions, or portal login.',
  },
  signIn: 'In-app sign-in: on Home use Member access, or open the top Menu and tap Member sign in. Enter your member email and receive a one-tap sign-in link by email; tapping it signs you into your member area. Course videos and community discussions live in the separate education.gaiahealers.com portal, which has its own login.',
  safety: [
    'Do not diagnose or make medical claims; give wellness guidance only.',
    'Never claim you saved, booked, bought, emailed, checked in, or changed anything — explain how the member can do it.',
    'Never invent course progress, scan numbers, community posts, prices, or personal history.',
    'Do not expose private system tokens or any other member data.',
  ],
};

function gaiaKnowledgePrompt() {
  const K = GAIA_KNOWLEDGE;
  return [
    `About Gaia Healers: ${K.brand}`,
    `Ecosystem (these are different sites — do not confuse them):\n- ${K.ecosystem.join('\n- ')}`,
    `What Gaia Healers offers:\n- ${K.services.join('\n- ')}`,
    `Devices & products:\n- ${K.devices.join('\n- ')}`,
    `Communities (8): ${K.communities.join(', ')}.`,
    `Membership: ${K.memberships}`,
    `Courses: ${K.courses.join('; ')}.`,
    `Event: ${K.event.name} — ${K.event.date}, ${K.event.venue}. ${K.event.positioning}.`,
    `The app: ${K.app.shell}`,
    `Screens:\n- ${K.app.screens.join('\n- ')}`,
    `Key features:\n- ${K.app.features.join('\n- ')}`,
    `Navigation: ${K.app.navigation}`,
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
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
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
const GHL_WORKFLOW_WEBHOOK_SECRET = String(process.env.GHL_WORKFLOW_WEBHOOK_SECRET || COURSES_SYNC_SECRET).trim();
const GHL_BACKFILL_SECRET = String(process.env.GHL_BACKFILL_SECRET || GHL_WORKFLOW_WEBHOOK_SECRET).trim();
const GHL_WEBHOOK_ED25519_PUBLIC_KEY = String(process.env.GHL_WEBHOOK_ED25519_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim();
if (COURSES_SYNC_SECRET.length < 32) {
  throw new Error('COURSES_SYNC_SECRET must be set and at least 32 characters.');
}
if (GHL_BACKFILL_SECRET.length < 32) {
  throw new Error('GHL_BACKFILL_SECRET must be set and at least 32 characters.');
}
let _coursesCache = null;
let _memberEntitlementsCache = null;

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

function emptyEntitlementStore() {
  return { version: 1, contacts: {}, processedWebhookIds: [], updatedAt: null };
}

function loadMemberEntitlements() {
  if (_memberEntitlementsCache) return _memberEntitlementsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMBER_ENTITLEMENTS_FILE, 'utf8'));
    _memberEntitlementsCache = {
      ...emptyEntitlementStore(), ...parsed,
      contacts: parsed?.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {},
      processedWebhookIds: Array.isArray(parsed?.processedWebhookIds) ? parsed.processedWebhookIds : [],
    };
  } catch (_) {
    _memberEntitlementsCache = emptyEntitlementStore();
  }
  return _memberEntitlementsCache;
}

function saveMemberEntitlements(store) {
  store.updatedAt = new Date().toISOString();
  store.processedWebhookIds = uniqueStrings(store.processedWebhookIds || []).slice(-5000);
  writeJsonAtomic(MEMBER_ENTITLEMENTS_FILE, store);
  _memberEntitlementsCache = store;
}

function entitlementForContact(contactId) {
  const id = String(contactId || '').trim();
  return id ? loadMemberEntitlements().contacts[id] || null : null;
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

function catalogCourseIsPublic(course = {}) {
  if (course.deletedAt) return false;
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
  console.log('[Gaia Courses] sync received', { raw: normalized.length, deduped: courses.length, hidden: hiddenCount, syncedAt: payload.syncedAt });
  sendJson(res, 200, { ok: true, count: courses.length, rawCount: normalized.length, hidden: hiddenCount, syncedAt: payload.syncedAt }, origin);
}

// GET /api/courses — public catalog for the app to render.
async function coursesList(req, res, origin) {
  const data = loadCourses();
  sendJson(res, 200, {
    ok: true,
    courses: data.courses || [],
    syncedAt: data.syncedAt || null,
    count: (data.courses || []).length,
    source: data.source || 'none',
    stale: data.syncedAt ? (Date.now() - new Date(data.syncedAt).getTime()) > 48 * 60 * 60 * 1000 : true,
  }, origin);
}

function memberWebhookAuthorized(req, rawBody) {
  const suppliedSecret = String(req.headers['x-webhook-secret'] || req.headers['x-sync-secret'] || '').trim();
  if (GHL_WORKFLOW_WEBHOOK_SECRET.length >= 32 && safeSecretEqual(suppliedSecret, GHL_WORKFLOW_WEBHOOK_SECRET)) {
    return 'workflow-secret';
  }
  const suppliedSignature = String(req.headers['x-ghl-signature'] || '').trim();
  if (GHL_WEBHOOK_ED25519_PUBLIC_KEY && suppliedSignature) {
    try {
      const signature = /^[a-f0-9]{128}$/i.test(suppliedSignature)
        ? Buffer.from(suppliedSignature, 'hex')
        : Buffer.from(suppliedSignature, 'base64');
      if (crypto.verify(null, Buffer.from(rawBody, 'utf8'), GHL_WEBHOOK_ED25519_PUBLIC_KEY, signature)) return 'ghl-ed25519';
    } catch (err) {
      console.warn('[Gaia Entitlements] signature verification failed', { error: err.message.split('\n')[0] });
    }
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
  return { id: id || courseGroupKey(name), name, openUrl };
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
  if (/tier|membership/.test(raw)) return { kind: 'tier', grant: !/(remove|cancel|expire|revoke)/.test(raw), raw };
  const resourceType = firstNonEmptyString(body.resourceType, body.data?.resourceType).toLowerCase();
  const action = firstNonEmptyString(body.action, body.data?.action).toLowerCase();
  if (['course', 'offer'].includes(resourceType)) return { kind: 'course', grant: !/(remove|revoke|delete|cancel)/.test(action), raw };
  if (['community', 'group'].includes(resourceType)) return { kind: 'community', grant: !/(remove|revoke|delete|cancel)/.test(action), raw };
  return { kind: '', grant: null, raw };
}

async function memberAccessWebhook(req, res, origin) {
  let rawBody = '';
  try { rawBody = await readRawBody(req, 512 * 1024); }
  catch (_) { sendJson(res, 413, { ok: false, error: 'Request body is too large.' }, origin); return; }
  const authMethod = memberWebhookAuthorized(req, rawBody);
  if (!authMethod) {
    console.warn('[Gaia Entitlements] webhook rejected: invalid authentication');
    sendJson(res, 403, { ok: false, error: 'Invalid webhook authentication.' }, origin);
    return;
  }
  let body;
  try { body = rawBody ? JSON.parse(rawBody) : {}; }
  catch (_) { sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' }, origin); return; }

  const contactId = firstNonEmptyString(nestedValue(body, 'contactId', 'contact_id'), body.contact?.id, body.data?.contact?.id);
  if (!contactId) { sendJson(res, 422, { ok: false, error: 'contactId is required.' }, origin); return; }
  const event = classifyEntitlementEvent(body);
  if (!event.kind) { sendJson(res, 422, { ok: false, error: 'Unsupported entitlement event type.' }, origin); return; }

  const webhookId = firstNonEmptyString(req.headers['x-ghl-webhook-id'], body.webhookId, body.idempotencyKey, body.eventId);
  const store = loadMemberEntitlements();
  if (webhookId && store.processedWebhookIds.includes(webhookId)) {
    sendJson(res, 200, { ok: true, duplicate: true, contactId }, origin);
    return;
  }
  const now = new Date().toISOString();
  const record = store.contacts[contactId] || { contactId, tags: [], tier: null, courses: [], communities: [], subscriptions: [], domainUpdatedAt: {}, updatedAt: now };
  record.tags = uniqueStrings(record.tags || []);
  record.courses = Array.isArray(record.courses) ? record.courses : [];
  record.communities = Array.isArray(record.communities) ? record.communities : [];
  record.subscriptions = Array.isArray(record.subscriptions) ? record.subscriptions : [];
  record.domainUpdatedAt = record.domainUpdatedAt && typeof record.domainUpdatedAt === 'object' ? record.domainUpdatedAt : {};

  if (event.kind === 'tags') {
    const tags = body.tags || body.contact?.tags || body.data?.tags || body.data?.contact?.tags;
    if (Array.isArray(tags)) record.tags = uniqueStrings(tags);
  } else if (event.kind === 'tier') {
    const tier = normalizeTierName(nestedValue(body, 'tier', 'membershipTier', 'membership'));
    record.tier = event.grant && tier ? { name: tier, matchedBy: `webhook:${event.raw || 'tier'}`, updatedAt: now } : null;
  } else {
    const resource = normalizeEntitlementResource(body, event.kind);
    if (!resource.id && !resource.name) { sendJson(res, 422, { ok: false, error: `${event.kind} id or name is required.` }, origin); return; }
    const listName = event.kind === 'course' ? 'courses' : 'communities';
    const list = record[listName];
    const match = (item) => (resource.id && String(item.id) === String(resource.id))
      || (resource.name && String(item.name || '').toLowerCase() === resource.name.toLowerCase());
    const index = list.findIndex(match);
    if (event.grant) {
      const item = { id: resource.id, name: resource.name, state: 'unlocked', openUrl: resource.openUrl, matchedBy: `webhook:${event.raw}`, updatedAt: now };
      if (index >= 0) list[index] = { ...list[index], ...item };
      else list.push(item);
    } else if (index >= 0) {
      list.splice(index, 1);
    }
  }

  const eventDomain = event.kind === 'course' ? 'courses'
    : (event.kind === 'community' ? 'communities' : event.kind);
  record.domainUpdatedAt[eventDomain] = now;
  record.updatedAt = now;
  store.contacts[contactId] = record;
  if (webhookId) store.processedWebhookIds.push(webhookId);
  try { saveMemberEntitlements(store); }
  catch (err) {
    console.error('[Gaia Entitlements] save failed', { error: err.message.split('\n')[0] });
    sendJson(res, 500, { ok: false, error: 'Unable to persist entitlement update.' }, origin);
    return;
  }
  console.log('[Gaia Entitlements] access updated', { contactId, event: event.raw, kind: event.kind, grant: event.grant, authMethod });
  sendJson(res, 200, { ok: true, contactId, kind: event.kind, grant: event.grant, updatedAt: now }, origin);
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
    || 'Gaia member',
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

function createMemberSession(identity = {}, source = 'auth') {
  const member = normalizeMemberIdentity({ ...identity, source });
  const exp = Date.now() + (AUTH_SESSION_TTL_SECONDS * 1000);
  return {
    sub: member.memberId || member.contactId || member.email || member.displayName,
    member,
    source,
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
        displayName: ghlMember.member?.displayName || 'Gaia member',
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
        name: academy.member?.name || 'Gaia member',
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
        displayName: hub.member?.displayName || 'Gaia member',
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
</head><body><main class="card"><h1 id="title">Signing you in</h1><p id="status">Verifying your Gaia membership…</p><p id="loader" aria-hidden="true" style="margin-top:20px"><span class="dot"></span><span class="dot"></span><span class="dot"></span></p></main>
<script nonce="${nonce}">(async()=>{const fallback=${fallback};const status=document.getElementById('status');const title=document.getElementById('title');const loader=document.getElementById('loader');const fragment=new URLSearchParams(location.hash.slice(1));const token=fragment.get('gaia_magic')||'';history.replaceState({},'',location.pathname);if(!token){title.textContent='Sign-in link unavailable';status.innerHTML='Return to <a href="'+fallback+'">Gaia Healers</a> and request a new link.';loader.hidden=true;return}try{const response=await fetch('/api/auth/magic-link/consume',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},credentials:'include',body:JSON.stringify({token})});const data=await response.json();if(!response.ok||!data.authenticated)throw new Error(data.error||'This link could not be verified.');status.textContent='Verified. Opening your Gaia…';location.replace(data.returnTo||fallback)}catch(error){title.textContent='Please request a new link';status.textContent=error.message||'This sign-in link is invalid or expired.';loader.hidden=true;}})();</script></body></html>`;
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
// Gaia member (existing GHL contact with membership / community / product
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
    'all-gaia': 'https://education.gaiahealers.com/gaia-healers-community', // confirmed
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
      name: member.displayName || member.name || 'Gaia member',
      email: member.email || '',
      practitioner,
      practitionerCertified: certified,
      membershipTier,
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

async function memberAccess(req, res, origin) {
  const sessionMember = sessionMemberContext(req);
  if (!sessionMember) {
    sendJson(res, 401, { ok: false, authenticated: false, reason: 'auth_required', error: 'Sign in to view your access.' }, origin);
    return;
  }
  let tags = Array.isArray(sessionMember.tags) ? sessionMember.tags : [];
  let customFields = [];
  let liveMember = sessionMember;
  let live = false;
  let entitlements = entitlementForContact(sessionMember.contactId || sessionMember.memberId);
  let subscriptions = [];
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
  }
  const access = buildMemberAccess(tags, customFields, liveMember, entitlements, subscriptions);
  sendJson(res, 200, {
    ok: true,
    authenticated: true,
    source: live ? 'ghl-live' : 'session-fallback',
    generatedAt: new Date().toISOString(),
    ...access,
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
      name: b.member.displayName || b.member.name || 'Gaia member',
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
  if (!requireSessionMember(req, res, origin)) return;
  sendJson(res, 200, placeholderEnvelope('Community/live-session events live in GHL Communities (no API). Member 1:1 bookings are live at /api/member/appointments.', { events: [] }), origin);
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
    'Be proactive and specific: ask one short intent question when needed, tell them exactly where to go (for example "Open the Store and tap Membership" or "Go to Community to find a healer"), and after each answer or tool action offer the natural next step.',
    'You can help with anything in the app: Home (the dynamically fetched next event and member access), Energy (public birth-date chakra chart and interactive seven-centre guide), Academy (courses via the education portal), Community (which communities are unlocked and Find a Practitioner), Store (Shop and the official Gaia 2.0 Free/Silver/Gold/Diamond membership paths), and Profile (account, devices, purchases, bookings, founder access, and the colour test). If you are unsure of a live number or detail, say so plainly instead of inventing one.',
    'Keep members in-app first. Course videos and community discussions open the separate education.gaiahealers.com portal, which has its own login — mention it only when they want the actual lessons or discussions, or need to sign in.',
    'Never narrate your reasoning, planning, hidden analysis, or drafting process. Do not say phrases like "I have crafted", "I am refining", or "finalizing".',
    'When asked to say exact words, say only those words and no extra explanation.',
    'Never claim you saved, booked, bought, imported, emailed, checked in, or changed anything. Explain how the member can do it instead.',
    'Do not diagnose or make medical claims.',
    'You have a navigate tool. When a member asks to go to, open, show, see, or view a specific screen, tab, or feature — call the navigate tool to actually move them there. Examples: "show today’s event" → navigate(screen=today); "open my energy chart" → navigate(screen=wellness); "take me to my courses" → navigate(screen=academy); "open the store" → navigate(screen=store); "show me membership options" → navigate(screen=store, tab=membership); "go to my profile" → navigate(screen=profile); "find a practitioner" → navigate(screen=community). Navigation is the start of helping on that screen, not the finish: point out what is now available and keep listening.',
    'You also have action tools. Use them to actually do things for the member, not just describe how. book_session: when the member asks to book, schedule, or reserve something — "book a call with Dr. Nima" or "I want to meet the founder" → book_session(session=nima); "book a Bio-Well scan" → book_session(session=scan); "I want a demo" → book_session(session=demo); "book a discovery call" → book_session(session=discovery); "schedule coaching" → book_session(session=coaching). It opens the real booking form (Nima uses Calendly, the others use GHL widgets); tell them to complete it there. open_community: when the member asks to open or visit a community — "open the Bio-Well community" → open_community(community=biowell); "take me to BioPulsar" → open_community(community=biopulsar); "all gaia healers group" → open_community(community=all-gaia). Some open directly, others open in the portal. open_portal: when the member wants the portal itself — "open the portal" → open_portal(section=home); "open my courses in the portal" → open_portal(section=courses); "portal login" → open_portal(section=login). sign_in: when the member says they want to sign in, log in, or access their account and they are not signed in — "sign me in" → sign_in(). Never call sign_in if the member is already signed in. After ANY action tool, STAY ENGAGED: confirm what you opened, then guide them through the next step and keep listening. Do not go silent after opening something — the conversation continues until the member says goodbye.',
    'This is an ongoing conversation, not a single request-response. After every action — navigating, opening a booking form, opening a community, signing in — you are STILL their assistant on that screen. Keep helping: point out what they can do, answer follow-ups, navigate elsewhere if asked, and only go quiet when the member clearly ends the conversation. Never end your turn with just a confirmation and silence; end with either a useful observation about what is now on screen, or a concrete next step they can take, or a question.',
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
    if (paid.length || subs.length) lines.push(`Account: ${paid.length} completed purchase(s), ${subs.length} subscription(s) on file. Do NOT say amounts, prices, or card details out loud.`);
    if (upcoming.length) lines.push(`Has ${upcoming.length} upcoming appointment(s) booked.`);
    if (formSubs.length || surveySubs.length) lines.push(`Has submitted ${formSubs.length} form(s) and ${surveySubs.length} survey(s).`);
    if (unread) lines.push(`Has ${unread} unread message(s) in their Gaia Healers conversations.`);

    lines.push('WHAT YOU CAN SEE: their profile, memberships/communities, products/devices, purchases & subscriptions (counts only), appointments, forms/surveys submitted, and conversation notifications.');
    lines.push('WHAT YOU CANNOT SEE: individual course lesson progress or community post/discussion content — the backend does not expose these. If asked about a specific lesson, grade, community post, or a detailed scan reading, say plainly that you can OPEN the course or community in the portal but cannot read the lesson/post details from here, and offer to take them there. NEVER invent progress, grades, posts, scan numbers, or history.');
    lines.push('Privacy: discuss only THIS member’s own data, and only when they ask about it. Do not proactively recite sensitive details.');

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
  const eventId = process.env.EVENT_MANAGER_EVENT_ID || '';
  if (!base) {
    return {
      ...FALLBACK_GAIA.event,
      source: 'not-connected',
      liveData: false,
      note: 'Event Manager endpoint is not configured.',
    };
  }

  const headers = {};
  if (process.env.EVENT_MANAGER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EVENT_MANAGER_TOKEN}`;
  }

  let event;
  try {
    event = await fetchJson(`${base}/public/events/next`, headers);
  } catch (error) {
    // Transitional fallback for older Event Manager deployments only. Once the
    // dynamic endpoint exists, Home no longer depends on a pinned event id.
    if (!eventId) throw error;
    event = await fetchJson(`${base}/public/events/${encodeURIComponent(eventId)}`, headers);
  }
  return {
    id: `event-${event.id || eventId || 'next'}`,
    name: event.name || FALLBACK_GAIA.event.name,
    date: event.start_date && event.end_date ? `${event.start_date} - ${event.end_date}` : FALLBACK_GAIA.event.date,
    startDate: event.start_date || null,
    endDate: event.end_date || null,
    description: event.description || '',
    venue: event.location || FALLBACK_GAIA.event.venue,
    location: event.location || FALLBACK_GAIA.event.location,
    sourceUrl: event.source_url || 'https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page',
    source: 'event-manager',
    liveData: true,
    stats: {
      attendees: event.attendee_count || 0,
      paidMembers: 0,
      checkedIn: event.checked_in_count || 0,
      exhibitors: 0,
      leads: 0,
      checkInRate: event.attendee_count ? Math.round(((event.checked_in_count || 0) / event.attendee_count) * 100) : 0,
    },
  };
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
    || FALLBACK_ACADEMY.courses[2];
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
      name: String(payload.member?.name || payload.contact?.name || 'Gaia member'),
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
      displayName: String(payload.member?.displayName || payload.member?.name || 'Gaia member'),
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
        name: member.member.displayName || 'Gaia member',
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
      name: !currentName || currentName === 'Gaia member' ? (memberContext.displayName || 'Gaia member') : currentName,
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
      displayName: !currentName || currentName === 'Gaia member' ? (memberContext.displayName || 'Gaia member') : currentName,
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
    getEventSummary().catch((error) => ({ ...FALLBACK_GAIA.event, source: 'event-manager-error', liveData: false, error: error.message })),
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
        name: 'Gaia member',
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
        description: 'Sign in with your Gaia portal account to unlock your own course progress, certificates, and gated lessons.',
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
        displayName: 'Gaia member',
        role: 'Member',
        cohort: 'Client portal',
        portalUrl: GHL_CLIENT_PORTAL_BASE_URL || FALLBACK_MEMBER_HUB.portal.url,
      },
      dashboard: {
        ...(memberHubScoped.dashboard || {}),
        welcomeTitle: 'Your Gaia dashboard is ready',
        welcomeDetail: 'Sign in once to load your own courses, communities, products, and certificates inside the app.',
        topCourse: 'Secure Academy workspace',
        topCourseMeta: 'Member login unlocks your course progress',
        nextLessonTitle: 'Log in to continue your live lessons',
        eventPassTitle: event?.shortName || 'Elevate 2026',
        eventPassDetail: 'Badge ops ready',
        ceCreditsEarned: 0,
        ceCreditsRequired: FALLBACK_ACADEMY.summary.ceCreditsRequired,
      },
      access: {
        notes: [
          'Public app shell is ready.',
          'Member-specific courses, purchases, communities, and certificates unlock after Gaia portal login.',
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

  const genericResponse = {
    ok: true,
    delivery: 'email-if-member',
    message: 'If this email belongs to a Gaia member, a secure sign-in link will arrive shortly.',
    expiresInSeconds: AUTH_MAGIC_LINK_TTL_SECONDS,
  };

  const member = await resolveMemberRecord({
    email,
    memberId: body.memberId || body.contactId || '',
    contactId: body.contactId || body.memberId || '',
  });

  if (!member) {
    // Do not reveal whether an email exists in GHL.
    sendJson(res, 200, genericResponse, origin);
    return;
  }

  const token = signTokenPayload({
    type: 'magic-link',
    member,
    returnTo,
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
      sendJson(res, 200, genericResponse, origin);
      return;
    }
    if (!AUTH_ALLOW_DEBUG_LINKS) {
      console.error('[Gaia Auth] magic-link delivery failed', { reason: sent.reason || 'ghl_error', contactId: member.contactId });
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

  console.error('[Gaia Auth] magic-link delivery unavailable', { contactId: member.contactId || '' });
  sendJson(res, 200, genericResponse, origin);
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
  const session = createMemberSession(payload.member, 'magic-link');
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

async function authEmbeddedClaim(req, res, origin) {
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

  const session = createMemberSession(member, 'ghl-embedded-claim');
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
  if (normalized.includes('book') || normalized.includes('scan') || normalized.includes('appointment') || normalized.includes('session') || normalized.includes('demo')) {
    return 'You can book a session from the Home screen — there are options for a Bio-Well energy scan, a Bio-Well demo, a free discovery call, and wellness coaching. Want me to point you to the right one?';
  }
  if (normalized.includes('chakra') || normalized.includes('wellness') || normalized.includes('energy') || normalized.includes('chart') || normalized.includes('colour') || normalized.includes('color')) {
    return 'Open Energy for the public birth-date chakra chart and interactive seven-centre guide. The Colour Personality Test is in Profile. Which would you like?';
  }
  if (normalized.includes('community') || normalized.includes('membership') || normalized.includes('healer') || normalized.includes('practitioner')) {
    return 'Community shows which Gaia circles you have unlocked and links to the practitioner directory. The Store’s Membership tab shows the official Free, Silver, Gold, and Diamond Gaia 2.0 paths and opens enrolment inside the app. Want me to guide you there?';
  }
  if (normalized.includes('course') || normalized.includes('academy') || normalized.includes('certification') || normalized.includes('login') || normalized.includes('sign in') || normalized.includes('portal')) {
    return 'Academy has your courses — the lessons open in the education.gaiahealers.com portal, which has its own login. To sign in to the app, tap Sign in and use the one-tap link we email to your member address.';
  }
  if (normalized.includes('store') || normalized.includes('shop') || normalized.includes('buy') || normalized.includes('product') || normalized.includes('device') || normalized.includes('price')) {
    return 'The Store has a Shop tab (Bio-Well and devices, Colour Energy sprays, crystals, courses) where prices and checkout live on the Gaia Healers shop, plus a Membership tab. What are you looking for?';
  }
  if (normalized.includes('event') || normalized.includes('elevate') || normalized.includes('conference')) {
    return 'The Gaia Healers Elevate Conference 2026 is November 20-22 at Rosen Shingle Creek in Orlando. You can see it on the Home screen and register from there.';
  }
  return 'I can help with Home events, Energy guidance, Academy courses, Community, Gaia 2.0 membership, the Store, Profile, practitioners, bookings, or meeting the founder. What would you like to do?';
}

function assistSystemPrompt(memberContext = '') {
  return [
    'You are Gaia Assist, the smart concierge for the Gaia Healers mobile app. You guide first-time visitors and signed-in members from arrival through their next useful step.',
    memberContext
      ? 'This is a signed-in member. Personalize only from the supplied member context. Treat active GHL subscriptions/offers as primary tier evidence and tags as secondary. Show courses and communities only from exact GHL entitlements; never infer them from tier.'
      : 'This is a visitor unless they say otherwise. Help them explore, join free, compare memberships, sign in with their GHL-contact email, find a practitioner, or book a session. Never imply they already own access.',
    'Answer with deep, accurate awareness of the Gaia Healers app screens and features, the products and devices, the communities and membership, the courses, the events, and the store.',
    'The app can run embedded inside the Gaia Healers GHL menu. Keep users inside the app first: bottom Home for the next event and member access, Energy for public chakra guidance, Store for shop and membership, Profile for account and bookings; top Menu for Academy, Community, Membership, Meet the Founder, Find a Practitioner, and sign-in. Course videos and community discussions open the education.gaiahealers.com portal, which has its own login.',
    'When asked how to do something, name the exact screen and step. Never invent course progress, scan numbers, community posts, prices, or personal history.',
    'Never claim that you saved, imported, checked in, emailed, booked, purchased, or changed data. Explain how the member can do it.',
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

async function callChatProvider(provider, prompt, context = {}) {
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
    if (req.method === 'GET' && url.pathname === '/api/courses') {
      await coursesList(req, res, origin);
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
      });
      return;
    }
    if (url.pathname.startsWith('/api/wellness/')) {
      await wellnessRouter.handle(req, res, url, {
        origin, sendJson, readJsonBody, signTokenPayload, readSignedToken, parseCookies, aiComplete, ghlUpsertContact, memberLookup: wellnessMemberLookup,
      });
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
      await memberAccess(req, res, origin);
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
    // so every request must carry a valid Gaia member session cookie.
    if (url.pathname.startsWith('/api/assist/')) {
      /* Gaia Assist is open to all visitors (member or not); nginx rate-limits /api/assist/ for quota protection. Sign-in gate disabled per product decision. */
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/chat') {
      const body = await readJsonBody(req);
      const memberContext = await buildMemberVoiceContext(req);
      const payload = await assistChat({ ...body, source: body.source || 'chat', memberContext });
      sendJson(res, payload.ok === false ? 400 : 200, payload, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/chat/stream') {
      const body = await readJsonBody(req);
      const memberContext = await buildMemberVoiceContext(req);
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
});
