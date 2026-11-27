// Settings live in chrome.storage.local (not sync) so API keys never leave this machine.

export const DEFAULTS = {
  enabled: true,
  // 'auto': check media as it scrolls into view. 'manual': only via the right-click menu.
  checkMode: 'auto',
  // 'sightengine' | 'hive' | 'custom' | 'metadata' | 'mock'
  provider: 'sightengine',
  // Check embedded provenance (IPTC / C2PA / generator metadata) before calling the provider.
  metadataFirst: true,
  // Provider score (0..1) at or above which media counts as AI-generated.
  threshold: 0.8,
  // 'watermark' | 'blank'
  action: 'watermark',
  // Blur images while they are being checked.
  hideUntilChecked: false,
  // Skip images/videos whose smaller natural dimension is below this many pixels.
  minSize: 150,
  checkVideos: true,
  // Frames to sample from each video (a few seconds apart); the highest score wins.
  videoSamples: 2,
  disabledSites: [],
  sightengine: { apiUser: '', apiSecret: '' },
  hive: { apiKey: '' },
  custom: { endpoint: 'http://127.0.0.1:8765/detect', headerName: '', headerValue: '' },
};

// Keys that hold credentials; never handed to content scripts.
export const SECRET_KEYS = ['sightengine', 'hive', 'custom'];

export async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(stored)) {
    const base = DEFAULTS[k];
    out[k] = isPlainObject(base) && isPlainObject(v) ? { ...base, ...v } : v;
  }
  return out;
}

export function publicSettings(s) {
  const out = { ...s };
  for (const k of SECRET_KEYS) delete out[k];
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
