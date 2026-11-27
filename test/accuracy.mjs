#!/usr/bin/env node
// Measure a detector's accuracy on labelled samples, using the extension's own provider code.
//
//   node test/accuracy.mjs [options]
//
//   --provider custom|sightengine|hive|metadata   (default: custom)
//   --threshold 0.8                                flag at or above this score
//   --no-metadata                                  skip the metadata check (the extension runs it first by default)
//   --dir test/site/fixtures/external              must contain ai/ and real/ subfolders
//   --json                                         print raw results as JSON
//   --concurrency N                                parallel requests (default: 1 for cloud providers, 4 otherwise)
//   --delay MS                                     minimum gap between request starts (default: 1500 for cloud, 0 otherwise)
//
// Throttled requests (HTTP 429, "rate limit", "too many requests") are retried with backoff.
//
// Credentials come from the environment:
//   CUSTOM_ENDPOINT (default http://127.0.0.1:8765/detect), CUSTOM_HEADER_NAME, CUSTOM_HEADER_VALUE,
//   SIGHTENGINE_USER, SIGHTENGINE_SECRET, HIVE_KEY
//
// Note: images are sent as-is (the extension re-encodes AVIF/GIF and downscales to 2048px first),
// so cloud providers may reject unusual formats here.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS } from '../src/settings.js';
import { PROVIDERS } from '../src/providers/index.js';
import { detectMetadata } from '../src/providers/metadata.js';

const { values: opt } = parseArgs({
  options: {
    provider: { type: 'string', default: 'custom' },
    threshold: { type: 'string', default: '0.8' },
    'no-metadata': { type: 'boolean', default: false },
    dir: { type: 'string', default: new URL('./site/fixtures/external/', import.meta.url).pathname },
    json: { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    delay: { type: 'string' },
  },
});
const cloud = ['sightengine', 'hive'].includes(opt.provider);
const concurrency = Math.max(1, Number(opt.concurrency ?? (cloud ? 1 : 4)) | 0);
const delayMs = Math.max(0, Number(opt.delay ?? (cloud ? 1500 : 0)));
const threshold = Number(opt.threshold);
const useMetadata = !opt['no-metadata'];
const env = process.env;

const settings = {
  ...DEFAULTS,
  provider: opt.provider,
  sightengine: { apiUser: env.SIGHTENGINE_USER ?? '', apiSecret: env.SIGHTENGINE_SECRET ?? '' },
  hive: { apiKey: env.HIVE_KEY ?? '' },
  custom: {
    endpoint: env.CUSTOM_ENDPOINT ?? DEFAULTS.custom.endpoint,
    headerName: env.CUSTOM_HEADER_NAME ?? '',
    headerValue: env.CUSTOM_HEADER_VALUE ?? '',
  },
};
if (opt.provider !== 'metadata' && !PROVIDERS[opt.provider]) die(`unknown provider "${opt.provider}"`);
if (opt.provider === 'mock') die('the mock provider needs a browser (OffscreenCanvas); use the test page');

const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif',
};

// ---- collect samples ---------------------------------------------------------

const samples = [];
for (const label of ['ai', 'real']) {
  const dir = join(opt.dir, label);
  if (!existsSync(dir)) continue;
  for (const f of (await readdir(dir)).sort()) {
    if (TYPES[extname(f).toLowerCase()]) samples.push({ label, path: join(dir, f) });
  }
}
const nAi = samples.filter((s) => s.label === 'ai').length;
const nReal = samples.length - nAi;
if (!nAi || !nReal) {
  die(`need samples in both ${join(opt.dir, 'ai')}/ and ${join(opt.dir, 'real')}/ (found ${nAi} ai, ${nReal} real).\n` +
      'Add "ai <url>" / "real <url>" lines to test/real-samples.txt and run: python3 test/make_fixtures.py --fetch');
}
if (!opt.json) console.error(`Scoring ${samples.length} samples (${nAi} ai, ${nReal} real) with ${opt.provider}${useMetadata ? ' + metadata' : ''}` +
  ` (${concurrency} at a time${delayMs ? `, ${delayMs} ms apart` : ''})…`);

// ---- score -----------------------------------------------------------------

async function score(s) {
  const bytes = await readFile(s.path);
  const blob = new Blob([bytes], { type: TYPES[extname(s.path).toLowerCase()] });
  try {
    if (useMetadata || opt.provider === 'metadata') {
      const detail = await detectMetadata(blob);
      if (detail) return { ...s, score: 1, source: 'metadata', detail, ms: 0 };
    }
    if (opt.provider === 'metadata') return { ...s, score: 0, source: 'metadata', ms: 0 };
    let ms = 0;
    const { score } = await throttled(async () => {
      const t0 = performance.now(); // time the request only, not the spacing wait
      const r = await PROVIDERS[opt.provider](blob, settings);
      ms = Math.round(performance.now() - t0);
      return r;
    });
    return { ...s, score: Math.min(1, Math.max(0, score)), source: opt.provider, ms };
  } catch (err) {
    return { ...s, error: err.message };
  }
}

