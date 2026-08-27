/* smoke.mjs — headless check for Maestro Yards.
 *
 *   node smoke.mjs <url> [--out shot.png] [--steps 60] [--dpr 1]
 *
 * Adapted from the isometric-explainer skill's script. The only change: this
 * town has a station — `refused` — that a successful request never visits, so
 * the run is done twice, once with a good key and once with a bad one, and the
 * station coverage check is made against the union of both.
 *
 * A canvas app fails silently: one thrown error and you get an empty frame on a
 * page that still looks fine. This loads the page, fails on any console error or
 * page error, steps the van through every station, and writes two screenshots —
 * the riding camera and the whole town.
 *
 * LOOK AT THE SCREENSHOTS. Occlusion, label collisions and plates landing on
 * empty ground do not raise errors.
 *
 * Requires playwright:  npm i -D playwright && npx playwright install chromium
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let chromium;
try {
  const req = createRequire(pathToFileURL(process.cwd() + '/'));
  chromium = req('playwright').chromium;
} catch {
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright not found. From a scratch directory, run:');
    console.error('  npm i playwright && npx playwright install chromium');
    console.error('Or skip this check and open index.html in a browser instead.');
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

if (!url) {
  console.error('usage: node smoke.mjs <url> [--out shot.png] [--steps 60] [--dpr 1]');
  process.exit(2);
}

const out = flag('out', 'smoke.png');
const maxSteps = Number(flag('steps', 60));
const dpr = Number(flag('dpr', 1));

const fail = [];
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: dpr
});

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') fail.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => fail.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => fail.push(`requestfailed: ${r.url()}`));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1000);

const globals = await page.evaluate(() =>
  ['Iso', 'RM', 'World', 'Sim', 'Renderer', 'UI'].filter((k) => !window[k])
);
if (globals.length) fail.push(`missing globals: ${globals.join(', ')}`);

const seen = [];

async function walk(label, setup) {
  let finished = false;
  await page.evaluate(setup);
  for (let i = 0; i < maxSteps; i++) {
    await page.evaluate(() => {
      window.Sim.state.speed = 8;
      window.Sim.step();
    });
    await page.waitForTimeout(420);
    const st = await page.evaluate(() => ({
      station: window.Sim.state.station,
      finished: window.Sim.state.finished
    }));
    if (st.station) seen.push(st.station);
    if (st.finished) { finished = true; break; }
  }
  if (!finished) fail.push(`${label}: run did not finish within ${maxSteps} steps`);
  return finished;
}

if (!globals.length) {
  /* Pass 1: the default run — a rate-limited primary, so the fallback lap of
     the attempt loop is exercised too. */
  await walk('delivered run', () => { window.UI.run(); });
  await page.screenshot({ path: out });

  /* Pass 2: a bad key, which is refused at the gatehouse and reverses down the
     avenue. This is the only way `refused` ever fires. */
  await walk('refused run', () => {
    document.getElementById('apikey').checked = false;
    window.Sim.state.apiKeyOk = false;
    window.UI.run();
  });

  const expected = await page.evaluate(() =>
    Object.values(window.World.stations).flat().map((s) => s.id)
  );
  const missed = expected.filter((id) => !seen.includes(id));
  if (missed.length) fail.push(`stations never fired: ${missed.join(', ')}`);

  /* And the whole town, so the layout can be checked as a layout. */
  await page.evaluate(() => {
    document.getElementById('follow').checked = false;
    document.getElementById('zoom-fit').click();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out.replace(/\.png$/, '') + '-fit.png' });
}

await browser.close();

const unique = [...new Set(seen)];
console.log(`stations visited (${unique.length}): ${unique.join(' → ') || '—'}`);
console.log(`screenshots: ${out}, ${out.replace(/\.png$/, '')}-fit.png`);

if (fail.length) {
  console.error(`\nFAIL (${fail.length}):`);
  for (const f of fail) console.error('  ' + f);
  process.exit(1);
}
console.log('\nPASS — no console or page errors. Now look at the screenshots.');
