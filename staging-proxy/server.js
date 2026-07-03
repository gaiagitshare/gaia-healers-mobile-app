import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
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
  brand: 'Gaia Healers',
  publicWebsite: 'https://gaiahealers.com',
  clientPortal: 'https://education.gaiahealers.com',
  crm: {
    observedLocationId: 'WkKl1K5RuZNQ60xR48k6',
    configuredLocationId: process.env.GHL_LOCATION_ID || '',
    customMenuLink: 'https://crm.gaiahealers.com/v2/location/WkKl1K5RuZNQ60xR48k6/custom-menu-link/328efaea-4e94-42ec-9ce2-4358a64657db',
    embeddedAppUrl: 'https://gaiahealers.app/home.html?store=1&embedded=ghl',
    sections: ['Client Portal', 'Courses', 'Communities', 'Credentials', 'Gokollab Marketplace', 'Marketing', 'Automation', 'Calendars', 'Contacts', 'Custom Menu Links'],
    clientPortalUsers: 1252,
    adminActions: ['generate magic link', 'invite to client portal', 'send login email'],
    embeddedRule: 'When the app is embedded in GHL, keep users inside the Gaia app first. Route course questions to Academy, discussions/members/events/newsletter to Community, and account/login issues to Profile. Mention external client portal login only when the user asks to open gated portal content or needs identity verification.',
  },
  services: [
    'Bio-Well practitioner certification and advanced biofield analysis',
    'BioPulsar aura and chakra education',
    'BioTekna nervous-system and stress-mapping education',
    'Healeex onboarding and practitioner calls',
    'Quantum sound therapy and frequency-based optimization education',
    'Continuing education, CE credits, live labs, and credentials',
    'Practitioner communities, discussion boards, mentoring, and wins wall',
    'Elevate 2026 event registration, badges, check-in, exhibitors, and lead retrieval',
    'GHL follow-up workflows, newsletters, marketing segments, and client portal login',
  ],
  devices: [
    'Bio-Well 3.0 wellness and stress assessment device',
    'Bio-Well Sputnik accessory for environmental and object energy measurements',
    'Bio-Well Glove, Water Sensor, and Bio Cor support channels',
    'BioPulsar aura/chakra reporting tools',
    'BioTekna nervous-system technology',
    'HeartMath-style coherence monitor products',
    'Sacred geometry and wellness marketplace products',
  ],
  communities: [
    '[Start Here] All Gaia Healers: public, 254 members, 28 posts, channels Home, Start Here, Healers Lounge, Ask A Mentor, Wins Wall',
    'Bio-Well Practitioners: public, 381 members, 11 posts, channels Orientation, Tech Support, Case Studies, Bio Cor, Bio-Well, Glove, Sputnik, Water Sensor, Leaderboard',
    'BioPulsar Practitioners: public, 507 members, aura and chakra practitioner support',
    'Biotekna Practitioners: public, 154 members, nervous-system and device education',
    'Healeex: public, 31 members, onboarding, calls, and protocols',
    'The Abundant Healer Collective: private, 117 members, mentorship and coaching',
  ],
  courses: [
    'BIO-WELL Orientation',
    'BIO-WELL Basic Certification',
    'Bio-Well Advanced Level 1',
    'Gaia Healers Advanced Level 2',
    'BioPulsar Basic Technical & Business',
    'BioTekna live trainings',
    'Healeex Getting Started',
    '9-Week Chakra Challenge',
  ],
  event: {
    name: 'Gaia Healers Elevate 2026',
    date: 'November 20-22, 2026',
    venue: 'Rosen Shingle Creek, Orlando, FL',
    positioning: 'three-day integrative wellness conference bridging ancient healing traditions and cutting-edge science',
    operations: ['GHL registration', 'QR badges', 'check-in', 'exhibitor leads', 'attendee import', 'hotel room block', 'speaker/exhibitor/volunteer interest'],
  },
  // Full map of the in-app screens so Gaia can answer about anything in the app
  // and tell the member exactly where to tap. The app is a single-page shell at
  // home.html; screens are opened via home.html?view=<view> (and &tab=<tab>).
  app: {
    shell: 'The app is home.html with a bottom tab bar: Today, Wellness, [Gaia orb = you], Community. Profile and Log in are top-right. The center orb opens you (Gaia Assist voice).',
    screens: [
      'Today (view=today): home dashboard. Shows Bio-Well readiness snapshot, today\'s chakra focus, Elevate badge status, a Gaia Assist insight card, and quick actions. Entry point for the day.',
      'Wellness (view=wellness): two tabs — Bio-Well (tab=biowell): energy/readiness index, scan history, energy trends, device offers; and Chakras (tab=chakras): chakra + body-point map and chakra trends. This is where Bio-Well scans, energy index, and chakra data live.',
      'Academy (view=academy): courses and modules, certification roadmap, current course progress (e.g. Advanced Level 1), documented practicum scans, CE credits, live labs, and the Level 1 proctored exam. Send course/certification/study-plan questions here.',
      'Community (view=community): five tabs — Discussion (feed and channels), Learning (group courses), Events (community calendar + Elevate), Members (directory + leaderboard), Newsletter (subscription toggles). Groups: [Start Here] All Gaia Healers, Bio-Well, BioPulsar, Biotekna, Healeex, and the private Abundant Healer Collective.',
      'Profile (view=profile): account and membership, client-portal sign-in (magic link / login email), memberships, and store/marketplace (Gokollab). Send account, login, and purchase questions here.',
      'Admin (view=admin, admin-only): operator cockpit — GHL sync map, approval-before-writes gates, audit log, capability registry, and AI controls. Only mention to admins.',
    ],
    navigation: 'To guide someone, name the screen and tab plainly, e.g. "Open Wellness, Bio-Well tab" or "Go to Community, Events tab." Deep links look like home.html?view=community&tab=events. Prefer keeping members inside the app; only send them to the external client portal for gated content or identity verification.',
  },
  safety: [
    'Do not diagnose or make medical claims.',
    'Never claim that data was saved, imported, checked in, emailed, or changed.',
    'For admin actions, draft and ask for confirmation first.',
    'Do not expose private GHL, OpenAI, Groq, OpenRouter, Event Manager, or ElevenLabs tokens.',
  ],
};

