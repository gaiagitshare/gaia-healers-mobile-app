// Central request eligibility. Only confirmed complete states are memoized.
export function protectedMemberPath(path) {
  return path.startsWith('/api/member/') || path.startsWith('/api/academy/') ||
    path.startsWith('/api/wellness/') || ['/api/assist/lookup', '/api/assist/memory', '/api/assist/interest'].includes(path);
}

// `completed` is a durable record of contacts GHL has confirmed complete
// ({ has(id), add(id) }). The gate reads GHL on every check, and GHL being
// slow or down used to fail every signed-in member closed — including members
// who finished long ago — out of courses, wellness and all of Gaia Assist.
// Completion never goes backwards, so a member GHL once confirmed complete is
// let through on that record while GHL cannot answer. Members not on the
// record still get the retry screen: nobody skips the gate because of an
// outage.
export function createMemberOnboardingGuard({ resolveContact, store, key, now = Date.now, completed = null }) {
  const ready = new Map();
  const knownComplete = (member) => {
    const id = member && (member.contactId || member.memberId);
    try { return Boolean(id && completed && completed.has(String(id))); } catch { return false; }
  };
  async function check(req, member, fresh = false) {
    const sessionKey = key(req);
    if (!fresh && ready.get(sessionKey) > now()) return { state: 'complete' };
    ready.delete(sessionKey);
    try {
      const contactId = await resolveContact(member);
      if (!contactId) return knownComplete(member) ? { state: 'complete', source: 'record' } : { state: 'unavailable', reason: 'onboarding_contact_unavailable' };
      const profile = await store.load(contactId);
      if (profile.state === 'complete') {
        // A complete bootstrap establishes eligibility for this signed session.
        if (ready.size > 1024) ready.clear();
        ready.set(sessionKey, now() + 10 * 60 * 1000);
        try { completed?.add(String(contactId)); } catch { /* the record is a fallback, never a reason to fail */ }
      }
      return profile;
    } catch {
      return knownComplete(member) ? { state: 'complete', source: 'record' } : { state: 'unavailable', reason: 'onboarding_unavailable' };
    }
  }
  return { check, invalidate(req) { ready.delete(key(req)); } };
}
