async (page) => {
  const base='http://127.0.0.1:4178'; const results=[];const sent=[];
  await page.context().unroute('**/*');
  await page.context().route('**/*', route => new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.addInitScript(()=>{navigator.serviceWorker.register=async()=>({});localStorage.setItem('gaia-assist-welcome-v3','1');localStorage.setItem('gaia-tour-v1','1');});
  await page.route('**/api/assist/chat/stream', async route=>{
    const body=route.request().postDataJSON();sent.push(body);
    const state=await page.evaluate(()=>window.GaiaAppGuard.status==='onboarding_required'?'onboarding':window.GaiaMember?.authed?'member':'visitor');
    const action=await page.evaluate(({body,state})=>window.GaiaAssistGuide.chooseAction(body.prompt,{...body,state}),{body,state});
    const reply=action?.type==='start_path'?'Your Gaia Path helps personalize your interests. Sign in to save it; no paid subscription is required.':'Here is the next available action.';
    await route.fulfill({status:200,contentType:'text/event-stream',body:`event: meta\ndata: ${JSON.stringify({ok:true,action})}\n\nevent: delta\ndata: ${JSON.stringify({text:reply})}\n\nevent: done\ndata: ${JSON.stringify({ok:true,reply})}\n\n`});
  });
  const reset=async scenario=>{await page.request.get(base+'/__qa/reset?scenario='+scenario);await page.goto(base+'/home.html?proxy='+base);await page.waitForFunction(()=>window.GaiaAppGuard && !['authenticating','checking_profile'].includes(window.GaiaAppGuard.status));};
  const open=async()=>{await page.evaluate(()=>window.dispatchEvent(new CustomEvent('gaia:open-assist')));await page.locator('#gaia-assist-prompt').waitFor();};
  const ask=async text=>{await page.locator('#gaia-assist-prompt').fill(text);await page.locator('#gaia-assist-prompt').press('Enter');await page.waitForTimeout(500);};
  await page.setViewportSize({width:390,height:844});await reset('visitor');await open();await ask('Where do I start?');
  await page.getByRole('button',{name:'Discover My Gaia Path'}).waitFor();
  await page.screenshot({path:'output/assist-quality/visitor-mobile.png'});
  await page.getByRole('button',{name:'Not now',exact:true}).click();await ask('Where do I start?');
  if(await page.getByRole('button',{name:'Discover My Gaia Path'}).isVisible())throw Error('Repeated declined CTA');
  if(!sent.at(-1).declined.includes('discovery'))throw Error('Decline not sent to model');results.push('visitor path CTA; decline retained');
  await reset('visitor');await open();await ask('Where do I start?');await page.getByRole('button',{name:'Discover My Gaia Path'}).click();
  if(!await page.locator('input[type=email]').first().isVisible())throw Error('Path action did not open sign-in');results.push('path CTA opens account controls');
  await reset('complete');await open();await ask('I paid but cannot access this');await page.getByRole('button',{name:'Contact Support'}).waitFor();
  if(await page.getByRole('button',{name:'View Membership'}).count())throw Error('Support pitch');await page.screenshot({path:'output/assist-quality/support-mobile.png'});results.push('member support without sales');
  await reset('resume');await page.locator('[data-begin]').click();await page.locator('[data-assist]').click();await ask('I already completed the original form');await page.getByRole('button',{name:'Check My Profile'}).waitFor();
  if(!await page.locator('#gaia-app-shell').evaluate(e=>e.inert))throw Error('Gate bypass');await page.screenshot({path:'output/assist-quality/onboarding-recheck.png'});results.push('onboarding recheck; shell remains locked');
  return {results,requests:sent.length};
}