function gaiaKnowledgePrompt() {
  return [
    `Gaia ecosystem knowledge: ${GAIA_KNOWLEDGE.brand}. Website ${GAIA_KNOWLEDGE.publicWebsite}. Client portal ${GAIA_KNOWLEDGE.clientPortal}.`,
    `GHL/CRM: observed location ${GAIA_KNOWLEDGE.crm.observedLocationId}; configured location ${GAIA_KNOWLEDGE.crm.configuredLocationId || 'not set'}; custom menu ${GAIA_KNOWLEDGE.crm.customMenuLink}; embedded app ${GAIA_KNOWLEDGE.crm.embeddedAppUrl}; sections ${GAIA_KNOWLEDGE.crm.sections.join(', ')}; ${GAIA_KNOWLEDGE.crm.clientPortalUsers} portal users; admin actions ${GAIA_KNOWLEDGE.crm.adminActions.join(', ')}.`,
    `GHL embedded app rule: ${GAIA_KNOWLEDGE.crm.embeddedRule}`,
    `Services: ${GAIA_KNOWLEDGE.services.join('; ')}.`,
    `Devices and products: ${GAIA_KNOWLEDGE.devices.join('; ')}.`,
    `Communities: ${GAIA_KNOWLEDGE.communities.join('; ')}.`,
    `Courses: ${GAIA_KNOWLEDGE.courses.join('; ')}.`,
    `Event: ${GAIA_KNOWLEDGE.event.name}, ${GAIA_KNOWLEDGE.event.date}, ${GAIA_KNOWLEDGE.event.venue}; ${GAIA_KNOWLEDGE.event.positioning}; ops ${GAIA_KNOWLEDGE.event.operations.join(', ')}.`,
    `App layout: ${GAIA_KNOWLEDGE.app.shell}`,
    `App screens:\n- ${GAIA_KNOWLEDGE.app.screens.join('\n- ')}`,
    `In-app navigation: ${GAIA_KNOWLEDGE.app.navigation}`,
    `Safety rules: ${GAIA_KNOWLEDGE.safety.join(' ')}`,
  ].join('\n');
}

