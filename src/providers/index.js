// Each provider: async (blob, settings) => { score: number in 0..1 }
// The blob is JPEG/PNG/WebP, at most 2048px on its longest side.

function filename(blob) {
  const ext = { 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'jpg';
  return `media.${ext}`;
}

async function readJson(res, who) {
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`${who}: HTTP ${res.status}, response was not JSON`);
  return data;
}

// https://sightengine.com/docs/ai-generated-image-detection
export async function sightengine(blob, s) {
  const { apiUser, apiSecret } = s.sightengine;
  if (!apiUser || !apiSecret) throw new Error('Sightengine API user/secret not set (Options page)');
  const form = new FormData();
  form.append('media', blob, filename(blob));
  form.append('models', 'genai');
  form.append('api_user', apiUser);
  form.append('api_secret', apiSecret);
  const res = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: form });
  const data = await readJson(res, 'Sightengine');
  if (data.status !== 'success') throw new Error(`Sightengine: ${data.error?.message || `HTTP ${res.status}`}`);
  return { score: Number(data.type?.ai_generated ?? 0) };
}

// https://docs.thehive.ai/docs/ai-generated-image-and-video-detection
// Uses the v2 sync task API with a project key; check the docs for your account's API version.
export async function hive(blob, s) {
  const { apiKey } = s.hive;
  if (!apiKey) throw new Error('Hive API key not set (Options page)');
  const form = new FormData();
  form.append('media', blob, filename(blob));
  const res = await fetch('https://api.thehive.ai/api/v2/task/sync', {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
    body: form,
  });
  const data = await readJson(res, 'Hive');
  if (!res.ok) throw new Error(`Hive: HTTP ${res.status} ${data.message ?? ''}`.trim());
  const classes = data.status?.[0]?.response?.output?.[0]?.classes ?? [];
  const ai = classes.find((c) => c.class === 'ai_generated');
  if (!ai) throw new Error('Hive: no "ai_generated" class in response (is this an AI-generated content detection key?)');
  return { score: Number(ai.score) };
}

// Any HTTP endpoint that accepts raw image bytes and returns {"score": 0..1}.
// See server/hf_detector.py for a self-hosted Hugging Face model.
export async function custom(blob, s) {
  const { endpoint, headerName, headerValue } = s.custom;
  if (!endpoint) throw new Error('Custom endpoint URL not set (Options page)');
  const headers = { 'Content-Type': blob.type || 'application/octet-stream' };
  if (headerName && headerValue) headers[headerName] = headerValue;
  const res = await fetch(endpoint, { method: 'POST', headers, body: blob });
  const data = await readJson(res, 'Custom endpoint');
  if (!res.ok) throw new Error(`Custom endpoint: HTTP ${res.status} ${data.error ?? ''}`.trim());
  const score = Number(data.score);
  if (!Number.isFinite(score)) throw new Error('Custom endpoint: response has no numeric "score"');
  return { score };
}

// Testing only: score from average colour. Pure red -> 1.0, pure green -> 0.0, grey -> 0.5.
// Pairs with the fixtures in test/site, so the whole pipeline can be exercised without API keys.
export async function mock(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, 32, 32);
  bmp.close();
  const px = ctx.getImageData(0, 0, 32, 32).data;
  let r = 0, g = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; }
  const n = px.length / 4;
  return { score: (r / n - g / n + 255) / 510 };
}

export const PROVIDERS = { sightengine, hive, custom, mock };
