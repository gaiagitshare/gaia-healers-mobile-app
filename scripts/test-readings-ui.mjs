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
async function setup(width,height=900,member=false,link='not_connected',onboarding='complete',linked=true){
 const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('gaia-tour-v1','1');localStorage.setItem('gaia-avatar-met','1');});
 for(const file of ['gaia-my-readings.js','gaia-ui.js','gaia-avatar.js','gaia-fit.css','gaia-practitioner.js','gaia-app-v3.css','gaia-app-v3-today-energy.css','gaia-app-v3-shop-you.css'])
  await page.route('**/'+file+'*',r=>r.fulfill({path:path.join(root,file),contentType:file.endsWith('.css')?'text/css':'application/javascript'}));
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());let status=503,body={ok:false,error:'unavailable_in_fixture'};
  if(url.pathname==='/api/auth/session')body={ok:true,authenticated:member,member:{name:'Example member',email:'example@example.invalid'}};
  else if(url.pathname==='/api/assist/onboarding')body={ok:true,state:onboarding,member:{name:'Example member'},schema:[],answers:{}};
  else if(url.pathname==='/api/practitioners/status'){status=member?200:401;body={available:true,state:link,connected:link==='connected'};}
  else if(url.pathname==='/api/member/profile')body={ok:true,authenticated:member,profile:{name:'Example member',email:'example@example.invalid',tags:['practitioner']}};
  else if(url.pathname==='/api/member/courses')body={ok:true,authenticated:member,courses:[{id:'tour-course',title:'Example course',name:'Example course'}]};
  else if(url.pathname==='/api/practitioners/member-link/status')body={ok:true,linked,linked_at:'2026-10-04',practitioner_name:'Example practitioner with a very long display name'};
  else if(url.pathname==='/api/practitioners/my-readings')body={ok:true,practitioner:{name:'Example practitioner'},linked_at:'2026-10-04', latest:{scanned_at:'2026-10-04',energy:60,stress:3},summary:{headline:'Your latest reading',lines:['Details about your reading.']},series:[{id:'a',at:'2026-10-01T09:00:00Z',d:'2026-10-01',e:30,s:1},{id:'b',at:'2026-10-04T09:00:00Z',d:'2026-10-04',e:60,s:3},{id:'c',at:'2026-10-04T10:00:00Z',d:'2026-10-04',e:90,s:5}],average_recent:{count:3,from:'2026-10-01',to:'2026-10-04',energy:60,stress:3}};
  else if(url.pathname.startsWith('/api/practitioners/member-link/'))body={ok:true,code:'TEST1234',expires_at:'2026-10-06',consent_recorded_at:'2026-10-05'};
  else if(url.pathname==='/api/assist/tool'){
    const {name}=route.request().postDataJSON(); let result={};
    if(name==='practitioner_list_clients') result={clients:[{id:'c1',name:'Example client'}]};
    else if(name==='practitioner_get_client')result={found:true,name:'Example client'};
    else if(name==='practitioner_compare_sessions')result={found:true,comparisons:[],series:[{id:'a',at:'2026-10-04T09:00:00Z',e:10,s:1},{id:'b',at:'2026-10-04T10:00:00Z',e:20,s:2}]};
    else if(name==='practitioner_client_files'){status=503;body={ok:false,error:'upstream_unavailable'};await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});return;}
    body={ok:true,result};
  }
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

try {
 for(const width of [390,768,1440]) {
  const {page,context,errors}=await setup(width,width===390?844:900,true,'connected');
  await page.evaluate(()=>GaiaAppShell.go('profile'));
  await page.locator('[data-readings-action="expand"]').click();
  await page.locator('.g-readings__averages').waitFor();
  assert.match(await page.locator('.g-readings__averages').innerText(),/60.0/);
  await page.locator('.g-readings__summary').evaluate(e=>e.scrollIntoView({block:'start'}));
  if(screenshots)await page.screenshot({path:path.join(screenshots,`reading-summary-${width}.png`)});
  const from=page.locator('[data-pick="from"]'),to=page.locator('[data-pick="to"]');
  await from.selectOption('b'); await to.selectOption('c');
  assert.match(await page.locator('.g-readings__pick-out').innerText(),/30.0/);
  await to.selectOption('b');assert.match(await page.locator('.g-readings__pick-out').innerText(),/different scans/);
  await page.locator('#member-data-sharing').scrollIntoViewIfNeeded();
  const wrap=await page.locator('#member-data-sharing .g-row__meta').first().evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth}));
  assert.ok(wrap.scroll<=wrap.width+1,'sharing metadata must not clip');
  if(screenshots)await page.screenshot({path:path.join(screenshots,`sharing-${width}.png`)});
  await page.locator('[data-profile-tab="practice"]').click();
  await page.locator('[data-prac-client="c1"]').click();
  await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
  assert.match(await page.locator('[data-prac-files]').innerText(),/could not be loaded/);
  await page.locator('[data-prac-open="compare"]').click();
  await page.locator('[data-prac-pick-to]').waitFor();
  assert.match(await page.locator('[data-prac-pick-out]').innerText(),/Energy change \+10.0/);
  await page.locator('[data-prac-pick-to]').selectOption('a');
  assert.match(await page.locator('[data-prac-pick-out]').innerText(),/different scans/);
  await page.locator('[data-prac-pick]').scrollIntoViewIfNeeded();
  if(screenshots)await page.screenshot({path:path.join(screenshots,`practice-compare-${width}.png`)});
  assert.deepEqual(errors,[]);
  await context.close();
  const codeTest=await setup(width,width===390?844:900,true,'connected','complete',false);
  await codeTest.page.evaluate(()=>{
    GaiaAppShell.go('profile');
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedCode=text;}}});
  });
  await codeTest.page.locator('[data-readings-action="code"]').click();
  await codeTest.page.locator('[data-readings-action="copy-code"]').click();
  assert.equal(await codeTest.page.evaluate(()=>window.copiedCode),'TEST1234');
  assert.equal(await codeTest.page.locator('[data-readings-action="copy-code"]').innerText(),'Copied');
  await codeTest.page.evaluate(()=>{
    navigator.clipboard.writeText=async()=>{throw new Error('Unavailable');};
    document.execCommand=command=>{if(command==='copy'){window.fallbackCode=document.activeElement.value;return true;}return false;};
  });
  await codeTest.page.locator('[data-readings-action="copy-code"]').click();
  assert.equal(await codeTest.page.evaluate(()=>window.fallbackCode),'TEST1234');
  assert.equal(await codeTest.page.locator('textarea[style*="opacity"]').count(),0);
  assert.deepEqual(codeTest.errors,[]);
  await codeTest.context.close(); console.log(`Reading and Practice regressions passed: ${width}px`);
 }
} finally {await browser.close();}
