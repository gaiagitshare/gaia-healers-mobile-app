async (page) => {
const context = await page.context().browser().newContext({viewport:{width:1280,height:900},recordVideo:{dir:'output/playwright/onboarding/motion',size:{width:1280,height:900}}});
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); localStorage.setItem('gaia-assist-welcome-v3','1'); localStorage.setItem('gaia-app-tour-v3','1'); });
await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const demo = await context.newPage();
const result = await (async (page) => {
  const base = 'http://127.0.0.1:4178';
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.request.get(base + '/__qa/reset?scenario=new');
  await page.goto(base + '/home.html?proxy=' + base);
  const shell = page.locator('.gaia-journey');
  await shell.locator('[data-begin]').waitFor();
  await page.waitForTimeout(1300);
  await shell.locator('[data-begin]').click();
  for (const label of ['Living Beings', 'Environment', 'Water']) {
    await shell.locator(`[data-choice="${label}"]`).click();
    await page.waitForTimeout(700);
  }
  const next = async () => { const old = await shell.locator('h1').innerText(); await shell.locator('[data-next]').click(); await page.waitForFunction(old => document.querySelector('.gaia-journey h1')?.textContent !== old, old); await page.waitForTimeout(700); };
  await next();
  while (await shell.locator('[data-choice]').count()) { await shell.locator('[data-choice]').first().click(); await page.waitForTimeout(300); await next(); }
  await shell.locator('textarea').fill('Learning together.');
  await next(); await page.waitForTimeout(1500);
  await shell.locator('[data-enter]').click();
  await page.request.get(base + '/__qa/reset?scenario=resume');
  await page.goto(base + '/home.html?proxy=' + base);
  await shell.locator('[data-begin]').click();
  await shell.locator('[data-assist]').click();
  await page.waitForTimeout(800);
  // Orb state illustration only: no live microphone/provider in the synthetic preview.
  for (const state of ['listening', 'thinking', 'speaking']) {
    await page.evaluate(state => {
      const root = document.querySelector('.gaia-assist');
      for (const name of ['listening', 'thinking', 'speaking']) root.classList.toggle('gaia-assist--' + name, state === name);
      root.style.setProperty('--gaia-input-level', '.5'); root.style.setProperty('--gaia-output-level', '.5');
      document.querySelector('.gaia-assist__status')?.replaceChildren(document.createTextNode('State illustration: ' + state));
    }, state);
    await page.waitForTimeout(1400);
  }
  return { onboarding: 'actual synthetic save flow', orb: 'state illustration; no live voice' };
}
)(demo);
const video = await demo.video().path();
await context.close(); return {result,video};
}