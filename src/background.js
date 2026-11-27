// AIHound service worker: fetches media, runs the metadata check and the configured
// detection provider, caches scores, and crops screen captures for videos and
// images that can't be fetched directly.

import { getSettings, publicSettings } from './settings.js';
import { PROVIDERS } from './providers/index.js';
import { detectMetadata } from './providers/metadata.js';

const MAX_CACHE = 3000;
const MAX_FETCH_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_DIM = 2048;
const MAX_CONCURRENT = 4;
const CAPTURE_INTERVAL_MS = 600; // captureVisibleTab is limited to ~2 calls/second

const cache = new Map(); // key -> { score, source, detail }
const inflight = new Map(); // key -> Promise
let stats = { checked: 0, flagged: 0, errors: 0, lastError: null };

const ready = chrome.storage.session.get(['cache', 'stats']).then((r) => {
  for (const [k, v] of r.cache ?? []) cache.set(k, v);
  if (r.stats) stats = r.stats;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#d7263d' });
  // 'page' covers images under transparent overlays (common on social sites), which
  // don't get the image context; the content script looks under the cursor.
  chrome.contextMenus.create({ id: 'check', title: 'Check with AIHound', contexts: ['image', 'video', 'page', 'link'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'check' || tab?.id == null) return;
  chrome.tabs
    .sendMessage(tab.id, { type: 'checkNow', srcUrl: info.srcUrl ?? null }, { frameId: info.frameId ?? 0 })
    .catch(() => {}); // no content script (browser pages, or tabs opened before install)
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: err?.message ?? String(err), fallback: !!err?.fallback, retry: !!err?.retry });
  });
  return true; // async response
});

async function handle(msg, sender) {
  await ready;
  switch (msg.type) {
    case 'getSettings':
      return publicSettings(await getSettings());
    case 'classifyUrl':
      return { ok: true, ...(await track(classifyUrl(msg.url, sender))) };
    case 'classifyRegion':
      return { ok: true, ...(await track(classifyRegion(msg, sender))) };
    case 'count':
      return setCount(sender, msg.n);
    case 'getStats':
      return stats;
    case 'clearCache':
      cache.clear();
      stats = { checked: 0, flagged: 0, errors: 0, lastError: null };
      scheduleSave();
      return { ok: true };
    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

async function track(promise) {
  try {
    const result = await promise;
    if (!result.cached) {
      stats.checked++;
      if (result.score >= (await getSettings()).threshold) stats.flagged++;
      scheduleSave();
    }
    return result;
  } catch (err) {
    if (!err.fallback && !err.retry) {
      stats.errors++;
      stats.lastError = { message: err.message, at: Date.now() };
      scheduleSave();
    }
    throw err;
  }
}

// ---- classification -------------------------------------------------------

async function classifyUrl(url, sender) {
  const s = await getSettings();
  const key = await cacheKey(s, url);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  if (inflight.has(key)) return { ...(await inflight.get(key)), cached: true };

  const p = (async () => {
    const blob = await fetchMedia(url);
    if (/svg/i.test(blob.type)) throw new Error('SVG is not supported');
    const result = await classifyBlob(blob, s, { metadata: true, url, pageUrl: sender?.tab?.url, via: 'fetch' });
    remember(key, result);
    return result;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

async function classifyRegion(msg, sender) {
  if (sender.frameId !== 0) throw new Error('Screen capture is only available in the top frame');
  if (!sender.tab?.active) throw withFlags(new Error('Tab is not active'), { retry: true });
  const s = await getSettings();
  let dataUrl;
  try {
    dataUrl = await captureQueued(sender.tab.windowId);
  } catch (err) {
    throw withFlags(err, { retry: true });
  }
  const shot = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = shot.width / msg.viewportWidth;
  const sx = clamp(Math.round(msg.rect.x * scale), 0, shot.width - 1);
  const sy = clamp(Math.round(msg.rect.y * scale), 0, shot.height - 1);
  const sw = clamp(Math.round(msg.rect.w * scale), 1, shot.width - sx);
  const sh = clamp(Math.round(msg.rect.h * scale), 1, shot.height - sy);
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);
  shot.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  // A screenshot has no provenance metadata, so skip that check.
  return classifyBlob(blob, s, { metadata: false, url: msg.srcUrl, pageUrl: sender.tab.url, via: 'capture' });
}

async function classifyBlob(blob, s, { metadata, ...ctx }) {
  if (metadata && (s.metadataFirst || s.provider === 'metadata')) {
    const detail = await detectMetadata(blob);
    if (detail) return { score: 1, source: 'metadata', detail };
  }
  if (s.provider === 'metadata') return { score: 0, source: 'metadata' };
  const provider = PROVIDERS[s.provider];
  if (!provider) throw new Error(`Unknown provider "${s.provider}"`);
  const prepared = await normalize(blob);
  const { score } = await withSlot(() => provider(prepared, s, ctx));
  return { score: clamp(score, 0, 1), source: s.provider };
}

async function fetchMedia(url) {
  let res;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch (err) {
    throw withFlags(new Error(`Fetch failed: ${err.message}`), { fallback: true });
  }
  if (!res.ok) throw withFlags(new Error(`Fetch failed: HTTP ${res.status}`), { fallback: true });
  const len = Number(res.headers.get('content-length'));
  if (len > MAX_FETCH_BYTES) throw new Error('Image too large');
  return res.blob();
}

// Re-encode anything providers may not accept (AVIF, GIF, BMP...) and cap the size.
async function normalize(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    // e.g. an HTML login page served instead of the image; let the page try a capture.
    throw withFlags(new Error(`Could not decode image (${blob.type || 'unknown type'})`), { fallback: true });
  }
  const longest = Math.max(bmp.width, bmp.height);
  if (['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) && longest <= MAX_UPLOAD_DIM) {
    bmp.close();
    return blob;
  }
  const k = Math.min(1, MAX_UPLOAD_DIM / longest);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

// ---- plumbing --------------------------------------------------------------

let active = 0;
const waiters = [];
async function withSlot(fn) {
  while (active >= MAX_CONCURRENT) await new Promise((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

let captureChain = Promise.resolve();
let lastCapture = 0;
function captureQueued(windowId) {
  const p = captureChain.then(async () => {
    const wait = lastCapture + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCapture = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  });
  captureChain = p.catch(() => {});
  return p;
}

async function cacheKey(s, url) {
  const prefix = `${s.provider}${s.metadataFirst ? '+m' : ''}|`;
  if (url.length <= 1024) return prefix + url;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return prefix + 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function remember(key, result) {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  scheduleSave();
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ cache: [...cache], stats }), 1000);
}

// Per-tab badge: number of flagged items, summed over frames.
const tabCounts = new Map();
function setCount(sender, n) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };
  const frames = tabCounts.get(tabId) ?? new Map();
  frames.set(sender.frameId, n);
  tabCounts.set(tabId, frames);
  const total = [...frames.values()].reduce((a, b) => a + b, 0);
  chrome.action.setBadgeText({ tabId, text: total ? String(total) : '' });
  return { ok: true };
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') tabCounts.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => tabCounts.delete(tabId));

function withFlags(err, flags) {
  return Object.assign(err instanceof Error ? err : new Error(String(err)), flags);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
