// Isolated loopback browser verification. No real providers or customer accounts.
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.BETA_PLAYWRIGHT_MODULE||'/root/pw-test/node_modules/playwright-core');
const base='http://127.0.0.1:8800',out=process.argv[2];fs.mkdirSync(out,{recursive:true});
const password=(/^BETA_PASSWORD=(.*)$/m.exec(fs.readFileSync(process.env.BETA_ENV_FILE||'/root/.config/gaia-membership-beta.env','utf8'))||[])[1];
const browser=await chromium.launch({executablePath:process.env.BETA_CHROMIUM||'/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome'}),rows=[];
for(const width of [1440,768,390]) {
 const c=await browser.newContext({viewport:{width,height:1000},extraHTTPHeaders:{'X-Real-IP':'198.51.100.'+(width===1440?231:width===768?232:233)}});
 await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const check=(name,pass)=>{rows.push({name:width+' '+name,pass:!!pass});if(!pass)throw Error(name);};
 const go=async path=>{await p.goto(base+path);await p.evaluate(()=>document.fonts.ready);};
 const form=action=>p.locator(`form:has(input[name=action][value="${action}"])`).first();
 const submit=async action=>{await form(action).locator('button[type=submit]').click();await p.waitForLoadState('domcontentloaded');};
 try {
  await go('/');await p.fill('#pw',password);await p.locator('button[type=submit]').click();await p.waitForURL(/choose/);
  for(const [plan,name] of [['free','Free'],['standard','Standard'],['professional','Professional'],['inner_circle','Inner Circle']]) {
   await go('/sandbox/testing');await form('scenario').locator('[name=plan]').selectOption(plan);await submit('scenario');
   await go('/sandbox');check(plan+' membership shown',(await p.locator('body').innerText()).includes(name));
   check(plan+' home fits',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await go('/sandbox/academy');check(plan+' academy fits',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const me=await p.evaluate(async()=>await(await fetch('/api/membership2/me')).json());
   const courses=await p.evaluate(async()=>await(await fetch('/api/member/courses')).json());
   check(plan+' app and page agree on playable courses',courses.courses.every(x=>x.state==='unlocked'));
   check(plan+' wallet present',!!me.wallet&&Number.isInteger(me.wallet.total.coins));
  }
  await go('/sandbox/account');await form('profile_save').locator('[name=name]').fill('Fictional Browser Tester');await submit('profile_save');
  check('profile feedback visible',(await p.locator('body').innerText()).includes('Your profile has been saved.'));
  check('app receives updated profile',await p.evaluate(async()=>{const a=await(await fetch('/api/auth/session')).json(),b=await(await fetch('/api/member/profile')).json();return a.member.name==='Fictional Browser Tester'&&b.profile.name===a.member.name&&b.profile.contactId===a.member.contactId;}));
  await p.screenshot({path:out+`/account-${width}.png`,fullPage:true});
  await go('/sandbox/academy?course=beta_orientation&lesson=tour');
  await p.locator('video').evaluate(v=>new Promise((resolve,reject)=>{if(v.readyState>=1)return resolve();v.onloadedmetadata=resolve;v.onerror=reject;setTimeout(()=>reject(Error('metadata timeout')),15000);}));
  await p.locator('video').evaluate(async v=>{await v.play();v.currentTime=24;v.pause();});
  await p.getByText('Playback position saved.',{exact:true}).waitFor();check('position saved',true);
  await p.reload();await p.getByText('Resumed from your saved position.',{exact:true}).waitFor();
  check('video resumes after reload',await p.locator('video').evaluate(v=>v.currentTime>=23&&v.currentTime<26));
  check('learning script permitted by CSP',errors.length===0);
  check('lesson navigation has no hidden horizontal overflow',await p.locator('.lesson-list ol').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  await p.screenshot({path:out+`/player-${width}.png`,fullPage:true});
  await submit('lesson_complete');await go('/sandbox/path');check('Personal Path includes started course',(await p.locator('body').innerText()).includes('Continue Getting started'));
  await submit('path_event');check('dismissed path stays hidden',!(await p.locator('body').innerText()).includes('Continue Getting started'));
  await p.reload();check('path dismissal persists',!(await p.locator('body').innerText()).includes('Continue Getting started'));
  await go('/sandbox');await p.screenshot({path:out+`/home-${width}.png`,fullPage:true});
  check('navigation links have accessible names',await p.locator('.experience-rail nav a').evaluateAll(as=>as.every(a=>a.getAttribute('aria-label')||a.textContent.trim())));
  check('forged progress CSRF refused',await p.evaluate(async()=>{const r=await fetch('/sandbox/learning-position',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf:'forged',course:'beta_orientation',lesson:'tour',seconds:2})});return r.status===403;}));
  await p.evaluate(()=>fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));
  check('signout removes profile',await p.evaluate(async()=>(await(await fetch('/api/member/profile')).json()).profile===null));
  check('signout removes Academy grants',await p.evaluate(async()=>(await(await fetch('/api/member/courses')).json()).courses.length===0));
  await go('/sandbox/academy?course=beta_orientation');check('signed out player hidden',await p.locator('video').count()===0);
  check('no browser exceptions',errors.length===0);
 } catch(e){rows.push({name:width+' STOP '+String(e.message).slice(0,180),pass:false});await p.screenshot({path:out+`/failure-${width}.png`,fullPage:true});}
 await c.close();
}
await browser.close();fs.writeFileSync(out+'/results.json',JSON.stringify(rows,null,2));console.log(`${rows.filter(x=>x.pass).length}/${rows.length} consistency browser checks passed`);for(const r of rows.filter(x=>!x.pass))console.log('FAIL '+r.name);if(rows.some(x=>!x.pass))process.exitCode=1;
