// Full-app redesign, Phase 4: Events, Shop, Membership, Profile, Inbox, sign-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('every main screen now opts into the design system', () => {
  const html = read('home.html');
  for (const s of ['daily', 'bookings', 'wellness', 'academy', 'community', 'directory', 'events', 'store', 'profile', 'inbox']) assert.match(html, new RegExp(`data-screen="${s}" data-ds-page`), s);
  assert.doesNotMatch(html, /data-screen="today" data-ds-page/, 'Home keeps its own approved styles');
});

test('one lime per section: product and plan buttons are quiet, Membership uses the leaves art', () => {
  const ds = read('gaia-ds.css');
  assert.match(ds, /\.g-tile \.g-btn--primary,\s*body\.gaia-v2 \[data-screen="store"\] \.g-tier:not\(\.g-tier--featured\) \.g-btn--primary/);
  assert.match(ds, /g-tier-intro::after[^}]*ref-leaves\.webp\?v=kit1/);
});

test('sky "Try this" has no purple bar, and an empty daily practice is hidden', () => {
  const ds = read('gaia-ds.css');
  assert.match(ds, /\.g-sky__practice \{ border-left: 0 !important;/);
  assert.match(ds, /\.g-de__practice:not\(:has\(p:not\(\.g-de__label\):not\(:empty\)\)\)/);
});
