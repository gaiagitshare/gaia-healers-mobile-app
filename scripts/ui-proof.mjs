#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.GAIA_PROOF_ROOT || path.resolve(__dirname, '..');
const OUT = process.env.GAIA_PROOF_OUT || path.join(ROOT, 'docs', 'ui-proof');
const BASE = process.env.GAIA_PROOF_BASE || 'http://127.0.0.1:8765';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const pages = [
  ['index.html', 'splash'],
  ['home.html?view=today', 'today'],
  ['home.html?view=journey', 'journey'],
  ['home.html?view=academy', 'academy'],
  ['home.html?view=community', 'community'],
  ['home.html?view=events', 'events'],
  ['home.html?view=bookings', 'bookings'],
  ['home.html?view=inbox', 'inbox'],
  ['home.html?view=wellness', 'wellness'],
  ['home.html?view=store', 'store'],
  ['home.html?view=profile', 'profile'],
];

const devices = {
  mobile: { width: 390, height: 844, label: 'iPhone 14' },
  tablet: { width: 768, height: 1024, label: 'iPad' },
  desktop: { width: 1440, height: 900, label: 'Desktop' },
};

const report = [];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const key of Object.keys(devices)) {
    fs.mkdirSync(path.join(OUT, key), { recursive: true });
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--hide-scrollbars', '--disable-gpu'],
  });
  const page = await browser.newPage();

  for (const [deviceKey, vp] of Object.entries(devices)) {
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: deviceKey === 'desktop' ? 1 : 2,
      isMobile: deviceKey !== 'desktop',
      hasTouch: deviceKey !== 'desktop',
    });

    for (const [urlPath, name] of pages) {
      const url = `${BASE}/${urlPath}`;
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 }).catch(() =>
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      );
      await page.waitForSelector('body', { timeout: 12000 });
      if (name === 'today') {
        await page.evaluate(() => {
          window.GAIA = window.GAIA || {};
          window.GAIA.event = {
            id: 1,
            name: 'Gaia Healers Elevate Conference 2026',
            startDate: '2026-11-20T09:00:00',
            endDate: '2026-11-22T18:00:00',
            venue: 'Rosen Shingle Creek, Orlando, FL',
            location: 'Rosen Shingle Creek, Orlando, FL',
            registrationUrl: 'https://elevate.gaiahealers.com/#tickets',
            registrationLabel: 'Buy Ticket',
          };
          document.dispatchEvent(new CustomEvent('gaia:sync', { detail: window.GAIA }));
        }).catch(() => {});
        await page.waitForSelector('.g-feature-event, .g-super-event--empty', { timeout: 8000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 900));

      const metrics = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        title: document.title,
      }));

      const file = path.join(OUT, deviceKey, `${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      const entry = {
        device: deviceKey,
        deviceLabel: vp.label,
        page: name,
        url: urlPath,
        overflow: metrics.overflow,
        file: `docs/ui-proof/${deviceKey}/${name}.png`,
      };
      report.push(entry);
      const flag = metrics.overflow > 2 ? ' OVERFLOW' : '';
      console.log(`${deviceKey}/${name}${flag}`);
    }
  }

  await browser.close();

  const indexHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gaia UI proof — ${new Date().toISOString().slice(0, 10)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b120e;color:#e8f0e8;margin:0;padding:24px}
  h1,h2{color:#a8e063} section{margin:32px 0} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
  figure{margin:0;background:#111a14;border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:hidden}
  figcaption{padding:10px 12px;font-size:13px} img{display:block;width:100%;height:auto;background:#000}
  .bad{color:#ff8a80}
</style></head><body>
<h1>Gaia Healers UI proof</h1>
<p>Generated ${new Date().toLocaleString()} · Base: ${BASE}</p>
${Object.keys(devices).map((d) => `<section><h2>${devices[d].label} (${d})</h2><div class="grid">${report.filter((r) => r.device === d).map((r) => `<figure><a href="${d}/${r.page}.png"><img src="${d}/${r.page}.png" alt="${r.page}"/></a><figcaption>${r.page}${r.overflow > 2 ? ' <span class="bad">overflow</span>' : ''}</figcaption></figure>`).join('')}</div></section>`).join('')}
</body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), indexHtml);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nProof gallery: ${path.join(OUT, 'index.html')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