// Space request starts at least delayMs apart (across all workers) and retry throttled ones.
let nextSlot = 0;
async function spaced() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + delayMs;
  if (at > now) await sleep(at - now);
}
const THROTTLED = /\b429\b|rate.?limit|too many|throttl|concurren/i;
async function throttled(call) {
  for (let attempt = 0; ; attempt++) {
    await spaced();
    try {
      return await call();
    } catch (err) {
      if (attempt >= 5 || !THROTTLED.test(err.message)) throw err;
      const wait = Math.max(delayMs, 1000) * 2 ** (attempt + 1);
      if (!opt.json) console.error(`  throttled (${err.message}); retrying in ${(wait / 1000).toFixed(1)}s`);
      nextSlot = Math.max(nextSlot, Date.now() + wait); // hold back the other workers too
      await sleep(wait);
    }
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const results = new Array(samples.length);
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < samples.length) {
    const i = next++;
    results[i] = await score(samples[i]);
  }
}));

if (opt.json) {
  console.log(JSON.stringify(results.map((r) => ({ ...r, path: relative(opt.dir, r.path) })), null, 2));
  process.exit(0);
}

// ---- report ------------------------------------------------------------------

const ok = results.filter((r) => r.error === undefined);
const failed = results.filter((r) => r.error !== undefined);

console.log('\n  label  score   result  file');
for (const r of [...ok].sort((a, b) => a.label.localeCompare(b.label) || b.score - a.score)) {
  const flagged = r.score >= threshold;
  const right = flagged === (r.label === 'ai');
  const tag = right ? '  ok  ' : flagged ? '  FP  ' : '  FN  ';
  const via = r.source === 'metadata' && r.detail ? `  [metadata: ${r.detail}]` : '';
  console.log(`  ${r.label.padEnd(5)}  ${(r.score * 100).toFixed(1).padStart(5)}%  ${tag}  ${relative(opt.dir, r.path)}${via}`);
}
for (const r of failed) console.log(`  ${r.label.padEnd(5)}  error   ----    ${relative(opt.dir, r.path)}: ${r.error}`);

if (ok.length) {
  const m = metrics(ok, threshold);
  const best = bestThreshold(ok);
  const auc = rocAuc(ok);
  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
  console.log(`\nAt threshold ${pct(threshold)}:`);
  console.log(`  caught ${m.tp}/${m.tp + m.fn} AI images (recall ${pct(m.recall)}), ` +
              `wrongly flagged ${m.fp}/${m.fp + m.tn} real ones (false-positive rate ${pct(m.fpr)})`);
  console.log(`  accuracy ${pct(m.accuracy)}, precision ${pct(m.precision)}`);
  console.log(`\nThreshold-independent: ROC AUC ${auc.toFixed(3)} (0.5 = coin flip, 1.0 = perfect separation)`);
  console.log(`Best balanced threshold: ${pct(best.t)} → recall ${pct(best.m.recall)}, false-positive rate ${pct(best.m.fpr)}`);
  const timed = ok.filter((r) => r.ms);
  if (timed.length) console.log(`Median latency: ${median(timed.map((r) => r.ms))} ms`);
  if (ok.length < 40) console.log(`\nOnly ${ok.length} samples: treat these numbers as rough.`);
}
if (failed.length) console.log(`\n${failed.length} sample(s) failed and were left out of the numbers.`);

function metrics(rows, t) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    const flagged = r.score >= t;
    if (r.label === 'ai') flagged ? tp++ : fn++;
    else flagged ? fp++ : tn++;
  }
  return {
    tp, fp, tn, fn,
    recall: tp / (tp + fn),
    fpr: fp / (fp + tn),
    precision: tp / (tp + fp),
    accuracy: (tp + tn) / rows.length,
  };
}

// Threshold that maximises balanced accuracy (mean of recall and true-negative rate).
function bestThreshold(rows) {
  let best = null;
  for (const t of [...new Set(rows.map((r) => r.score))]) {
    const m = metrics(rows, t);
    const bal = (m.recall + (1 - m.fpr)) / 2;
    if (!best || bal > best.bal || (bal === best.bal && t > best.t)) best = { t, m, bal };
  }
  return best;
}

// Probability that a random AI sample scores higher than a random real one.
function rocAuc(rows) {
  const ai = rows.filter((r) => r.label === 'ai');
  const real = rows.filter((r) => r.label === 'real');
  if (!ai.length || !real.length) return NaN;
  let wins = 0;
  for (const a of ai) for (const b of real) wins += a.score > b.score ? 1 : a.score === b.score ? 0.5 : 0;
  return wins / (ai.length * real.length);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}