function corsHeaders(origin) {
  const allowOrigin = origin
    ? (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) ? origin : 'null')
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

const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || 'Puck';
const GEMINI_LIVE_MAX_SECONDS = clampNumber(
  Number(process.env.GEMINI_LIVE_MAX_SECONDS || 300),
  30,
  900,
  300,
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
  return process.env.AUTH_SESSION_SECRET
    || process.env.APP_PROXY_SHARED_SECRET
    || process.env.GHL_API_TOKEN
    || 'gaia-staging-session-secret';
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
  }

  if (!contactPayload && normalizedEmail) {
    const candidates = [
      await ghlGet('/contacts', { locationId: cfg.locationId, query: normalizedEmail, limit: 20 }),
      await ghlGet('/contacts', { locationId: cfg.locationId, email: normalizedEmail, limit: 20 }),
    ];
    for (const candidate of candidates) {
      const list = candidate?.contacts
        || candidate?.data?.contacts
        || candidate?.data
        || candidate?.results
        || [];
      if (!Array.isArray(list) || !list.length) continue;
      const exact = list.find((item) => String(item.email || '').trim().toLowerCase() === normalizedEmail) || list[0];
      if (exact) {
        contactPayload = exact;
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
    { id: 'all-gaia',  name: 'All Gaia Healers',           matchTags: ['community-active', 'community-starthere-access'] },
    { id: 'biowell',   name: 'Bio-Well Practitioners',     matchTags: ['community-biowell-member'] },
    { id: 'biopulsar', name: 'BioPulsar Practitioners',    matchTags: ['community-biopulsar-member'] },
    { id: 'biotekna',  name: 'Biotekna Practitioners',     matchTags: ['community-biotekna-member'] },
    { id: 'healeex',   name: 'HealeeX Community',           matchTags: [], placeholder: true },
    { id: 'abundant',  name: 'Abundant Healer Collective',  matchTags: [], placeholder: true },
  ],
  productOwnerPattern: /^product_(.+)_owner$/i,
  productNames: {
    biowell: 'Bio-Well', biowell_biocor: 'Bio-Well BioCor', biowell_sputnik: 'Bio-Well Sputnik',
    biowell_water: 'Bio-Well Water Sensor', biowell_water_sensor: 'Bio-Well Water Sensor',
    biopulsar: 'BioPulsar', biotekna: 'BioTekna', braintap: 'BrainTap', healy: 'Healy',
    asea: 'ASEA', lifewave: 'LifeWave', ans_control: 'ANS Control', bia: 'BIA', heg: 'HEG',
  },
  membershipTierTags: { membership_silver: 'Silver', 'silver-membership': 'Silver' },
  practitionerCertifiedTags: ['bio-well certified practitioner'],
  practitionerTags: ['bio-well practitioner', 'gaiapractitioner', 'gaia practitioner directory', 'goldenpractitionermember', 'gaia_practitioner_form_complete'],
  // Access-like tags used to surface "unknown access" the catalog did not map.
  accessLikePatterns: [/^community[-_]/i, /_owner$/i, /^membership/i, /-membership$/i, /-member$/i, /^enrolled/i, /course/i],
};

function friendlyProductName(slug) {
  const key = String(slug || '').toLowerCase();
  if (ACCESS_CATALOG.productNames[key]) return ACCESS_CATALOG.productNames[key];
  return key.split(/[_-]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function buildMemberAccess(rawTags = [], customFields = [], member = {}) {
  const tags = uniqueStrings((rawTags || []).map((t) => String(t || '').trim()).filter(Boolean));
  const lower = new Map(tags.map((t) => [t.toLowerCase(), t]));
  const has = (tag) => lower.has(String(tag).toLowerCase());
  const matched = new Set();

  const unlocked = [];
  const locked = [];
  for (const c of ACCESS_CATALOG.communities) {
    if (c.placeholder || !c.matchTags.length) {
      locked.push({ id: c.id, name: c.name, state: 'unknown', reason: 'Membership tag not configured yet — ask Gaia Healers to unlock this.', matchedBy: null });
      continue;
    }
    // Mark every present match tag as "known" (not just the first hit) so a
    // secondary signal like community-starthere-access isn't mislabeled unknown.
    c.matchTags.forEach((t) => { if (has(t)) matched.add(t.toLowerCase()); });
    const hit = c.matchTags.find((t) => has(t));
    if (hit) {
      unlocked.push({ id: c.id, name: c.name, state: 'unlocked', matchedBy: lower.get(hit.toLowerCase()) || hit });
    } else {
      locked.push({ id: c.id, name: c.name, state: 'locked', reason: 'Not included in your membership', matchedBy: null });
    }
  }

  const products = [];
  for (const t of tags) {
    const m = ACCESS_CATALOG.productOwnerPattern.exec(t);
    if (m) {
      matched.add(t.toLowerCase());
      products.push({ id: m[1].toLowerCase(), name: friendlyProductName(m[1]), owned: true, matchedBy: t });
    }
  }

  let membershipTier = null;
  for (const [tag, tier] of Object.entries(ACCESS_CATALOG.membershipTierTags)) {
    if (has(tag)) { membershipTier = tier; matched.add(tag.toLowerCase()); break; }
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
    },
    communities: { unlocked, locked },
    products,
    unknownAccessTags,
    counts: {
      unlocked: unlocked.length, locked: locked.length,
      products: products.length, unknown: unknownAccessTags.length, totalTags: tags.length,
    },
    customFieldsCount: Array.isArray(customFields) ? customFields.length : 0,
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
    }
  } catch (err) {
    console.error('[Gaia Access] live tag read failed', { error: err.message.split('\n')[0] });
  }
  const access = buildMemberAccess(tags, customFields, liveMember);
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
      return { resolved: true, member: v.member || sessionMember, tags: v.tags || [], customFields: v.customFields || [], contactId };
    }
  } catch (err) {
    console.error('[Gaia Member] bundle fetch failed', { error: err.message.split('\n')[0] });
  }
  return { resolved: false, member: sessionMember, tags: Array.isArray(sessionMember.tags) ? sessionMember.tags : [], customFields: [], contactId: sessionMember.contactId || sessionMember.memberId || '' };
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
  const access = buildMemberAccess(b.tags, b.customFields, b.member);
  sendJson(res, 200, memberEnvelope(b, {
    profile: {
      name: b.member.displayName || b.member.name || 'Gaia member',
      email: b.member.email || '',
      role: b.member.role || 'Member',
      cohort: b.member.cohort || '',
      practitioner: access.member.practitioner,
      practitionerCertified: access.member.practitionerCertified,
      membershipTier: access.member.membershipTier,
      bioWellSerial: customFieldValue(b.customFields, BIOWELL_SERIAL_FIELD_ID) || null,
      tagCount: b.tags.length,
      customFieldCount: Array.isArray(b.customFields) ? b.customFields.length : 0,
    },
  }), origin);
}

