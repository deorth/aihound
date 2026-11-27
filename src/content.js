// AIHound content script: finds <img> and <video> elements as they scroll near the
// viewport, asks the service worker to score them, and blanks or watermarks the
// ones at or above the threshold.
(() => {
  if (window.__aihoundLoaded) return;
  window.__aihoundLoaded = true;

  const ATTR = 'data-aihound';
  const HOST_TAG = 'aihound-overlay';
  const IS_TOP = window === window.top;

  let settings = null;
  let running = false;
  let io = null;
  let mo = null;
  let placeTimer = 0;

  const state = new WeakMap(); // element -> { key, status, score, source, detail, revealed, overlay }
  const inView = new WeakSet();
  const tracked = new Set();
  const flagged = new Set();
  const noted = new Set(); // elements showing a temporary on-demand note

  init();

  // Where the context menu was last opened, so checkNow can find the media there.
  let lastMenuPoint = null;
  addEventListener('contextmenu', (e) => (lastMenuPoint = { x: e.clientX, y: e.clientY }), true);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'checkNow') checkNowAt(msg.srcUrl);
  });

  async function init() {
    settings = await send({ type: 'getSettings' });
    chrome.storage.onChanged.addListener(onStorageChanged);
    if (isActive()) start();
  }

  function isActive() {
    return !!settings?.enabled && !(settings.disabledSites || []).includes(location.hostname);
  }

  async function onStorageChanged(_changes, area) {
    if (area !== 'local') return;
    settings = await send({ type: 'getSettings' });
    if (!isActive()) return stop();
    start();
    syncAuto();
    // Threshold or action may have changed: re-apply without re-scoring.
    for (const el of tracked) {
      const st = state.get(el);
      if (st?.status === 'done') apply(el, st);
    }
  }

  function start() {
    if (running) return;
    running = true;
    placeTimer = setInterval(placeAll, 1000);
    addEventListener('resize', placeAll, { passive: true });
    syncAuto();
  }

  // Automatic checking: observers run only in 'auto' mode. Results already shown stay.
  function syncAuto() {
    const want = running && settings.checkMode !== 'manual';
    if (want && !io) {
      io = new IntersectionObserver(onIntersect, { rootMargin: '300px' });
      mo = new MutationObserver(onMutations);
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset'],
      });
      scan(document.documentElement);
    } else if (!want && io) {
      io.disconnect();
      mo.disconnect();
      io = mo = null;
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    syncAuto();
    clearInterval(placeTimer);
    removeEventListener('resize', placeAll);
    for (const el of tracked) {
      removeOverlay(el);
      el.removeAttribute(ATTR);
      state.delete(el);
    }
    tracked.clear();
    flagged.clear();
    reportCount();
  }

  // ---- discovery ------------------------------------------------------------

  function scan(root) {
    if (root.nodeType !== 1 || root.localName === HOST_TAG) return;
    if (root.matches('img, video')) track(root);
    root.querySelectorAll('img, video').forEach(track);
  }

  function track(el) {
    if (tracked.has(el)) return;
    tracked.add(el);
    // Same function reference, so re-tracking never adds a duplicate listener.
    el.addEventListener(el.tagName === 'IMG' ? 'load' : 'loadeddata', onMediaReady);
    io?.observe(el); // null in manual mode
    const st = state.get(el);
    if (st?.status === 'done') apply(el, st); // re-inserted after a virtual-list recycle
  }

  function onMediaReady(e) {
    const el = e.currentTarget;
    if (running && inView.has(el)) consider(el);
  }

  function onIntersect(entries) {
    for (const e of entries) {
      if (e.isIntersecting) {
        inView.add(e.target);
        consider(e.target);
      } else {
        inView.delete(e.target);
      }
    }
  }

  function onMutations(muts) {
    if (!running) return;
    for (const m of muts) {
      if (m.type === 'attributes') {
        const el = m.target.tagName === 'SOURCE' ? m.target.parentElement : m.target;
        if (el && tracked.has(el) && inView.has(el)) consider(el); // new src: consider() sees a new key
      } else {
        for (const n of m.addedNodes) scan(n);
      }
    }
  }

  // ---- checking ---------------------------------------------------------------

  function consider(el) {
    if (!running) return;
    if (el.tagName === 'IMG') considerImage(el);
    else if (el.tagName === 'VIDEO' && settings.checkVideos) considerVideo(el);
  }

  function mediaKey(el) {
    return el.currentSrc || el.src || '';
  }

  // Start a check for this element's current source; null if it's already handled.
  function begin(el, key) {
    const old = state.get(el);
    if (old?.key === key) return null;
    if (old) {
      removeOverlay(el);
      flagged.delete(el);
      el.removeAttribute(ATTR);
      reportCount();
    }
    const st = { key, status: 'checking' };
    state.set(el, st);
    return st;
  }

  async function considerImage(el) {
    if (!el.complete || !el.naturalWidth) return; // onMediaReady calls back after load
    const key = mediaKey(el);
    if (!key || /\.svg([?#]|$)/i.test(key) || key.startsWith('data:image/svg')) return;
    const r = el.getBoundingClientRect();
    if (Math.min(el.naturalWidth, el.naturalHeight) < settings.minSize || Math.min(r.width, r.height) < 48) return;

    const st = begin(el, key);
    if (!st) return;
    if (settings.hideUntilChecked) el.setAttribute(ATTR, 'pending');
    const res = await scoreImage(el, st);
    if (res) finish(el, st, res);
  }

  async function considerVideo(el) {
    if (el.readyState < 2) return; // HAVE_CURRENT_DATA; onMediaReady calls back
    if (Math.min(el.videoWidth, el.videoHeight) < settings.minSize) return;
    const st = begin(el, mediaKey(el) || 'video');
    if (!st) return;
    const res = await scoreVideo(el, st);
    if (res) finish(el, st, res);
  }

  // Both return null if the element moved on to another source meanwhile.
  async function scoreImage(el, st) {
    let url = st.key;
    if (url.startsWith('blob:')) url = await blobUrlToDataUrl(url).catch(() => null);
    let res = url ? await send({ type: 'classifyUrl', url }) : { ok: false, fallback: true };
    if (state.get(el) !== st) return null;
    if (!res.ok && res.fallback) res = await captureElement(el);
    return state.get(el) === st ? res : null;
  }

  // Videos are scored from screen captures of the element: works for any source,
  // including cross-origin and MSE streams, without downloading the file.
  async function scoreVideo(el, st) {
    let best = null;
    const samples = Math.max(1, settings.videoSamples | 0);
    for (let i = 0; i < samples; i++) {
      if (i > 0) await sleep(4000);
      if (state.get(el) !== st) return null;
      const res = await captureElement(el);
      if (state.get(el) !== st) return null;
      if (!res.ok) {
        best ??= res;
        continue;
      }
      if (!best?.ok || res.score > best.score) best = res;
      if (best.score >= settings.threshold) break;
    }
    return best;
  }

  // ---- on demand (context menu) -----------------------------------------------

  function checkNowAt(srcUrl) {
    if (!running) return toast(settings?.enabled ? 'AIHound is off for this site' : 'AIHound is turned off');
    const p = lastMenuPoint;
    const under = p ? document.elementsFromPoint(p.x, p.y).filter((n) => n.matches('img, video')) : [];
    const el =
      under.find((n) => srcUrl && mediaKey(n) === srcUrl) ||
      under[0] ||
      (srcUrl && [...document.querySelectorAll('img, video')].find((n) => mediaKey(n) === srcUrl));
    if (!el) return toast('No image or video found here');
    checkNow(el);
  }

  // Checks regardless of mode, size limits and earlier results (cached scores are reused).
  async function checkNow(el) {
    const isVideo = el.tagName === 'VIDEO';
    if (isVideo ? el.readyState < 2 : !el.complete || !el.naturalWidth) return toast("This media hasn't loaded yet");
    const key = mediaKey(el) || (isVideo ? 'video' : '');
    if (!isVideo && (/\.svg([?#]|$)/i.test(key) || key.startsWith('data:image/svg'))) return toast("SVG images can't be checked");

    removeOverlay(el);
    flagged.delete(el);
    el.removeAttribute(ATTR);
    reportCount();
    const st = { key, status: 'checking' };
    state.set(el, st);
    tracked.add(el);
    note(el, st, 'AIHound · checking…', 'busy');

    const res = await (isVideo ? scoreVideo(el, st) : scoreImage(el, st));
    if (!res) return;
    finish(el, st, res);
    if (st.status === 'done' && st.score >= settings.threshold) return; // apply() showed the flag
    const pct = Math.round((st.score ?? 0) * 100);
    const text = !res.ok
      ? `AIHound · couldn't check: ${res.error ?? 'unknown error'}`
      : st.source === 'metadata'
        ? 'AIHound · no AI label in metadata'
        : `AIHound · ${pct}% · probably not AI`;
    note(el, st, text, res.ok ? 'ok' : 'err', 6000);
  }

  // A temporary label on the element (no watermark), e.g. a result that wasn't flagged.
  function note(el, st, text, tone, ms = 0) {
    const ov = ensureOverlay(el, st);
    ov.host.dataset.mode = 'note';
    ov.host.dataset.tone = tone;
    ov.badge.textContent = text;
    place(ov.host, el);
    noted.add(el);
    if (ms)
      setTimeout(() => {
        if (state.get(el) === st && st.overlay?.host.dataset.mode === 'note') {
          removeOverlay(el);
          noted.delete(el);
        }
      }, ms);
  }

  // A short message near the cursor, for when there's no element to label.
  function toast(text) {
    const t = document.createElement(HOST_TAG);
    const p = lastMenuPoint ?? { x: 16, y: 16 };
    t.style.cssText =
      `all:initial;position:fixed;z-index:2147483001;left:${p.x}px;top:${p.y}px;padding:6px 10px;` +
      'border-radius:4px;background:#2a2a2e;color:#fff;font:600 12px/1.3 system-ui,sans-serif;' +
      'box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;';
    t.textContent = text;
    document.documentElement.append(t);
    setTimeout(() => t.remove(), 3000);
  }

  async function captureElement(el) {
    if (!IS_TOP) return { ok: false, error: 'Screen capture is only available in the top frame' };
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitInView(el);
      await waitTabVisible();
      const wasPending = el.getAttribute(ATTR) === 'pending';
      if (wasPending) el.removeAttribute(ATTR); // capture real pixels, not our blur
      const host = state.get(el)?.overlay?.host;
      if (host) host.style.visibility = 'hidden'; // ...or our label
      await nextFrames(2);
      const rect = visibleRect(el);
      const res = rect
        ? await send({ type: 'classifyRegion', rect, viewportWidth: innerWidth, srcUrl: el.currentSrc || el.src || null })
        : { ok: false, retry: true, error: 'Element not visible' };
      if (host) host.style.visibility = '';
      if (wasPending && !el.hasAttribute(ATTR)) el.setAttribute(ATTR, 'pending');
      if (res.ok || !res.retry) return res;
      await sleep(1000);
    }
    return { ok: false, error: 'Could not capture element' };
  }

  function finish(el, st, res) {
    if (!res?.ok) {
      st.status = 'error';
      st.error = res?.error;
      if (el.getAttribute(ATTR) === 'pending') el.removeAttribute(ATTR);
      return;
    }
    Object.assign(st, { status: 'done', score: res.score, source: res.source, detail: res.detail });
    apply(el, st);
  }

  // ---- presentation -------------------------------------------------------------

  function apply(el, st) {
    const isFlagged = running && st.score >= settings.threshold && !st.revealed;
    noted.delete(el);
    if (!isFlagged) {
      removeOverlay(el);
      el.removeAttribute(ATTR);
      flagged.delete(el);
      reportCount();
      return;
    }
    const mode = settings.action === 'blank' ? 'blank' : 'watermark';
    el.setAttribute(ATTR, mode);
    const ov = ensureOverlay(el, st);
    ov.host.dataset.mode = mode;
    delete ov.host.dataset.tone; // left over from an on-demand note
    const pct = Math.round(st.score * 100);
    const why = st.source === 'metadata' ? st.detail : `${st.source}: ${pct}% likely AI`;
    ov.badge.textContent = st.source === 'metadata' ? 'AI · labelled' : `AI · ${pct}%`;
    ov.msg.textContent = `Hidden: likely AI-generated (${why})`;
    place(ov.host, el);
    if (mode === 'blank' && el.tagName === 'VIDEO' && !el.paused) el.pause();
    flagged.add(el);
    reportCount();
  }

  function ensureOverlay(el, st) {
    if (st.overlay?.host.isConnected) return st.overlay;
    const host = document.createElement(HOST_TAG);
    host.style.cssText =
      'all:initial;position:absolute;display:block;left:0;top:0;margin:0;padding:0;z-index:2147483000;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const wm = div('wm');
    const badge = div('badge');
    wm.append(badge);
    const blank = div('blank');
    const msg = div('msg');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Show anyway';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault(); // the media may sit inside a link
      ev.stopPropagation();
      st.revealed = true;
      apply(el, st);
    });
    blank.append(msg, btn);
    root.append(style, wm, blank);
    // A sibling shares the element's containing block, so it scrolls with it,
    // including inside scroll containers.
    el.insertAdjacentElement('afterend', host);
    st.overlay = { host, badge, msg };
    return st.overlay;
  }

  function removeOverlay(el) {
    const st = state.get(el);
    if (!st?.overlay) return;
    st.overlay.host.remove();
    st.overlay = null;
  }

  // Align the overlay with the element by correcting for the measured offset.
  function place(host, el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'block';
    const h = host.getBoundingClientRect();
    const dx = r.left - h.left;
    const dy = r.top - h.top;
    if (Math.abs(dx) > 0.5) host.style.left = `${(parseFloat(host.style.left) || 0) + dx}px`;
    if (Math.abs(dy) > 0.5) host.style.top = `${(parseFloat(host.style.top) || 0) + dy}px`;
    if (Math.abs(h.width - r.width) > 0.5) host.style.width = `${r.width}px`;
    if (Math.abs(h.height - r.height) > 0.5) host.style.height = `${r.height}px`;
  }

  let pruneTick = 0;
  function placeAll() {
    for (const el of noted) {
      const st = state.get(el);
      if (!el.isConnected || st?.overlay?.host.dataset.mode !== 'note') noted.delete(el);
      else place(st.overlay.host, el);
    }
    for (const el of flagged) {
      const st = state.get(el);
      if (!el.isConnected || !st?.overlay) {
        removeOverlay(el);
        flagged.delete(el);
        tracked.delete(el); // so track() re-applies the overlay if it is re-inserted
        reportCount();
        continue;
      }
      // Source swapped with nothing watching (manual mode): the flag is stale.
      if (!io && el.tagName === 'IMG' && mediaKey(el) !== st.key) {
        removeOverlay(el);
        el.removeAttribute(ATTR);
        flagged.delete(el);
        state.delete(el);
        reportCount();
        continue;
      }
      place(st.overlay.host, el);
    }
    if (++pruneTick % 10 === 0) for (const el of tracked) if (!el.isConnected) tracked.delete(el);
  }

  let lastCount = -1;
  let countTimer = 0;
  function reportCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      if (flagged.size === lastCount) return;
      lastCount = flagged.size;
      send({ type: 'count', n: lastCount });
    }, 250);
  }

  // ---- helpers ----------------------------------------------------------------

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      // Usually "Extension context invalidated" after the extension is reloaded.
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  async function blobUrlToDataUrl(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x;
    const h = Math.min(innerHeight, r.bottom) - y;
    return w >= 32 && h >= 32 ? { x, y, w, h } : null;
  }

  // Resolves once at least half the element (or half the viewport) is on screen.
  const viewWaiters = new Map();
  let viewIO = null;
  function waitInView(el) {
    return new Promise((resolve) => {
      viewIO ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const vh = e.rootBounds?.height || innerHeight;
            if (!e.isIntersecting || (e.intersectionRatio < 0.5 && e.intersectionRect.height < vh * 0.5)) continue;
            const list = viewWaiters.get(e.target);
            viewWaiters.delete(e.target);
            viewIO.unobserve(e.target);
            list?.forEach((r) => r());
          }
        },
        { threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      const list = viewWaiters.get(el);
      if (list) list.push(resolve);
      else {
        viewWaiters.set(el, [resolve]);
        viewIO.observe(el);
      }
    });
  }

  function waitTabVisible() {
    if (document.visibilityState === 'visible') return Promise.resolve();
    return new Promise((resolve) => {
      const on = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', on);
        resolve();
      };
      document.addEventListener('visibilitychange', on);
    });
  }

  function nextFrames(n) {
    return new Promise((resolve) => {
      const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function div(cls) {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  }

  const WATERMARK_SVG = encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='130'>" +
      "<text x='110' y='70' text-anchor='middle' transform='rotate(-24 110 65)' " +
      "font-family='system-ui,sans-serif' font-size='22' font-weight='800' letter-spacing='2' " +
      "fill='rgba(255,255,255,0.38)' stroke='rgba(0,0,0,0.28)' stroke-width='0.8'>AI GENERATED</text></svg>",
  );

  const OVERLAY_CSS = `
    .wm, .blank { position: absolute; inset: 0; box-sizing: border-box; display: none; }
    :host([data-mode="watermark"]) .wm { display: block; }
    :host([data-mode="blank"]) .blank { display: flex; }
    :host([data-mode="note"]) .wm { display: block; border: 0; background: none; }
    :host([data-tone="ok"]) .badge { background: #1f7a3f; }
    :host([data-tone="busy"]) .badge { background: #444851; }
    :host([data-tone="err"]) .badge { background: #8a5a00; white-space: normal; max-width: calc(100% - 24px); }
    .wm {
      border: 3px solid rgba(215, 38, 61, 0.9);
      background-image: url("data:image/svg+xml,${WATERMARK_SVG}");
      background-repeat: repeat;
    }
    .badge {
      position: absolute; top: 6px; left: 6px; padding: 3px 7px; border-radius: 4px;
      background: #d7263d; color: #fff; font: 600 12px/1.3 system-ui, sans-serif;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); white-space: nowrap;
    }
    .blank {
      flex-direction: column; align-items: center; justify-content: center; gap: 10px;
      padding: 12px; overflow: hidden; pointer-events: auto;
      background: rgba(18, 18, 20, 0.94); color: #eee;
      font: 13px/1.4 system-ui, sans-serif; text-align: center;
    }
    .blank button {
      font: 600 12px system-ui, sans-serif; padding: 5px 12px; border-radius: 4px;
      border: 1px solid #666; background: #2a2a2e; color: #fff; cursor: pointer;
    }
    .blank button:hover { background: #3a3a40; }
  `;
})();
