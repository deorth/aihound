import { getSettings } from '../src/settings.js';

const $ = (id) => document.getElementById(id);

const s = await getSettings();
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = '';
try {
  const u = new URL(tab?.url ?? '');
  if (u.protocol.startsWith('http')) host = u.hostname;
} catch {}

$('enabled').checked = s.enabled;
$('action').value = s.action;
$('checkMode').value = s.checkMode;
$('host').textContent = host || 'this page';
$('site').disabled = !host;
$('site').checked = !!host && !s.disabledSites.includes(host);

$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
$('action').addEventListener('change', (e) => chrome.storage.local.set({ action: e.target.value }));
$('checkMode').addEventListener('change', (e) => chrome.storage.local.set({ checkMode: e.target.value }));
$('site').addEventListener('change', async (e) => {
  const { disabledSites } = await getSettings();
  const next = disabledSites.filter((h) => h !== host);
  if (!e.target.checked) next.push(host);
  chrome.storage.local.set({ disabledSites: next });
});
$('options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

const stats = await chrome.runtime.sendMessage({ type: 'getStats' });
$('stats').textContent = `Provider: ${s.provider} · checked ${stats.checked} · flagged ${stats.flagged} · errors ${stats.errors}`;
if (stats.lastError) $('error').textContent = `Last error: ${stats.lastError.message}`;
