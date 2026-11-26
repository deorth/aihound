// Builds the test page from fixtures/manifest.json plus hand-written dynamic cases.
const XO = `http://127.0.0.1:${Number(location.port || 80) + 1}`; // cross-origin copy of this server

function card({ title, expect, why, build }) {
  const c = document.createElement('div');
  c.className = 'card';
  const media = document.createElement('div');
  media.className = 'media';
  build(media);
  const h = document.createElement('h3');
  h.textContent = title;
  const p = document.createElement('p');
  p.innerHTML = expect ? `<span class="tag ${expect}">${expect}</span> ` : '';
  p.append(why || '');
  c.append(media, h, p);
  return c;
}

function img(src, attrs = {}) {
  const el = document.createElement('img');
  Object.assign(el, { alt: '', ...attrs });
  el.src = src;
  return el;
}

function vid(src) {
  const el = document.createElement('video');
  Object.assign(el, { muted: true, autoplay: true, loop: true, playsInline: true, controls: true });
  if (src) el.src = src;
  return el;
}

function solidCanvas(color, w = 400, h = 300) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c;
}

async function manifestCases() {
  const cases = await (await fetch('fixtures/manifest.json')).json();
  const groups = new Map();
  for (const c of cases) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  const root = document.getElementById('groups');
  for (const [name, list] of groups) {
    const h = document.createElement('h2');
    h.textContent = name;
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const c of list) {
      grid.append(card({
        title: c.title,
        expect: c.expect,
        why: `${c.file} — ${c.why}`,
        build: (m) => m.append(c.kind === 'video' ? vid(`fixtures/${c.file}`) : img(`fixtures/${c.file}`)),
      }));
    }
    root.append(h, grid);
  }
}

function dynamicCases() {
  const grid = document.getElementById('dynamic');
  const add = (c) => grid.append(card(c));

  add({
    title: 'Cross-origin image', expect: 'flag', why: `${XO}/fixtures/ai-red.jpg`,
    build: (m) => m.append(img(`${XO}/fixtures/ai-red.jpg`)),
  });
  add({
    title: 'Fetch refused → screen-capture fallback', expect: 'flag',
    why: '/protected/ai-red.jpg returns 403 to the extension (no page Referer)',
    build: (m) => m.append(img('/protected/ai-red.jpg')),
  });
  add({
    title: 'data: URL (canvas PNG)', expect: 'flag', why: 'src is a data:image/png URL',
    build: (m) => m.append(img(solidCanvas('#e61414').toDataURL('image/png'))),
  });
  add({
    title: 'blob: URL (canvas WebP)', expect: 'flag', why: 'page-owned blob, converted by the content script',
    build: (m) => solidCanvas('#e61414').toBlob((b) => m.append(img(URL.createObjectURL(b))), 'image/webp', 0.9),
  });
  add({
    title: '<picture> with AVIF source', expect: 'flag', why: 'currentSrc picks the AVIF',
    build: (m) => {
      m.innerHTML = '<picture><source srcset="fixtures/ai-red.avif" type="image/avif"><img alt="" src="fixtures/real-green.jpg"></picture>';
    },
  });
  add({
    title: 'srcset (resolution switching)', expect: 'flag', why: 'ai-red.jpg 1x / ai-red-large.jpg 2x',
    build: (m) => m.append(img('fixtures/ai-red.jpg', { srcset: 'fixtures/ai-red.jpg 1x, fixtures/ai-red-large.jpg 2x' })),
  });
  add({
    title: 'Inserted after 2 seconds', expect: 'flag', why: 'MutationObserver pick-up',
    build: (m) => setTimeout(() => m.append(img('fixtures/ai-above.jpg')), 2000),
  });
  add({
    title: 'src swap', expect: null, why: 'Overlay must follow the current image: red = flag, green = pass',
    build: (m) => {
      const el = img('fixtures/ai-red.jpg');
      const b = document.createElement('button');
      b.textContent = 'Swap image';
      b.onclick = () => { el.src = el.src.includes('ai-red') ? 'fixtures/real-green.jpg' : 'fixtures/ai-red.jpg'; };
      m.append(el, b);
    },
  });
  add({
    title: 'Removed and re-inserted', expect: 'flag', why: 'Detached at 4s, back at 5s (virtual-list recycling); overlay should return',
    build: (m) => {
      const el = img('fixtures/ai-red.jpg');
      m.append(el);
      setTimeout(() => el.remove(), 4000);
      setTimeout(() => m.append(el), 5000);
    },
  });
  add({
    title: 'Inside a link', expect: 'flag', why: 'In blank mode, "Show anyway" must not follow the link',
    build: (m) => {
      const a = document.createElement('a');
      a.href = 'https://example.com/';
      a.append(img('fixtures/ai-red.jpg'));
      m.append(a);
    },
  });
  add({
    title: 'Inside a scroll container', expect: 'flag', why: 'Overlays should scroll with the images',
    build: (m) => {
      const s = document.createElement('div');
      s.className = 'scroller';
      s.append(img('fixtures/ai-red.jpg'), img('fixtures/real-green.jpg'), img('fixtures/ai-above.jpg'));
      m.append(s);
    },
  });
  add({
    title: 'Flex row', expect: 'flag', why: 'Left flagged, right passes',
    build: (m) => {
      const f = document.createElement('div');
      f.className = 'flex';
      f.append(img('fixtures/ai-red.jpg'), img('fixtures/real-green.jpg'));
      m.append(f);
    },
  });
  add({
    title: 'Cross-origin video', expect: 'flag', why: `${XO}/fixtures/ai-red.mp4`,
    build: (m) => m.append(vid(`${XO}/fixtures/ai-red.mp4`)),
  });
  add({
    title: 'MediaStream video (no src)', expect: 'flag', why: 'canvas.captureStream() → video.srcObject',
    build: (m) => {
      const c = solidCanvas('#e61414', 640, 360);
      const ctx = c.getContext('2d');
      let x = 0;
      setInterval(() => {
        ctx.fillStyle = '#e61414';
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect((x = (x + 8) % 580), 150, 60, 60);
      }, 40);
      const v = vid('');
      v.srcObject = c.captureStream(25);
      m.append(v);
    },
  });
  add({
    title: 'Same-origin iframe (image)', expect: 'flag', why: 'Content script runs in all frames',
    build: (m) => {
      const f = document.createElement('iframe');
      f.src = 'frame.html';
      m.append(f);
    },
  });
  add({
    title: 'Video inside an iframe', expect: 'limit', why: 'Screen capture only runs in the top frame',
    build: (m) => {
      const f = document.createElement('iframe');
      f.src = 'frame.html#video';
      m.append(f);
    },
  });
  add({
    title: 'CSS background-image', expect: 'limit', why: 'Only <img> and <video> are scanned',
    build: (m) => {
      const d = document.createElement('div');
      d.className = 'bg';
      m.append(d);
    },
  });
}

