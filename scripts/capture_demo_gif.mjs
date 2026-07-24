#!/usr/bin/env node
// capture_demo_gif.mjs — headless Playwright capture of the continuity product
// tour, producing the frames + video for the launch demo GIF (the Show HN
// asset described in CONTINUITY_DEMO.md).
//
// It drives the SAME first-run interactive tour a new operator sees
// (src/components/product-tour.tsx): a fresh browser context has an empty
// localStorage, so the tour auto-opens on Mission Control. The script walks it
// beat-by-beat to the aha-moment — "agents are disposable, your context isn't"
// — recording video and a per-beat screenshot filmstrip.
//
// Output (into --out, default dashboard/public/demo):
//   • frame-0..N.png  — one screenshot per tour beat (filmstrip / fallback)
//   • tour.webm       — the raw screen recording (convert to GIF via the
//                       scripts/capture_demo_gif.sh wrapper, which uses ffmpeg)
//
// Usage:
//   DASHBOARD_URL=http://localhost:3210 node scripts/capture_demo_gif.mjs --out dashboard/public/demo
//
// Driven by scripts/capture_demo_gif.sh, which bootstraps Playwright (npx) and
// does the webm→GIF conversion. Kept dependency-light: only `playwright`.

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const BASE = process.env.DASHBOARD_URL || 'http://localhost:3210';
const OUT = path.resolve(argVal('--out', 'dashboard/public/demo'));
const WIDTH = Number(process.env.DEMO_WIDTH || 1200);
const HEIGHT = Number(process.env.DEMO_HEIGHT || 750);
// Milliseconds to dwell on each beat so the GIF reads at a comfortable pace.
const DWELL = Number(process.env.DEMO_DWELL_MS || 2200);

// --- playwright (resolved from wherever the wrapper installed it) -----------
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'FATAL: playwright not found. Run via scripts/capture_demo_gif.sh (it bootstraps Playwright),\n' +
      '       or `npm i -D playwright && npx playwright install chromium` first.',
  );
  process.exit(2);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    recordVideo: { dir: OUT, size: { width: WIDTH, height: HEIGHT } },
    // Fresh storage → the first-run tour auto-opens.
  });
  const page = await context.newPage();

  console.log(`→ opening ${BASE} (fresh context, tour should auto-open)`);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {
    /* networkidle can hang on live-polling pages; the tour check below is the real gate */
  });

  // The tour may need a tick to mount + read localStorage.
  const tour = page.locator('[data-testid="product-tour"]');
  try {
    await tour.waitFor({ state: 'visible', timeout: 8_000 });
  } catch {
    // Not auto-open (e.g. seen flag persisted, or a non-first-run stack) — trigger the replay event.
    console.log('  tour not auto-open — dispatching replay event');
    await page.evaluate(() => window.dispatchEvent(new Event('myai:tour:start')));
    await tour.waitFor({ state: 'visible', timeout: 8_000 });
  }

  // Walk every beat: screenshot, dwell, advance. Stop when the CTA (last beat) shows.
  let frame = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(DWELL);
    const title = await page.locator('[data-testid="tour-title"]').textContent().catch(() => '');
    console.log(`  beat ${frame}: ${title?.trim().slice(0, 60)}`);
    await page.screenshot({ path: path.join(OUT, `frame-${frame}.png`) });
    frame++;

    const cta = page.locator('[data-testid="tour-cta"]');
    if (await cta.isVisible().catch(() => false)) {
      // Last beat — hold on the line, then we're done.
      await page.waitForTimeout(DWELL);
      break;
    }
    const next = page.locator('[data-testid="tour-next"]');
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
  }

  console.log(`✓ captured ${frame} beat(s)`);
  await context.close(); // flushes the video file
  await browser.close();

  // Playwright names the video with a random id; surface where it landed.
  const { readdir, rename } = await import('node:fs/promises');
  const files = await readdir(OUT);
  const webm = files.find((f) => f.endsWith('.webm'));
  if (webm && webm !== 'tour.webm') {
    await rename(path.join(OUT, webm), path.join(OUT, 'tour.webm'));
  }
  if (existsSync(path.join(OUT, 'tour.webm'))) {
    console.log(`✓ video → ${path.join(OUT, 'tour.webm')}`);
  } else {
    console.warn('! no video produced (headless recording may be unsupported here); frames still written');
  }
}

main().catch((err) => {
  console.error('capture failed:', err?.message || err);
  process.exit(1);
});
