import {workspacePath} from './beta-path.mjs';
import {effectiveBenefits,memberId,paidAccess} from './beta-access.mjs';
import {learningCatalog} from './beta-learning.mjs';
// Member-safe read models for the signed beta workspace. No production persistence.
import {TIERS,ENTITLEMENTS,COIN_PACKAGES} from './beta-catalog.mjs';
const names=Object.fromEntries(ENTITLEMENTS.map(x=>[x[0],x[2]]));
const iso=n=>new Date(n).toISOString();
const bucket=n=>({coins:n,usd:'$'+(n/100).toFixed(2)});
export const appPlans=()=>({ok:true,environment:'staging',stripeMode:'none',currency:'USD',beta:true,plans:TIERS.map(t=>({key:t.key,name:t.name,rank:t.rank,versionId:'beta-'+t.key,monthlyCoins:t.coins,prices:t.prices,benefits:Object.entries(t.entitlements).map(([key,value])=>({key,label:key==='discount.certifications_pct'?`${value}% off certifications`:names[key],value}))})),coinPacks:COIN_PACKAGES.map(p=>({key:p.key,coins:p.coins,priceCents:p.priceCents,price_cents:p.priceCents,currency:'USD',bonus_coins:0}))});
export function appOverview(s){const t=TIERS.find(t=>t.key===s.plan),hasAccess=paidAccess(s);const sub={id:'00000000-0000-4000-8000-000000000001',plan_key:t.key,plan_name:t.name,status:s.status,billing_interval:s.interval,hasAccess,current_period_start:iso(s.periodStart),current_period_end:iso(s.end),cancel_at:s.cancel?iso(s.end):null,provider:'beta_local',source:'fixture',pendingChange:s.scheduled?{status:'scheduled',toPlanName:TIERS.find(x=>x.key===s.scheduled.plan).name,toInterval:s.scheduled.interval,effectiveAt:iso(s.end)}:null};return {ok:true,beta:true,membership:t.rank>0?[sub]:[],access:Object.entries(effectiveBenefits(s)).map(([key,value])=>({key,value})),wallet:{...Object.fromEntries(['granted','purchased','goodwill'].map(k=>[k,bucket(s.wallet[k])])),legacy:bucket(0),total:bucket(s.wallet.granted+s.wallet.purchased+s.wallet.goodwill),nextGrantAt:hasAccess?iso(s.nextGrant):null,spendOrder:['granted','purchased','goodwill']},legacy:s.legacy?.active?[{id:'beta-legacy',tier:'silver',provider:'fictional',status:'active',state:'active',paidThrough:null}]:[],migrationOffers:[],availability:{stage:'INTERNAL_PILOT',newMembership:!s.legacy?.active,newMembershipReason:s.legacy?.active?'legacy_membership_active':null,coinPacks:true,coinPacksReason:null}};}
const betaEvent={id:'beta-elevate-2026',name:'Gaia Healers Elevate Conference 2026',title:'Gaia Healers Elevate Conference 2026',startDate:'2026-11-20',endDate:'2026-11-22',startAt:'2026-11-20T09:00:00-05:00',endAt:'2026-11-22T18:00:00-05:00',location:'Rosen Shingle Creek, Orlando, FL',heroImageUrl:'/app/assets/gaia-elevate-poster.jpg',registrationUrl:'/sandbox/event',registrationLabel:'Buy Ticket',description:'Beta event preview for the Elevate conference. Reservations in this test area are fictional.',status:'published'};
export function appApi(s,path){
 if(['/api/courses','/api/member/courses','/api/academy/me','/api/academy/manifest'].includes(path)){
  const signed=s.joined!==false&&s.signedOut!==true,all=learningCatalog(s),mine=path==='/api/courses'?all:all.filter(c=>c.included);
  if(path==='/api/academy/manifest')return {ok:true,beta:true,courses:[],count:0}; // Native beta learning route owns the lesson player.
  return {ok:true,beta:true,authenticated:signed,courses:mine.map(c=>({id:'beta-demo-'+c.key,title:c.title,description:c.description||'Original training videos are awaiting connection.',image:c.image||'',poster:c.image||'',category:c.key==='beta_orientation'?'Beta walkthrough':'Courses',state:c.included?'unlocked':'locked',accessLevel:c.included?'Included':'With '+c.lowest,openUrl:'/sandbox/academy?course='+encodeURIComponent(c.key),portalUrl:'/sandbox/academy?course='+encodeURIComponent(c.key),openUrlIsFallback:false,progressAvailable:c.ready,progress:c.lessons.length?(s.learningProgress?.[c.key]||[]).length/c.lessons.length:0,sections:[],grantMatch:[c.title]})),count:mine.length,progress:signed?s.learningProgress||{}:{},portalUrl:'/sandbox/academy',source:'beta-workspace'};
 }
 if(path==='/api/events')return {ok:true,events:[betaEvent]};
 if(path==='/api/events/beta-elevate-2026')return {ok:true,event:betaEvent};

 if(path==='/api/member/profile')return {ok:true,authenticated:s.joined!==false&&s.signedOut!==true,profile:(s.joined===false||s.signedOut===true)?null:{contactId:memberId(s),name:s.displayName||'Demo Member',email:'demo.member@example.invalid',membershipTier:(appOverview(s).membership.find(m=>m.hasAccess)?.plan_name)||null}};
 if(path==='/api/member/path')return {ok:true,beta:true,...workspacePath(s)};
 if(path==='/api/auth/session')return {ok:true,authenticated:s.joined!==false&&s.signedOut!==true,member:(s.joined===false||s.signedOut===true)?null:{contactId:memberId(s),name:s.displayName||'Demo Member',email:'demo.member@example.invalid'}};
 if(s.joined===false||s.signedOut===true){if(path.startsWith('/api/membership2/me/'))return{ok:false,code:'SIGN_IN_REQUIRED',items:[]};if(path.startsWith('/api/member/'))return {ok:true,authenticated:false,member:null,profile:null,entitlements:[],sections:[],items:[],communities:{unlocked:[],locked:[]}};if(path==='/api/academy/me')return{ok:true,authenticated:false,courses:[],count:0};}

 if(path==='/api/membership2/plans')return appPlans();
 if(path==='/api/membership2/me')return (s.joined===false||s.signedOut===true)?{ok:true,membership:[],access:[],wallet:null,legacy:[],migrationOffers:[],availability:{newMembership:true,coinPacks:false,stage:'INTERNAL_PILOT'}}:appOverview(s);
 if(path==='/api/membership2/me/coins')return {ok:true,items:s.ledger.slice(0,100).map(l=>({id:l.id,kind:'adjustment',reason:l.kind,at:iso(l.at),byBalance:{granted:l.granted,purchased:l.purchased,goodwill:l.goodwill}}))};
 if(path==='/api/membership2/me/billing')return {ok:true,items:s.invoices.filter(i=>i.status==='paid').flatMap(i=>[{id:i.id,type:'charge',amountCents:i.amount,currency:'USD',at:iso(i.at),what:i.description,provider:'beta_local',invoiceRef:i.id},...(i.refunded?[{id:i.id+'-refund',type:'refund',amountCents:-i.refunded,currency:'USD',at:iso(i.at),what:i.description,provider:'beta_local',invoiceRef:i.id}]:[])])};
 return null;
}