async function memberCommunities(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const access = buildMemberAccess(b.tags, b.customFields, b.member);
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
  return {
    id: String(a.id || ''),
    title: String(a.title || 'Appointment'),
    startTime: a.startTime || '',
    endTime: a.endTime || '',
    status: String(a.appointmentStatus || a.status || ''),
    calendarId: String(a.calendarId || ''),
    address: String(a.address || ''),
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
  sendJson(res, 200, { ...memberEnvelope(b, {}), source: 'ghl-live', appointments, count: appointments.length }, origin);
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
  const norm = (s, type) => ({ id: s.id, type, formId: s.formId || s.surveyId || '', name: s.name || '', email: s.email || '', submittedAt: s.createdAt || '' });
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

// Courses & community events remain impossible via GHL API (no endpoint).
async function memberCourses(req, res, origin) {
  const sm = requireSessionMember(req, res, origin); if (!sm) return;
  const b = await fetchMemberBundle(sm);
  const tagHints = b.tags.filter((t) => /course|enrolled/i.test(t));
  sendJson(res, 200, placeholderEnvelope('GHL exposes no Courses/LMS API — course enrollment and lesson progress cannot be read (verified: all course endpoints 404). Tag hints only.', { courses: [], tagHints }), origin);
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
    'You are Gaia Assist, the warm, knowledgeable voice concierge built into the Gaia Healers app. You know every screen and feature of this app and the whole Gaia ecosystem, and you help members get things done without leaving the app.',
    gaiaKnowledgePrompt(),
    memberContext,
    `The member is currently on the ${view} screen. Assume questions relate to what they are looking at unless they say otherwise, and tailor your help to that screen first.`,
    'Speak in a calm, friendly, natural voice, like a helpful friend on a phone call. Keep replies short: one or two sentences, then a quick question or a clear next step. Give more detail only when asked.',
    'Be proactive and specific: when a member asks for something, tell them exactly which screen and tab to open (e.g. "Open Wellness, Bio-Well tab" or "That is in Community, Events tab"), and offer the natural next step.',
    'You can answer anything about the app: Today dashboard, Wellness (Bio-Well readiness, energy index, scans, chakra map), Academy (courses, certification progress, practicum scans, CE, exams), Community (groups, discussion, events, members, newsletter), Profile (account, login, memberships, marketplace), Elevate 2026, and the device ecosystem. If you are unsure of a live number, say so plainly instead of inventing one.',
    'If the member mentions courses, login, client portal, or GHL, guide them to the internal screen first: Academy for courses, Community for discussions/events/members/newsletter, Profile for account and sign-in. Only mention the external client portal for gated content or identity verification.',
    'Never narrate your reasoning, planning, hidden analysis, or drafting process. Do not say phrases like "I have crafted", "I am refining", or "finalizing".',
    'When asked to say exact words, say only those words and no extra explanation.',
    'Never claim you saved, imported, emailed, checked in, or changed anything. Draft and ask for confirmation first.',
    'Do not diagnose or make medical claims.',
    'Greet the member warmly in one short sentence when the session starts, mention you can help with anything in the app, then listen.',
  ].filter(Boolean).join('\n');
}

// Builds a private, per-member context block from the signed-in session so Gaia
// can greet by name and speak to the member's own courses/progress. Returns ''
// for anonymous visitors (Gaia stays generic). Never throws — personalization
// must never block the voice token.
async function buildMemberVoiceContext(req) {
  try {
    const member = sessionMemberContext(req);
    if (!member) return '';
    const ctxUrl = withMemberContext(new URL('http://localhost'), member);
    const [academy, hub] = await Promise.all([
      getAcademyProgress(ctxUrl).catch(() => null),
      getMemberHub(ctxUrl, FALLBACK_ACADEMY).catch(() => null),
    ]);
    const firstName = String(member.displayName || academy?.member?.name || 'there').trim().split(/\s+/)[0];
    const lines = [
      'MEMBER CONTEXT (private — this is the signed-in member; use it to personalize, never read it aloud to anyone else):',
      `You are speaking with ${member.displayName || firstName}. Greet them by first name ("${firstName}").`,
    ];
    const roleCohort = [member.role, member.cohort].filter(Boolean).join(' · ');
    if (roleCohort) lines.push(`Their role/cohort: ${roleCohort}.`);
    if (academy?.summary) {
      const s = academy.summary;
      lines.push(`Their Academy progress: ${s.enrolled} courses enrolled, ${s.completed} completed, about ${s.averageProgress}% average. Next up: ${s.nextCourseTitle}${s.nextLessonTitle ? ` — ${s.nextLessonTitle}` : ''}. CE credits ${s.ceCreditsEarned}/${s.ceCreditsRequired}.`);
      lines.push(`(This progress data is ${academy.liveData ? 'live from the education system' : 'not yet live — treat as approximate and say so if asked for exact figures'}.)`);
    }
    if (hub?.member?.role && !roleCohort) lines.push(`Membership: ${hub.member.role}.`);
    lines.push('If the member asks about their courses, badge, or scans, use this context and point them to the exact screen (Academy, Wellness, Community, or Profile).');
    return lines.join('\n');
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
  if (!base || !eventId) {
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

  const event = await fetchJson(`${base}/public/events/${encodeURIComponent(eventId)}`, headers);
  return {
    id: `event-${event.id || eventId}`,
    name: event.name || FALLBACK_GAIA.event.name,
    date: event.start_date && event.end_date ? `${event.start_date} - ${event.end_date}` : FALLBACK_GAIA.event.date,
    venue: event.location || FALLBACK_GAIA.event.venue,
    location: event.location || FALLBACK_GAIA.event.location,
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

  const member = await resolveMemberRecord({
    email,
    memberId: body.memberId || body.contactId || '',
    contactId: body.contactId || body.memberId || '',
  });

  if (!member) {
    sendJson(res, 503, {
      ok: false,
      error: 'Member verification is not configured yet. Use the GHL portal login or launch the app from the embedded GHL portal.',
      code: 'member_verification_unavailable',
    }, origin);
    return;
  }

  const token = signTokenPayload({
    type: 'magic-link',
    member,
    returnTo,
    iat: Date.now(),
    exp: Date.now() + (AUTH_MAGIC_LINK_TTL_SECONDS * 1000),
  });
  const consumeUrl = `${PROXY_PUBLIC_URL}/api/auth/magic-link/consume?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(returnTo)}`;

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

  sendJson(res, 503, {
    ok: false,
    error: 'Magic-link email delivery is not configured yet. Use the embedded GHL portal flow for now.',
    code: 'magic_link_delivery_unavailable',
  }, origin);
}

async function authMagicLinkConsume(req, res, origin, url) {
  const payload = readSignedToken(url.searchParams.get('token') || '');
  if (!payload?.member) {
    sendRedirect(res, safeReturnUrl(url.searchParams.get('returnTo')), origin);
    return;
  }
  const session = createMemberSession(payload.member, 'magic-link');
  const token = signTokenPayload(session);
  sendRedirect(res, safeReturnUrl(payload.returnTo || url.searchParams.get('returnTo')), origin, {
    'Set-Cookie': buildSetCookie(req, token, session.exp),
  });
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
  const secretOk = Boolean(AUTH_EMBED_SHARED_SECRET) && sharedSecret === AUTH_EMBED_SHARED_SECRET;
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
  if (normalized.includes('service') || normalized.includes('what do you do') || normalized.includes('gaia') || normalized.includes('device')) {
    return 'Gaia Healers connects Bio-Well, BioPulsar, BioTekna, Healeex, certification, practitioner communities, devices, CE progress, and Elevate event operations. I can explain services, compare devices, find the right course, prepare event badge steps, or draft GHL follow-up in review mode.';
  }
  if (normalized.includes('community') || normalized.includes('membership') || normalized.includes('login') || normalized.includes('discussion')) {
    return 'The Gaia member hub is built around GHL Client Portal, courses, credentials, communities, newsletters, and group discussions. The observed groups include All Gaia Healers, Bio-Well Practitioners, BioPulsar, Biotekna, Healeex, and Abundant Healer Collective.';
  }
  if (normalized.includes('badge') || normalized.includes('elevate') || normalized.includes('event')) {
    return 'I can help prepare your Elevate badge test flow. Confirm the attendee email, verify the GHL registration, then the Event Manager can show QR badge status before anything is changed.';
  }
  if (normalized.includes('scan') || normalized.includes('bio-well') || normalized.includes('biowell')) {
    return 'For the Bio-Well flow, I can summarize today\'s readiness, highlight the chakra focus, and suggest the next practitioner action without saving anything automatically.';
  }
  if (normalized.includes('course') || normalized.includes('academy') || normalized.includes('certification')) {
    return 'For Academy progress, I can point you to the next module and remind you what evidence is still needed before exam unlock.';
  }
  if (normalized.includes('ghl') || normalized.includes('follow')) {
    return 'For GHL follow-up, I can draft a message and keep it in review mode so you approve it before it is sent or saved.';
  }
  return 'Gaia Assist is connected to the staging proxy. Ask about badges, Bio-Well scans, Academy progress, or GHL follow-up and I will keep changes in review mode.';
}

function assistSystemPrompt() {
  return [
    'You are Gaia Assist, the smart concierge for the Gaia Healers mobile app.',
    'Answer with deep awareness of Gaia Healers services, GHL membership/community structure, academy courses, event operations, devices, website offers, Bio-Well scans, and practitioner workflows.',
    'The app can run embedded inside the Gaia Healers GHL custom menu. In that mode, never push users out to education.gaiahealers.com as the first answer. Keep them inside the app: Academy for courses, Community for discussions/events/members/newsletter, Wellness for Bio-Well/chakras/devices, Profile for account access, and Admin only after internal unlock.',
    'If a member says courses ask for login, explain that the app should show course guidance internally and use Profile/member access only for gated lessons, certificates, purchases, or personal records.',
    'When asked operational questions, explain what the app can read, what still requires login, and what needs admin approval.',
    'Never claim that you saved, imported, checked in, emailed, purchased, or changed data. Keep all actions in review/confirm mode.',
    'Keep responses concise, practical, warm, and wellness-safe. Do not provide medical diagnosis.',
    gaiaKnowledgePrompt(),
  ].join(' ');
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
        { role: 'system', content: assistSystemPrompt() },
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
        { role: 'system', content: assistSystemPrompt() },
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

  const context = { intent: body.intent, page: body.page, source: body.source || 'chat-stream' };
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
    if (req.method === 'GET' && url.pathname === '/api/auth/magic-link/consume') {
      await authMagicLinkConsume(req, res, origin, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/embedded/claim') {
      await authEmbeddedClaim(req, res, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/app/bootstrap') {
      sendJson(res, 200, await bootstrap(req, url), origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/academy/progress') {
      const memberContext = sessionMemberContext(req);
      const payload = applyMemberContextToAcademy(await getAcademyProgress(withMemberContext(url, memberContext)), memberContext);
      payload.authenticated = Boolean(memberContext);
      payload.memberResolved = Boolean(memberContext?.email || memberContext?.memberId || memberContext?.contactId);
      sendJson(res, 200, payload, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/member/hub') {
      const memberContext = sessionMemberContext(req);
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
      const payload = await assistChat({ ...body, source: body.source || 'chat' });
      sendJson(res, payload.ok === false ? 400 : 200, payload, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/assist/chat/stream') {
      const body = await readJsonBody(req);
      await assistChatStream({ ...body, source: body.source || 'chat-stream' }, res, origin);
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
      const payload = await assistChat({ ...body, prompt: transcript, transcript, source: body.source || 'voice' });
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

server.listen(PORT, () => {
  console.log(`Gaia staging proxy listening on :${PORT}`);
});
