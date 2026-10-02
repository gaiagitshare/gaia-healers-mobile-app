async (page) => {
  const base = 'http://127.0.0.1:4178';
  const result = [];
  await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); });
  await page.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  await page.context().route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  await page.addInitScript(() => { localStorage.setItem('gaia-assist-welcome-v3', '1'); localStorage.setItem('gaia-app-tour-v3', '1'); });
  const reset = async scenario => { await page.request.get(base + '/__qa/reset?scenario=' + scenario); await page.goto(base + '/home.html?proxy=' + base); };
  const shot = async (width, name) => { await page.waitForTimeout(name.startsWith('completion') ? 1500 : name === 'intro' ? 1200 : 450); await page.screenshot({ path: `output/playwright/onboarding/${width}-${name}.png` }); const overflow = await page.locator('.gaia-journey').evaluate(el => el.scrollWidth > el.clientWidth); if (overflow) throw new Error('Horizontal overflow: ' + width + '-' + name); };
  const shell = () => page.locator('.gaia-journey');
  const next = async () => { const before = await shell().locator('h1').innerText(); await shell().locator('[data-next]').click(); await page.waitForFunction(old => document.querySelector('.gaia-journey h1')?.textContent !== old, before); };
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    await reset('new'); await shell().locator('[data-begin]').waitFor(); await shot(width, 'intro');
    if (!await page.locator('#gaia-app-shell').evaluate(el => el.inert)) throw new Error('Gate did not lock app');
    await shell().locator('[data-begin]').click(); await shot(width, 'primary-0');
    await shell().locator('[data-choice="Living Beings"]').click(); await shot(width, 'primary-1');
    await shell().locator('[data-choice="Environment"]').click(); await shell().locator('[data-choice="Water"]').click(); await shot(width, 'primary-3');
    await page.request.get(base + '/__qa/fail?value=true'); await shell().locator('[data-next]').click(); await shell().locator('.journey-error').filter({ hasText: 'couldn’t' }).waitFor(); await shot(width, 'save-error');
    if (await shell().locator('[aria-pressed="true"]').count() !== 3) throw new Error('Failure lost selections');
    await page.request.get(base + '/__qa/fail?value=false'); await next();
    await shell().locator('[data-choice]').first().click(); await next(); await shot(width, 'living-beings');
    await shell().locator('[data-choice]').first().click(); await next();
    await shell().locator('[data-choice]').first().click(); await next(); await shot(width, 'environment');
    await shell().locator('[data-choice]').first().click(); await next();
    await shell().locator('[data-choice]').first().click(); await next(); await shot(width, 'water');
    while (await shell().locator('[data-choice]').count()) { await shell().locator('[data-choice]').first().click(); await next(); }
    await shell().locator('textarea').fill('Excited to learn with this community.'); await next(); await shot(width, 'completion'); await shell().evaluate(el => { el.scrollTop = el.scrollHeight; }); await shot(width, 'completion-bottom');
    await shell().locator('[data-enter]').click(); await shell().waitFor({ state: 'detached' });
    if (await page.locator('#gaia-app-shell').evaluate(el => el.inert)) throw new Error('Completion left app locked');
    await page.reload(); await page.waitForFunction(() => window.GaiaJourney?.complete); if (await shell().count()) throw new Error('Completed user gated again');
    await reset('resume'); await shell().locator('[data-begin]').waitFor(); await shot(width, 'resume');
    await shell().locator('[data-begin]').click(); if (!(await shell().locator('h1').innerText()).includes('water')) throw new Error('Wrong resumed step');
    await shell().locator('[data-assist]').click(); await page.locator('.gaia-assist--open').waitFor();
    await page.locator('.journey-embedded [data-choice]').first().click(); await page.waitForTimeout(500); await page.locator('.gaia-assist__transcript').evaluate(el => { el.scrollTop = 0; }); await page.screenshot({ path: `output/playwright/onboarding/${width}-assist.png` });
    await page.locator('.journey-embedded [data-next]').click(); await page.waitForFunction(() => document.querySelector('.journey-embedded h1')?.textContent.includes('business'));
    result.push({ width, states: 12, flow: 'completed, bypassed, resumed, embedded-save', overflow: false });
  }
  await reset('complete'); await page.waitForFunction(() => window.GaiaJourney?.complete); if (await shell().count()) throw new Error('Historical completed member gated');
  await reset('visitor'); await page.waitForTimeout(300); if (await shell().count()) throw new Error('Visitor gated');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reset('new'); await shell().locator('[data-begin]').waitFor();
  await shell().locator('[data-begin]').click(); await shell().locator('[data-choice]').first().click();
  if (await shell().evaluate(el => el.getAnimations({ subtree: true }).some(a => a.playState === 'running'))) throw new Error('Reduced motion left an animation running');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return result;
}
