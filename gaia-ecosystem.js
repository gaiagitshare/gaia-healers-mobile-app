/** Gaia Healers — shared app data.
 * Prototype note: this is the single handoff point for future GHL/event API wiring.
 */
window.GAIA = {
  members: 1233,
  portalUrl: 'https://education.gaiahealers.com',
  sources: {
    website: 'https://gaiahealers.com',
    ghl: 'https://crm.gaiahealers.com/v2/location/hPqC08CFLJmUALiMjHir/dashboard',
    eventApi: '/event-api',
    eventPublic: 'https://ba2ki.com/event',
    elevate: 'https://elevate.gaiahealers.com/',
  },
  communities: [
    { id: 'biowell', name: 'Bio-Well Practitioners', members: 376, badge: 'Primary' },
    { id: 'biopulsar', name: 'BioPulsar Practitioners', members: 505, badge: null },
    { id: 'biotekna', name: 'Biotekna Practitioners', members: 158, badge: null },
    { id: 'healeex', name: 'Healeex Community', members: 22, badge: 'New' },
    { id: 'all', name: '[Start Here] All Gaia Healers', members: 232, badge: null },
    { id: 'abundant', name: 'The Abundant Healer Collective', members: 117, badge: null },
  ],
  certifications: [
    { name: 'BIO-WELL Basic Certification', status: 'earned', year: '2024' },
    { name: 'BIO-WELL Orientation Training', status: 'earned', year: '2024' },
    { name: 'Bio-Well Advanced Level 1', status: 'in_progress', pct: 62 },
    { name: 'Bio-Well Advanced Level 2', status: 'locked', unlock: '80% L1' },
  ],
  topCourse: 'Bio-Well Basic Certification Training',
  event: {
    id: 'elevate-2026',
    name: 'Gaia Healers Elevate 2026',
    shortName: 'Elevate 2026',
    date: 'Nov 20-22, 2026',
    venue: 'Rosen Shingle Creek',
    location: 'Orlando, FL',
    source: 'GHL registration + Event Manager check-in',
    sourceUrl: 'https://elevate.gaiahealers.com/',
    description: 'Three days where ancient healing traditions meet cutting-edge science, live technology demonstrations, and practitioner connection.',
    stats: {
      attendees: 428,
      paidMembers: 301,
      checkedIn: 0,
      exhibitors: 40,
      leads: 0,
      checkInRate: 0,
    },
    access: [
      { name: 'VIP Pass', price: '$999', detail: 'All sessions, exhibit hall, and workshops' },
      { name: 'Three Day Event Pass', price: '$650', detail: 'Conference and exhibit hall access' },
      { name: 'Workshop Access', price: '$449', detail: 'Hands-on workshop track' },
      { name: 'General Admission + Conference', price: '$175', detail: 'Exhibit hall plus back-row conference access' },
    ],
    operations: [
      { label: 'GHL import', value: 'Ready', detail: 'CSV fields mapped to attendee profile' },
      { label: 'QR badges', value: '428', detail: 'Unique attendee QR codes prepared' },
      { label: 'Lead retrieval', value: '40', detail: 'Exhibitor scan links reserved' },
    ],
    agenda: [
      { day: 'Day 1', title: 'Biofield diagnostics lab', time: '9:30 AM', track: 'Bio-Well' },
      { day: 'Day 2', title: 'Biopulsar aura and chakra intelligence', time: '11:00 AM', track: 'Biopulsar' },
      { day: 'Day 3', title: 'BioTekna nervous system mapping', time: '2:00 PM', track: 'BioTekna' },
    ],
  },
  assistant: {
    name: 'Gaia Assist',
    mode: 'Push-to-talk prototype',
    promise: 'Ask before it saves, imports, or changes practitioner data.',
    suggestions: [
      'Prepare my Elevate badge',
      'Explain today\'s Bio-Well scan',
      'Find my next certification step',
      'Draft a GHL follow-up for event leads',
    ],
    responses: {
      event: 'I can prepare your Elevate 2026 pass, show QR badge status, and guide check-in or exhibitor lead capture.',
      scan: 'Your current energy index is 87. Sacral balance is the focus, with breathwork and hydration recommended before client sessions.',
      academy: 'You are 62% through Advanced Level 1. Complete 6 more documented scans to unlock the proctored exam.',
      ghl: 'GHL remains the source for registration and tickets. The event system handles attendee import, QR check-in, badge PDFs, and exhibitor leads.',
    },
  },
};
