#!/usr/bin/env node
/**
 * capture_docs_media.mjs — Playwright capture harness for the docs-site walkthroughs.
 *
 * Drives the LIVE dashboard (http://localhost:3210) through three scenes —
 * `quickstart`, `brain`, `continuity` — captures a numbered PNG frame sequence
 * per scene into docs/media/frames/<scene>/, saves a poster PNG, and (when an
 * encoder is present) stitches the frames into an animated GIF at
 * docs/media/img/<scene>.gif.
 *
 * The video SCRIPTS (docs/media/scripts/*.md) are the storyboards this follows;
 * the terminal beats in those scripts are recorded separately and spliced — this
 * harness owns only the browser frames + posters.
 *
 * Zero repo dependencies by design: Playwright is NOT a dependency of this repo
 * (the npm package must stay dep-light). Run this where Playwright is available:
 *
 *     npx playwright install chromium         # once
 *     node scripts/capture_docs_media.mjs                 # all scenes
 *     node scripts/capture_docs_media.mjs --scene brain   # one scene
 *     node scripts/capture_docs_media.mjs --base http://localhost:3210
 *
 * GIF encoding uses whichever of these is on PATH (checked in order):
 *   - gifski   (best quality)   gifski --fps 10 -o out.gif frames/*.png
 *   - ffmpeg   (ubiquitous)     ffmpeg -framerate 10 -i frame-%03d.png ... out.gif
 * If neither is present, frames + poster are still written and the exact
 * encode command is printed — nothing is silently skipped.
 *
 * Never touches the gateway stack lifecycle (no compose up/down) — it only
 * navigates and screenshots a stack you already have running.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = path.join(REPO_ROOT, 'docs', 'media');
const FRAMES_ROOT = path.join(MEDIA_DIR, 'frames');
const IMG_DIR = path.join(MEDIA_DIR, 'img');

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (flag, def) => { const i = argv.indexOf(flag); return i > -1 ? argv[i + 1] : def; };
const BASE = arg('--base', process.env.DASHBOARD_URL || 'http://localhost:3210');
const ONLY = arg('--scene', null);
const FPS = Number(arg('--fps', '10'));
const VIEWPORT = { width: 1280, height: 720 };

// ── scenes ──────────────────────────────────────────────────────────────────
// Each scene is an ordered list of beats. A beat navigates (optionally waits for
// a selector / settle time) and captures a frame. The last `poster:true` beat
// (or the final beat) is copied to docs/media/img/<scene>-poster.png.
const SCENES = {
  quickstart: {
    // install → running dashboard: the /welcome greeting + the /directory of managed repos
    beats: [
      { path: '/welcome', settle: 1200, poster: true },
      { path: '/welcome', settle: 400 },
      { path: '/directory', settle: 1200 },
      { path: '/status', settle: 1000 },
    ],
  },
  brain: {
    // git-versioned memory: the /brain page — atom counts, last SHA, compiled brief
    beats: [
      { path: '/brain', settle: 1400, poster: true },
      { path: '/brain', settle: 500 },
      { path: '/memory', settle: 1200 },
    ],
  },
  continuity: {
    // context served, not rebuilt: work-in-flight + cold-start tokens saved
    beats: [
      { path: '/work', settle: 1400 },
      { path: '/savings', settle: 1400, poster: true },
      { path: '/savings', settle: 500 },
    ],
  },
};

// ── encoder discovery ─────────────────────────────────────────────────────────
function onPath(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function encodeGif(scene, frameFiles) {
  const out = path.join(IMG_DIR, `${scene}.gif`);
  const framesGlob = path.join(FRAMES_ROOT, scene, 'frame-%03d.png');
  if (onPath('gifski')) {
    const r = spawnSync('gifski', ['--fps', String(FPS), '-o', out, ...frameFiles], { stdio: 'inherit' });
    return r.status === 0 ? out : null;
  }
  if (onPath('ffmpeg')) {
    const palette = path.join(FRAMES_ROOT, scene, 'palette.png');
    spawnSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', framesGlob,
      '-vf', 'palettegen', palette], { stdio: 'inherit' });
    const r = spawnSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', framesGlob,
      '-i', palette, '-lavfi', 'paletteuse', '-loop', '0', out], { stdio: 'inherit' });
    return r.status === 0 ? out : null;
  }
  console.log(`\n  ⚠ no GIF encoder on PATH — frames written to docs/media/frames/${scene}/`);
  console.log(`    encode manually with either:`);
  console.log(`      gifski --fps ${FPS} -o docs/media/img/${scene}.gif docs/media/frames/${scene}/frame-*.png`);
  console.log(`      ffmpeg -framerate ${FPS} -i docs/media/frames/${scene}/frame-%03d.png -loop 0 docs/media/img/${scene}.gif`);
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('✗ Playwright not installed. This harness runs where Playwright is available:');
    console.error('    npm i -D playwright && npx playwright install chromium');
    console.error('  (Playwright is intentionally NOT a dependency of this repo — it stays dep-light.)');
    process.exit(2);
  }

  const scenes = ONLY ? { [ONLY]: SCENES[ONLY] } : SCENES;
  if (ONLY && !SCENES[ONLY]) {
    console.error(`✗ unknown scene "${ONLY}". Known: ${Object.keys(SCENES).join(', ')}`);
    process.exit(2);
  }

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  for (const [scene, def] of Object.entries(scenes)) {
    const dir = path.join(FRAMES_ROOT, scene);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n▶ scene "${scene}" → ${def.beats.length} beats`);
    const frameFiles = [];
    let posterSrc = null;

    for (let n = 0; n < def.beats.length; n++) {
      const beat = def.beats[n];
      const url = BASE + beat.path;
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      } catch {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
      if (beat.selector) await page.waitForSelector(beat.selector, { timeout: 8000 }).catch(() => {});
      if (beat.settle) await page.waitForTimeout(beat.settle);
      const frame = path.join(dir, `frame-${String(n).padStart(3, '0')}.png`);
      await page.screenshot({ path: frame });
      frameFiles.push(frame);
      if (beat.poster) posterSrc = frame;
      console.log(`  · frame ${n}  ${beat.path}`);
    }

    // poster: explicit poster beat, else the first frame
    posterSrc = posterSrc || frameFiles[0];
    if (posterSrc) fs.copyFileSync(posterSrc, path.join(IMG_DIR, `${scene}-poster.png`));

    const gif = encodeGif(scene, frameFiles);
    if (gif) console.log(`  ✓ ${path.relative(REPO_ROOT, gif)}`);
    console.log(`  ✓ ${path.relative(REPO_ROOT, path.join(IMG_DIR, `${scene}-poster.png`))}`);
  }

  await browser.close();
  console.log('\n✓ capture complete. Rebuild the site: node scripts/build_docs.mjs');
}

main().catch((e) => { console.error(e); process.exit(1); });
