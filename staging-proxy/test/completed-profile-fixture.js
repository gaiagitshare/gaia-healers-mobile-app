export function installCompletedProfileFixture() {
  const realFetch = globalThis.fetch, members = new Map();
  globalThis.fetch = async (input, options = {}) => {
    const u = new URL(String(input));
    if (options.headers?.cookie) {
      try {
        const encoded = /gaia_member_session=([^.;]+)/.exec(options.headers.cookie)?.[1];
        const member = JSON.parse(Buffer.from(encoded, 'base64url')).member;
        if (member?.contactId || member?.memberId) members.set(member.contactId || member.memberId, member);
      } catch {}
    }
    const base = String(process.env.GHL_API_BASE_URL || '').replace(/\/$/, '');
    if (String(input).startsWith(base + '/contacts/') && /^\/contacts\/[^/]+$/.test(u.pathname) && u.pathname !== '/contacts/search') {
      const id = decodeURIComponent(u.pathname.split('/').pop()), member = members.get(id);
      let response;
      try { response = await realFetch(input, options); } catch (error) {
        if (base !== 'http://127.0.0.1:9' || !member) throw error;
        return new Response(JSON.stringify({ contact: { id, email: member.email, tags: ['gaia_app_onboarding_complete'], customFields: [] } }), { headers: { 'content-type': 'application/json' } });
      }
      if (!response.ok) return response;
      const data = await response.clone().json();
      if (data.contact) data.contact.tags = [...new Set([...(data.contact.tags || []), 'gaia_app_onboarding_complete'])];
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    }
    return realFetch(input, options);
  };
}
