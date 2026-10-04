import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../gaia-ui.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('  // One tour for first-run'),source.indexOf('  function initCoachMark()'));
function harness(member=false){
 const events={};
 const context=vm.createContext({window:{GaiaMember:{data:{courses:{courses:member?[{id:'example'}]:[]}}}},document:{addEventListener:(name,fn)=>events[name]=fn},localStorage:{getItem:()=>null},authState:()=>({authenticated:member})});
 vm.runInContext(block,context);
 return {context,events,steps:()=>vm.runInContext('tourSteps()',context)};
}
test('guest guidance describes actual tools without promising courses, bookings or voice access',()=>{
 const h=harness();assert.equal(h.steps().length,5);
 assert.ok(h.steps().some(s=>s.view==='wellness'&&s.sel==='#wellness-tabs'));
 assert.ok(!h.steps().some(s=>s.requiresPractitioner||s.view==='academy'));
 assert.doesNotMatch(h.steps().map(s=>s.body).join(' '),/hold|certif|free account.*courses|middle|next session/);
});
test('member tour adds learning; practitioner guidance requires a connected server result',()=>{
 const h=harness(true);assert.ok(h.steps().some(s=>s.view==='academy'));
 h.context.window.GaiaMember.data.courses.courses=[];assert.ok(!h.steps().some(s=>s.view==='academy'));
 h.context.window.GaiaMember.data.courses.courses=[{id:'example'}];
 for(const state of ['not_connected','not_practitioner','unverified','needs_reconnect','rejected','suspended','disabled','unknown',null]){
  h.events['gaia:practitioner-state']({detail:{state}});
  assert.ok(!h.steps().some(s=>s.requiresPractitioner),String(state));
 }
 h.events['gaia:practitioner-state']({detail:{state:'connected'}});
 assert.equal(h.steps().filter(s=>s.requiresPractitioner).length,1);
 h.events['gaia:practitioner-state']({detail:{state:'connected',available:false}});
 assert.ok(!h.steps().some(s=>s.requiresPractitioner));
 const guest=harness();guest.events['gaia:practitioner-state']({detail:{state:'connected'}});
 assert.ok(!guest.steps().some(s=>s.requiresPractitioner));
});
test('invalid selectors and blocked onboarding fail closed before a target can be shown',()=>{
 const h=harness();h.context.window.GaiaAppGuard={canEnter:false};
 assert.equal(vm.runInContext('tourTarget({sel:"#anything"})',h.context),null);
 h.context.window.GaiaAppGuard.canEnter=true;h.context.document.querySelectorAll=()=>{throw Error('bad selector');};
 assert.equal(vm.runInContext('tourTarget({sel:"["})',h.context),null);
});
test('card placement avoids the target when there is room and stays bounded otherwise',()=>{
 const h=harness();
 const cases=[
  {r:{left:30,top:30,right:120,bottom:70,width:90,height:40},w:358,h:200,vw:390,vh:844},
  {r:{left:10,top:200,right:90,bottom:700,width:80,height:500},w:420,h:200,vw:1440,vh:900},
  {r:{left:300,top:650,right:380,bottom:700,width:80,height:50},w:358,h:200,vw:390,vh:844},
  {r:{left:0,top:0,right:390,bottom:844,width:390,height:844},w:358,h:200,vw:390,vh:844},
 ];
 for(const c of cases){h.context.c=c;const p=vm.runInContext('tourCardPosition(c.r,c.w,c.h,c.vw,c.vh)',h.context);
  assert.ok(p.x>=16&&p.y>=16&&p.x+c.w<=c.vw-16&&p.y+c.h<=c.vh-16);
  if(c.r.height<c.vh-200)assert.ok(p.x+c.w<=c.r.left||p.x>=c.r.right||p.y+c.h<=c.r.top||p.y>=c.r.bottom);
 }
});
