import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('/root/pw-test/node_modules/playwright-core');
const OUT=process.argv[2]||'/tmp/gaia-sandbox-browser';fs.mkdirSync(OUT,{recursive:true});
const PW=(/^BETA_PASSWORD=(.*)$/m.exec(fs.readFileSync('/root/.config/gaia-membership-beta.env','utf8'))||[])[1];
const BASE='http://127.0.0.1:8800';const rows=[];
function check(name,value){rows.push({name,pass:!!value});if(!value)throw new Error(name);}
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome'});
for(const [width,height] of [[1440,900],[390,844]]){
 const ctx=await browser.newContext({viewport:{width,height},extraHTTPHeaders:{'X-Real-IP':`198.51.100.${width===1440?240:241}`}});let external=0,errors=0;
 await ctx.route('**/*',r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();if(!['cdn.courses.apisystem.tech','storage.googleapis.com','www.youtube-nocookie.com','player.vimeo.com'].includes(new URL(r.request().url()).hostname))external++;return r.abort();});
 const p=await ctx.newPage();p.on('pageerror',()=>errors++);
 const body=()=>p.locator('body').innerText();
 const go=async tab=>{await p.goto(BASE+'/sandbox/'+tab);check(`${width} ${tab} loads`,await p.locator('h1').count()===1);};
 const form=(action)=>p.locator(`form:has(input[name="action"][value="${action}"])`).first();
 const submit=async f=>{await f.locator('button[type=submit]').click();await p.waitForLoadState('domcontentloaded');};
 const actor=async a=>{const d=p.locator('main > details').first();if(!await d.getAttribute('open'))await d.locator('summary').click();const f=form('actor');await f.locator('select').selectOption(a);await submit(f);check(`${width} role ${a}`,await p.locator('main > details > summary').first().innerText().then(t=>t.includes('as '+a)));};
 try{
  let r=await ctx.request.get(BASE+'/sandbox',{maxRedirects:0});check(`${width} password gate`,[401,303].includes(r.status()));
  await p.goto(BASE+'/');await p.fill('#pw',PW);await p.locator('button[type=submit]').click();await p.waitForURL(/choose/);check(`${width} chooser sandbox link`,await p.getByRole('link',{name:'Open the working membership sandbox'}).count()===1);
  await p.getByRole('link',{name:'Open the working membership sandbox'}).click();await p.waitForURL(/sandbox/);external=0;
  await go('membership');let f=p.locator('section.card').filter({has:p.getByRole('heading',{name:'Professional',exact:true})}).locator('form');await f.locator('details.payment-simulation > summary').click();await f.locator('select[name=outcome]').selectOption('authentication');await f.locator('input[name=consent]').check();await submit(f);check(`${width} exact quote`,(await body()).includes('Charge today: $50.00'));check(`${width} access before quote confirmed`,(await p.locator('section.card').first().innerText()).includes('Standard'));
  f=form('checkout_confirm');await f.locator('input[name=consent]').check();await submit(f);check(`${width} auth holds access`,(await body()).includes('Pending authentication for Professional'));await submit(form('authenticate'));check(`${width} auth activates Professional`,(await p.locator('section.card').first().innerText()).includes('Professional'));
  await go('wallet');f=form('job');await f.locator('input[name=consent]').check();await submit(f);check(`${width} wallet charged`,(await body()).includes('1,960 coins'));f=form('job');await f.locator('select').selectOption('failure');await f.locator('input[name=consent]').check();await submit(f);check(`${width} failed job no charge`,(await body()).includes('1,960 coins'));await p.screenshot({path:OUT+`/wallet-${width}.png`,fullPage:true});
  await go('access');check(`${width} courses and VIP gates`,(await body()).includes('With Inner Circle'));await p.locator('a[href="/sandbox/academy?course=courses.core"]').click();check(`${width} included course opens content status`,(await body()).includes('Course lessons'));await go('access');
  await actor('practitioner');await go('practice');f=form('plan_save');await f.locator('input[name=name]').fill('Essential wellness');await submit(f);check(`${width} draft saved`,(await body()).includes('Draft awaiting publication'));await submit(form('publish'));check(`${width} published`,(await body()).includes('New immutable plan version published'));
  await actor('client');await go('clients');f=form('client_buy');await f.locator('input[name=consent]').check();await submit(f);check(`${width} client consent`,(await body()).includes('Recurring billing consent recorded'));await submit(form('client_pause'));check(`${width} client paused`,(await body()).includes('Resumes'));await submit(form('client_resume'));check(`${width} client resumed`,(await body()).includes('Subscription resumed'));
  await actor('practitioner');await go('practice');check(`${width} fee ledger`,(await body()).includes('$7.35'));await p.screenshot({path:OUT+`/practitioner-${width}.png`,fullPage:true});
  await go('crm');await submit(form('crm'));await submit(form('lead'));await submit(form('booking'));await submit(form('message'));check(`${width} CRM contact booking and message`,(await body()).includes('Demo Prospect')&&(await body()).includes('local preview only'));
  await actor('support');await go('staff');await submit(form('request'));check(`${width} request pending`,(await body()).includes('requested by support'));await actor('finance');await submit(form('approve'));check(`${width} approval separate from execute`,(await body()).includes('Execution is an explicit separate step'));await submit(form('execute'));check(`${width} action executed`,(await body()).includes('Approved test action executed once'));
  await actor('member');await go('wallet');check(`${width} goodwill balance`,(await body()).includes('125 coins'));
  await go('membership');f=p.locator('section.card').filter({has:p.getByRole('heading',{name:'Standard',exact:true})}).locator('form');await f.locator('input[name=consent]').check();await submit(f);f=form('checkout_confirm');await f.locator('input[name=consent]').check();await submit(f);check(`${width} downgrade scheduled`,(await body()).includes('Change scheduled'));
  await actor('owner');await go('testing');f=form('clock');await f.locator('input[name=days]').fill('32');await submit(f);await go('membership');check(`${width} scheduled downgrade applied`,(await p.locator('section.card').first().innerText()).includes('Standard'));
  for(const tab of ['overview','membership','wallet','practice','clients','crm','access','services','operations','staff','testing']){await go(tab);check(`${width} ${tab} responsive`,await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await go('overview');await p.screenshot({path:OUT+`/overview-${width}.png`,fullPage:true});
  check(`${width} no page errors`,errors===0);check(`${width} sandbox has no unexpected requests (course media blocked by test)`,external===0);
  await go('testing');await submit(form('reset'));check(`${width} reset clears workspace`,(await body()).includes('workspace has been reset'));
 }catch(e){rows.push({name:`${width} walkthrough stopped: ${String(e.message).slice(0,160)}`,pass:false});await p.screenshot({path:OUT+`/failure-${width}.png`,fullPage:true});}
 await ctx.close();
}
await browser.close();fs.writeFileSync(OUT+'/results.json',JSON.stringify(rows,null,2));console.log(`${rows.filter(x=>x.pass).length}/${rows.length} sandbox browser checks passed`);for(const r of rows.filter(x=>!x.pass))console.log('FAIL '+r.name);if(rows.some(x=>!x.pass))process.exitCode=1;
