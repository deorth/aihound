import { getSettings } from '../src/settings.js';

const form = document.getElementById('form');
const status = document.getElementById('status');
const fields = [...form.elements].filter((el) => el.name);

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

async function load() {
  const s = await getSettings();
  for (const el of fields) {
    const v = getPath(s, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.name === 'disabledSites') el.value = (v || []).join('\n');
    else el.value = v ?? '';
  }
  refresh();
}

function refresh() {
  document.getElementById('thresholdOut').textContent = `${Math.round(form.threshold.value * 100)}%`;
  for (const el of document.querySelectorAll('[data-provider]')) el.hidden = el.dataset.provider !== form.provider.value;
}

form.addEventListener('input', refresh);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = {};
  for (const el of fields) {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number' || el.type === 'range') v = Number(el.value);
    else if (el.name === 'disabledSites') v = el.value.split(/\s+/).map((h) => h.trim()).filter(Boolean);
    else v = el.value.trim();
    setPath(out, el.name, v);
  }
  await chrome.storage.local.set(out);
  flash('Saved');
});

document.getElementById('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  flash('Cache cleared');
});

function flash(text) {
  status.textContent = text;
  setTimeout(() => (status.textContent = ''), 2000);
}

load();
