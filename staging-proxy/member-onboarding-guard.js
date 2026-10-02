// Central request eligibility. Only confirmed complete states are memoized.
export function protectedMemberPath(path) {
  return path.startsWith('/api/member/') || path.startsWith('/api/academy/') ||
    path.startsWith('/api/wellness/') || ['/api/assist/lookup', '/api/assist/memory', '/api/assist/interest'].includes(path);
}
export function createMemberOnboardingGuard({ resolveContact, store, key, now = Date.now }) {
  const ready = new Map();
  async function check(req, member, fresh = false) {
    const sessionKey = key(req);
    if (!fresh && ready.get(sessionKey) > now()) return { state: 'complete' };
    ready.delete(sessionKey);
    try {
      const contactId = await resolveContact(member);
      if (!contactId) return { state: 'unavailable', reason: 'onboarding_contact_unavailable' };
      const profile = await store.load(contactId);
      if (profile.state === 'complete') {
        // A complete bootstrap establishes eligibility for this signed session.
        if (ready.size > 1024) ready.clear();
        ready.set(sessionKey, now() + 10 * 60 * 1000);
      }
      return profile;
    } catch { return { state: 'unavailable', reason: 'onboarding_unavailable' }; }
  }
  return { check, invalidate(req) { ready.delete(key(req)); } };
}
