import { TIERS } from './beta-catalog.mjs';
export const signedIn = s => s.joined !== false && s.signedOut !== true;
export const memberId = s => 'beta-member-' + s.csrf;
export const paidAccess = s => signedIn(s) && ['active','trialing','past_due'].includes(s.status) && s.plan !== 'free' && s.now < (s.status === 'past_due' ? s.graceEnd : s.end);
export function effectiveBenefits(s) {
  return (TIERS.find(t => t.key === (paidAccess(s) ? s.plan : 'free')) || TIERS[0]).entitlements;
}
// Explicit grants are the authorization boundary, as in the production Academy.
// The local provider fixture confirms the configured benefit -> course mapping.
// This never writes a GHL grant or changes production/manual learner records.
export function courseGrants(s, mapping) {
  const benefits = effectiveBenefits(s), owner = memberId(s);
  s.courseGrants = signedIn(s) ? Object.entries(mapping).filter(([,key]) => benefits[key]).map(([courseId,benefit]) => ({courseId,memberId:owner,source:'beta_manual',benefit,status:'active'})) : [];
  return s.courseGrants;
}
export const grantedCourse = (grants, owner, courseId) => grants.some(g => g.memberId === owner && g.courseId === courseId && g.status === 'active' && ['ghl_sync','manual','beta_manual'].includes(g.source));
