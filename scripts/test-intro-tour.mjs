/** Offline API fixtures; live static app, local branch assets. No model calls or account impersonation.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/test-intro-tour.mjs
 * Optional TOUR_SCREENSHOTS=/absolute/output/directory.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const screenshots=process.env.TOUR_SCREENSHOTS;
if(screenshots)await mkdir(screenshots,{recursive:true});
async function setup(width,height=900,member=false,link='not_connected',onboarding='complete'){
 const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('gaia-tour-v1','1');localStorage.setItem('gaia-avatar-met','1');});
 for(const file of ['gaia-ui.js','gaia-avatar.js','gaia-fit.css','gaia-practitioner.js','gaia-app-v3.css','gaia-app-v3-today-energy.css','gaia-app-v3-shop-you.css'])
  await page.route('**/'+file+'*',r=>r.fulfill({path:path.join(root,file),contentType:file.endsWith('.css')?'text/css':'application/javascript'}));
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());let status=503,body={ok:false,error:'unavailable_in_fixture'};
  if(url.pathname==='/api/auth/session')body={ok:true,authenticated:member,member:{name:'Example member',email:'example@example.invalid'}};
  else if(url.pathname==='/api/assist/onboarding')body={ok:true,state:onboarding,member:{name:'Example member'},schema:[],answers:{}};
  else if(url.pathname==='/api/practitioners/status'){status=member?200:401;body={available:true,state:link,connected:link==='connected'};}
  else if(url.pathname==='/api/member/profile')body={ok:true,authenticated:member,profile:{name:'Example member',email:'example@example.invalid',tags:['practitioner']}};
  else if(url.pathname==='/api/member/courses')body={ok:true,authenticated:member,courses:[{id:'tour-course',title:'Example course',name:'Example course'}]};
  else if(url.pathname.startsWith('/api/member/'))body={ok:true,authenticated:member,communities:{unlocked:[],locked:[]},membership:{},entitlements:[],sections:[],prefs:{},courses:[]};
  else if(url.pathname.startsWith('/api/assist/')){status=503;body={ok:false,error:'blocked_in_test'};}
  if(body.ok)status=200;
  if(url.pathname==='/api/practitioners/status'&&!member)status=401;
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('https://gaiahealers.app/home.html',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.GaiaTour && window.GaiaAppShell && ['ready','visitor','onboarding_required'].includes(window.GaiaAppGuard?.status));
 if(member&&onboarding==='complete')await page.waitForFunction(()=>GaiaMember.authed);
 await page.waitForTimeout(300);
 return {page,context,errors};
}
async function start(page,steps){await page.evaluate(steps=>GaiaTour.run(steps,{remember:false}),steps);await page.locator('.gaia-tour__card').waitFor();}
async function closed(page){await page.waitForFunction(()=>!document.querySelector('.gaia-tour'));}
async function inspect(page,width,height){
 await page.locator('.gaia-tour__card').waitFor();
 await page.waitForTimeout(100);
 const result=await page.evaluate(()=>{
  const overlay=document.querySelector('.gaia-tour'),card=overlay.querySelector('.gaia-tour__card');
  const targets=[...document.querySelectorAll(overlay.dataset.tourTarget)];
  const el=targets.find(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height&&!e.closest('[hidden],[inert]'));
  const target=el?.getBoundingClientRect(),r=card.getBoundingClientRect(),spot=overlay.querySelector('.gaia-tour__spot').getBoundingClientRect();
  return {title:card.querySelector('h4').textContent,target:target?.toJSON(),card:r.toJSON(),spot:spot.toJSON(),view:GaiaAppShell.currentView(),targetSelector:overlay.dataset.tourTarget};
 });
 assert.ok(result.target,result.title+' valid target');const {card,target,spot}=result;
 assert.ok(card.x>=0&&card.y>=0&&card.right<=width+1&&card.bottom<=height+1,JSON.stringify(result));
 assert.ok(target.right>0&&target.left<width&&target.bottom>0&&target.top<height,'target in viewport');
 assert.ok(spot.right>target.left&&spot.left<target.right&&spot.bottom>target.top&&spot.top<target.bottom,'spotlight covers correct target');
 if(target.bottom+16+card.height<=height-16 || target.top-16-card.height>=16 || target.right+16+card.width<=width-16 || target.left-16-card.width>=16)
  assert.ok(card.right<=target.left || card.left>=target.right || card.bottom<=target.top || card.top>=target.bottom,'card should not cover target when room exists');
 assert.equal(await page.locator('.gava-bubble:visible').count(),0,'avatar prompts must not compete with the tour');
 assert.ok(await page.getByRole('button',{name:'Exit',exact:true}).isEnabled());
 assert.ok(await page.locator('.gaia-tour__next').isEnabled());
 return result;
}
try{
 for(const width of [390,768,1440])for(const member of [false,true]){
  const height=width===390?844:900;
  const {page,context,errors}=await setup(width,height,member,member?'connected':'not_connected');
  await start(page);const titles=[];
  for(let step=0;step<8&&await page.locator('.gaia-tour').count();step++){
   const result=await inspect(page,width,height);titles.push(result.title);
   if(screenshots)await page.screenshot({path:path.join(screenshots,`${member?'practitioner':'guest'}-${width}-${step+1}.png`)});
   if(step===2){const title=result.title;await page.getByRole('button',{name:'Back',exact:true}).click();await inspect(page,width,height);await page.locator('.gaia-tour__next').click();await page.waitForFunction(t=>document.querySelector('.gaia-tour__title')?.textContent===t,title);}
   await page.locator('.gaia-tour__next').click();await page.waitForTimeout(180);
  }
  await closed(page);assert.equal(await page.evaluate(()=>GaiaAppShell.currentView()),'today');
  assert.deepEqual(titles,member?['Start from Home','Choose your energy tool','Find your learning','Manage your account','Open your practice','Get a little guidance']:['Start from Home','Try an energy check','Choose your energy tool','Make it yours','Get a little guidance']);
  await page.locator('.gaia-tabbar [data-app-nav="wellness"]').click();assert.equal(await page.evaluate(()=>GaiaAppShell.currentView()),'wellness');
  assert.deepEqual(errors,[], 'no page errors in the tour fixture');
  console.log('PASS sequence, target, Back/Next/Done, restoration and usable app',width,member?'practitioner':'guest');
  await context.close();
 }
 const blocked=await setup(768,900,true,'connected','new');
 await blocked.page.evaluate(()=>GaiaTour.run());await blocked.page.waitForTimeout(200);await closed(blocked.page);assert.equal(await blocked.page.evaluate(()=>GaiaAppGuard.canEnter),false);assert.equal(await blocked.page.locator('#gaia-app-shell').isVisible(),false);await blocked.context.close();console.log('PASS incomplete onboarding retains its own gate without tour interference');
 const {page,context}=await setup(390,844,true);
 const one={sel:'.gaia-tabbar__home',title:'Valid',body:'Visible target'};
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('gaia:practitioner-state',{detail:{state:'connected',available:true}})));
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('gaia:practitioner-state',{detail:{state:'unverified',available:true}})));
 await page.waitForTimeout(1100);assert.equal(await page.locator('.gava-bubble:visible').count(),0,'a refused link must cancel the delayed connected greeting');
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('gaia:practitioner-state',{detail:{state:'connected',available:true}})));
 await page.waitForFunction(()=>document.querySelector('.gava-bubble')?.dataset.practiceWelcome==='true');
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('gaia:practitioner-state',{detail:{state:'needs_reconnect',available:true}})));
 assert.equal(await page.locator('.gava-bubble:visible').count(),0,'a visible connected greeting must close when authorization changes');
 console.log('PASS delayed/visible practitioner greeting is cancelled after loss of authorization');
 for(const state of ['not_connected','not_practitioner','unverified','needs_reconnect','unknown']){
  await page.evaluate(state=>document.dispatchEvent(new CustomEvent('gaia:practitioner-state',{detail:{state}})),state);
  await start(page);const titles=[];
  while(await page.locator('.gaia-tour').count()){titles.push((await inspect(page,390,844)).title);await page.locator('.gaia-tour__next').click();await page.waitForTimeout(180);}
  assert.ok(!titles.includes('Open your practice'),state+' must not advertise practitioner access');
 }
 console.log('PASS member + GHL tag does not advertise Practice in any unauthorized state');
 await page.evaluate(()=>{GaiaMember.data.courses.courses=[];});await start(page);const noCourseTitles=[];while(await page.locator('.gaia-tour').count()){noCourseTitles.push((await inspect(page,390,844)).title);await page.locator('.gaia-tour__next').click();await page.waitForTimeout(180);}assert.deepEqual(noCourseTitles,['Start from Home','Choose your energy tool','Manage your account','Get a little guidance']);
 console.log('PASS new member with no course grants skips course guidance');
 await page.evaluate(()=>{const el=document.createElement('div');el.id='offscreen-tour-target';Object.assign(el.style,{position:'fixed',left:'-10000px',top:'0',width:'100px',height:'100px'});document.body.appendChild(el);});
 await start(page,[{sel:'#offscreen-tour-target',title:'Offscreen'}, {sel:'#missing',title:'Missing'}, {sel:'[',title:'Invalid'}, {sel:'[data-screen="academy"] .g-page__head',title:'Hidden'},one]);
 await page.waitForFunction(()=>document.querySelector('.gaia-tour__title')?.textContent==='Valid');
 await page.getByRole('button',{name:'Exit',exact:true}).click();await closed(page);
 await start(page,[one,{sel:'#missing',title:'Gone'}]);await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('button',{name:'Exit',exact:true}).click();await closed(page);await page.waitForTimeout(500);await closed(page);
 await start(page,[one]);await page.evaluate(()=>document.querySelector('.gaia-tabbar__home').hidden=true);await closed(page);await page.evaluate(()=>document.querySelector('.gaia-tabbar__home').hidden=false);
 await start(page,[one]);await page.evaluate(()=>GaiaAppShell.go('academy'));await closed(page);assert.equal(await page.evaluate(()=>GaiaAppShell.currentView()),'academy');
 await start(page,[{sel:'#wellness-tabs',view:'wellness',title:'Tabs'}]);await page.evaluate(()=>document.querySelector('#wellness-tabs [data-tab=horoscope]').click());await closed(page);
 await start(page,[one]);await page.evaluate(()=>window.dispatchEvent(new PopStateEvent('popstate')));await closed(page);
 await start(page,[one]);await page.setViewportSize({width:844,height:390});await inspect(page,844,390);await page.keyboard.press('Escape');await closed(page);
 await start(page,[one]);await start(page,[one]);assert.equal(await page.locator('.gaia-tour').count(),1);await page.evaluate(()=>GaiaTour.close());await closed(page);
 await start(page,[one]);await page.evaluate(()=>GaiaAppGuard.set('onboarding_required'));await closed(page);await page.evaluate(one=>GaiaTour.run([one]),one);await page.waitForTimeout(200);await closed(page);await page.evaluate(()=>GaiaAppGuard.set('ready'));
 await start(page,[one]);await page.reload();await page.waitForFunction(()=>window.GaiaTour);await closed(page);
 console.log('PASS missing/invalid/hidden/removed targets, exit during transition, navigation, rotation, restart, onboarding guard and refresh');
 await context.close();
}finally{await browser.close();}