async function externalCases() {
  const grid = document.getElementById('externalGrid');
  let files = [];
  try {
    files = await (await fetch('/external/index.json')).json();
  } catch {}
  if (!files.length) {
    document.getElementById('externalNote').textContent =
      'None yet: run `python3 test/make_fixtures.py --fetch` (add your own URLs to test/real-samples.txt).';
    return;
  }
  for (const f of files) {
    const src = `fixtures/external/${f.split('/').map(encodeURIComponent).join('/')}`;
    const isVideo = /\.(mp4|webm|mov)$/i.test(f);
    const label = f.startsWith('ai/') ? 'Known AI' : f.startsWith('real/') ? 'Known real' : 'Unlabelled';
    const note = f.includes('adobe-20220124') ? 'C2PA-signed but not AI: metadata check must not flag it' : '';
    const name = f.split('/').pop();
    grid.append(card({ title: `${label}: ${name}`, expect: null, why: note, build: (m) => m.append(isVideo ? vid(src) : img(src)) }));
  }
}

function lazyCases() {
  const grid = document.getElementById('lazy');
  grid.append(
    card({ title: 'loading="lazy"', expect: 'flag', why: 'Checked only once scrolled near', build: (m) => m.append(img('fixtures/ai-red.jpg', { loading: 'lazy' })) }),
    card({ title: 'loading="lazy" real', expect: 'pass', why: '', build: (m) => m.append(img('fixtures/real-green.jpg', { loading: 'lazy' })) }),
    card({ title: 'Video far down', expect: 'flag', why: 'Captured once scrolled into view', build: (m) => m.append(vid('fixtures/ai-red.webm')) }),
  );
}

manifestCases().catch((e) => {
  document.getElementById('groups').textContent = `Could not load fixtures/manifest.json (${e}). Run python3 test/make_fixtures.py.`;
});
dynamicCases();
externalCases();
lazyCases();
