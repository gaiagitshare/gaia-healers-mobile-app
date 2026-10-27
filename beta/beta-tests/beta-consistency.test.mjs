import test from 'node:test';
import assert from 'node:assert/strict';
import {seed,apply,boundary} from '../beta-sandbox.mjs';
import {appApi,appOverview} from '../beta-app-state.mjs';
import {learningCatalog,savePosition,COURSE_MAP} from '../beta-learning.mjs';
import {effectiveBenefits,memberId,grantedCourse,courseGrants} from '../beta-access.mjs';
for(const plan of ['free','standard','professional','inner_circle'])test(`${plan}: app benefits and actual Academy grants agree`,()=>{
 const s=seed();s.plan=plan;
 const grants=courseGrants(s,COURSE_MAP),courses=learningCatalog(s);
 assert.deepEqual(appOverview(s).access,Object.entries(effectiveBenefits(s)).map(([key,value])=>({key,value})));
 for(const c of courses.filter(c=>c.original))assert.equal(c.included,grantedCourse(grants,memberId(s),c.key));
 assert(grants.every(g=>g.memberId===memberId(s)&&g.source==='beta_manual'));
});
test('expired membership and grace cannot leak paid benefits or video URLs',()=>{
 for(const status of ['active','trialing','past_due','cancelled','payment_pending']){
  const s=seed();s.plan='inner_circle';s.status=status;s.now=s.end+1;s.graceEnd=s.now-1;
  assert.equal(appOverview(s).membership[0].hasAccess,false);
  assert(!appOverview(s).access.some(x=>x.key==='certification.level_1'));
  assert(learningCatalog(s).filter(c=>c.original).every(c=>!c.included&&c.lessons.every(l=>!l.video&&!l.embed)));
 }
});
test('different workspaces have different stable app identities',()=>{
 const a=seed(),b=seed();assert.notEqual(memberId(a),memberId(b));
 assert.equal(appApi(a,'/api/auth/session').member.contactId,appApi(a,'/api/member/profile').profile.contactId);
 assert.equal(grantedCourse(courseGrants(a,COURSE_MAP),memberId(b),Object.keys(COURSE_MAP)[0]),false);
});
test('playback positions validate access and persist separately from completion',()=>{
 const s=seed();savePosition(s,{course:'beta_orientation',lesson:'tour',seconds:24.8});
 assert.equal(s.learningPositions.beta_orientation.tour,24);assert(!s.learningProgress);
 for(const seconds of [-1,Infinity,NaN,43201])assert.throws(()=>savePosition(s,{course:'beta_orientation',lesson:'tour',seconds}));
 s.signedOut=true;assert.throws(()=>savePosition(s,{course:'beta_orientation',lesson:'tour',seconds:30}));
 assert.equal(appApi(s,'/api/member/profile').profile,null);
});
test('original course completion is reflected in the app course list',()=>{
 const s=seed(),c=learningCatalog(s).find(c=>c.original&&c.included&&c.ready);
 apply(s,{action:'lesson_complete',course:c.key,lesson:c.lessons[0].id});
 const read=appApi(s,'/api/member/courses').courses.find(x=>x.id==='beta-demo-'+c.key);
 assert.equal(read.progress,1/c.lessons.length);
});
test('profile changes are shared across member session and profile',()=>{
 const s=seed();apply(s,{action:'profile_save',name:'Fictional Tester'});
 assert.equal(appApi(s,'/api/auth/session').member.name,'Fictional Tester');assert.equal(appApi(s,'/api/member/profile').profile.name,'Fictional Tester');
 s.actor='client';assert.throws(()=>apply(s,{action:'profile_save',name:'Other'}));
});

test('Personal Path uses real course progress and persists dismissals within one workspace',async()=>{
 const {workspacePath,pathEvent}=await import('../beta-path.mjs');const s=seed();
 apply(s,{action:'lesson_complete',course:'beta_orientation',lesson:'tour'});
 const item=workspacePath(s).items.find(x=>x.action.kind==='course');assert(item);
 pathEvent(s,{key:item.key,event:'recommendation_opened'});assert.equal(workspacePath(s).items.find(x=>x.key===item.key).state,'opened');
 assert.throws(()=>pathEvent(s,{key:item.key,event:'recommendation_completed'}));
 pathEvent(s,{key:item.key,event:'recommendation_dismissed'});assert(!workspacePath(s).items.some(x=>x.key===item.key));
 assert(!workspacePath(seed()).items.some(x=>x.key===item.key));
});
