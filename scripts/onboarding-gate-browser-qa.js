async (page) => {
  const base='http://127.0.0.1:4178', results=[];
  await page.addInitScript(() => { navigator.serviceWorker.register=async()=>({}); localStorage.setItem('onboardingComplete','true');localStorage.setItem('gaia-onboarded','1'); });
  const ctx=page.context();await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const reset=async(scenario,view='today')=>{await page.request.get(base+'/__qa/reset?scenario='+scenario);await page.goto(base+'/home.html?proxy='+base+'&view='+view);};
  const assertLocked=async()=>{
    if(!await page.locator('#gaia-app-shell').isHidden()) throw Error('member shell visible');
    if(await page.locator('[data-screen].is-active').count()) throw Error('protected screen activated');
  };
  await page.setViewportSize({width:1280,height:900});
  let release;
  await ctx.route('**/api/auth/session', async route => { await new Promise(resolve => { release=resolve; }); await route.continue(); });
  await reset('new');
  await assertLocked(); await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-checking.png'});
  if(!await page.locator('#gaia-bootstrap').isVisible()) throw Error('missing bootstrap loading state');
  release(); await ctx.unroute('**/api/auth/session');await page.locator('[data-begin]').waitFor();
  results.push({case:'pending authentication and profile',locked:true,noDashboardFlash:true});
  const tab=await ctx.newPage();await tab.goto(base+'/home.html?proxy='+base+'&view=academy');await tab.locator('[data-begin]').waitFor();
  if(!await tab.locator('#gaia-app-shell').isHidden())throw Error('new tab bypass');await tab.close();
  results.push({case:'restored session in a new tab',locked:true});
  for(const view of ['today','academy','community','events','store','profile','wellness']) {
    await reset('new',view);await page.locator('[data-begin]').waitFor();await assertLocked();
    await page.reload();await page.locator('[data-begin]').waitFor();await assertLocked();
    await page.evaluate(()=>{window.GaiaAppShell.go('academy');window.GaiaAppShell.go('community');});await assertLocked();
    await page.goBack();await assertLocked();await page.goForward();await assertLocked();
    results.push({case:'direct '+view+', refresh, spoofed storage, navigation/history',locked:true});
    if(view==='today') await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-direct-dashboard.png'});
  }
  await reset('complete');await page.waitForFunction(()=>window.GaiaAppGuard?.status==='ready');
  if(!await page.locator('#gaia-app-shell').isVisible())throw Error('completed member locked');
  await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-completed.png'});
  results.push({case:'completed contact',dashboard:true});
  await reset('resume');await page.locator('[data-begin]').waitFor();await assertLocked();await page.locator('[data-begin]').click();
  if(!(await page.locator('.gaia-journey h1').innerText()).includes('water'))throw Error('wrong resume');
  await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-partial.png'});
  await page.locator('[data-assist]').click();await page.locator('.journey-embedded').waitFor();await assertLocked();
  await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-assist.png'});
  results.push({case:'partial resume and onboarding Assist',locked:true});
  await reset('unavailable');await page.locator('[data-retry]').waitFor();await assertLocked();
  await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-unavailable.png'});results.push({case:'GHL failure',locked:true});
  await reset('new');await page.locator('[data-begin]').click();
  const shell=page.locator('.gaia-journey');
  const next=async()=>{const old=await shell.locator('h1').innerText();await shell.locator('[data-next]').click();await page.waitForFunction(old=>document.querySelector('.gaia-journey h1')?.textContent!==old,old);};
  while(await shell.locator('[data-choice]').count()){await shell.locator('[data-choice]').first().click();await next();}
  await page.request.get(base+'/__qa/fail?value=true');await shell.locator('[data-next]').click();await shell.locator('.journey-error').filter({hasText:'couldn’t'}).waitFor();await assertLocked();
  await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-final-failure.png'});results.push({case:'final save failure',locked:true});
  await page.request.get(base+'/__qa/fail?value=false');await next();await assertLocked();await shell.locator('[data-enter]').click();
  await page.waitForFunction(()=>window.GaiaAppGuard?.status==='ready');
  if(!await page.locator('#gaia-app-shell').isVisible())throw Error('verified completion did not unlock');
  await page.waitForTimeout(650);await page.screenshot({path:'output/playwright/onboarding/gate-unlocked.png'});results.push({case:'verified completion',dashboard:true});
  return results;
}
