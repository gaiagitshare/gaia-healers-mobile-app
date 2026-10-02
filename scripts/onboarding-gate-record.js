async (page) => {
 const context=await page.context().browser().newContext({viewport:{width:1280,height:900},recordVideo:{dir:'output/playwright/onboarding/gate-motion',size:{width:1280,height:900}}});
 await context.addInitScript(()=>{navigator.serviceWorker.register=async()=>({});});
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const demo=await context.newPage(),base='http://127.0.0.1:4178';
 async function show(scenario,view='today'){await demo.request.get(base+'/__qa/reset?scenario='+scenario);await demo.goto(base+'/home.html?proxy='+base+'&view='+view);await demo.waitForTimeout(1200);}
 await show('complete');await demo.waitForFunction(()=>window.GaiaAppGuard?.status==='ready');await demo.waitForTimeout(1200);
 await show('new');await demo.waitForTimeout(1200);
 await show('resume');await demo.locator('[data-begin]').click();await demo.waitForTimeout(1500);
 await show('new','academy');await demo.waitForTimeout(1500);
 await demo.locator('[data-begin]').click();const shell=demo.locator('.gaia-journey');
 async function next(){const old=await shell.locator('h1').innerText();await shell.locator('[data-next]').click();await demo.waitForFunction(old=>document.querySelector('.gaia-journey h1')?.textContent!==old,old);await demo.waitForTimeout(250);}
 while(await shell.locator('[data-choice]').count()){await shell.locator('[data-choice]').first().click();await next();}
 await next();await demo.waitForTimeout(1400);await shell.locator('[data-enter]').click();await demo.waitForFunction(()=>window.GaiaAppGuard?.status==='ready');await demo.waitForTimeout(1600);
 const video=await demo.video().path();await context.close();return{video,scope:'Synthetic authenticated session bootstrap and CRM states; actual app guard and save flow.'};
}
