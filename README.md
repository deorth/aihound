# AIHound

A Brave (and any Chromium browser) extension that spots likely AI-generated images and
videos on web pages, then **watermarks** them or **blanks them out** (click to reveal).

## Quick start

No programming needed for Steps 1–4. Step 3 gives two ways to check pictures. Pick one.

### Step 1: Get the AIHound files

1. On the AIHound GitHub page, click the green **Code** button, then **Download ZIP**.
2. Find the ZIP in your Downloads folder and double-click it to unzip it. You get a folder called `aihound-main` (or similar).
3. Move that folder somewhere it can stay, such as your Documents folder. Brave loads the extension straight from this folder, so if you delete or move it later, AIHound stops working.

### Step 2: Add AIHound to Brave

1. Open Brave. In the address bar, type `brave://extensions` and press Enter.
2. Turn on **Developer mode** with the switch in the top-right corner. This only lets you add extensions from a folder; it doesn't change anything else.
3. Click **Load unpacked** (top left) and choose the `aihound-main` folder from Step 1. Choose the folder itself, not a file inside it.
4. AIHound now appears in the list. To keep it handy, click the puzzle-piece icon to the right of the address bar, then the pin next to **AIHound**.

Brave may show a notice saying developer-mode extensions are turned on. That's expected.

### Step 3: Choose how pictures are checked

AIHound can't tell AI pictures apart by itself. It asks a "detector" for a score between 0% and 100%.

**Option A: an online service (easiest).** Sightengine checks the pictures for you over the internet. It has a free allowance; check their website for current limits.

1. Create an account at [sightengine.com](https://sightengine.com).
2. In your Sightengine dashboard, find your **API user** and **API secret**. These are two codes that let AIHound use your account. Keep them private, like a password.
3. In Brave, right-click the AIHound icon and choose **Options**.
4. Set **Provider** to **Sightengine**, paste the two codes into the boxes, and click **Save**.

The downside: every picture AIHound checks is sent to Sightengine. To limit that, see "Only check when I ask" in Step 5.

**Option B: on your own Mac (private, more setup).** A detector runs on your own computer, so no pictures leave it. You'll type a few commands, and the first start downloads about 750 MB.

1. Open the **Terminal** app (press ⌘-Space, type `Terminal`, press Enter).
2. Install `uv`, a free tool that sets up the detector's software. Copy this line, paste it into Terminal, and press Enter:
   ```sh
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
   Then quit Terminal (⌘-Q) and open it again.
3. Go to the AIHound folder. Type `cd ` (with a space after it), drag the `aihound-main` folder from Finder into the Terminal window, then press Enter.
4. Set up the detector (one time only, takes a few minutes):
   ```sh
   uv venv --python 3.12 server/.venv
   uv pip install --python server/.venv/bin/python -r server/requirements.txt
   ```
5. Start the detector:
   ```sh
   server/.venv/bin/python server/hf_detector.py --log-dir server/logs
   ```
   The first start takes a while. When you see `Uvicorn running on http://127.0.0.1:8765`, it's ready. **Leave this Terminal window open** while you browse; closing it stops the detector. Next time, repeat steps 3 and 5 only.
6. In Brave, right-click the AIHound icon, choose **Options**, set **Provider** to **Custom / self-hosted endpoint**, and click **Save**. The address box is already filled in correctly.

### Step 4: Try it

Visit a page with pictures. Pictures AIHound thinks are AI-generated get a watermark and a label with the score. The AIHound icon shows how many it flagged on the page.

To check one picture yourself, **right-click it and choose Check with AIHound**. A green note means it's probably not AI. If nothing happens, reload the page; tabs that were open before you installed AIHound need a reload.

### Step 5: Adjust it to taste

Click the AIHound icon for quick settings:

- **Enabled** / **Enabled on this site**: turn AIHound off everywhere, or just for the site you're on.
- **Check**: *Automatically* checks pictures as you scroll. *On demand* checks only when you right-click and choose **Check with AIHound**. With an online service, this means nothing is uploaded unless you ask.
- **Action**: *Watermark* marks suspected pictures. *Blank* hides them behind a panel with a **Show anyway** button.

**Options** has more: how sure the detector must be before a picture is flagged (default 80%), whether to check videos, and the smallest picture size to bother with.

### Step 6 (Option B only): See what was checked

Because you started the detector with `--log-dir server/logs`, it keeps a copy of every picture it checked, with its score. To see them, open **http://127.0.0.1:8765/log** in Brave. Newest are first; click **show flagged only** to see just the suspected ones. The files are in the `server/logs` folder.

The detector can't explain *why* it gave a score. It learned from many example pictures and reports a single likelihood, the same way a spam filter can't list its reasons. Treat its score as a hint, not proof: it gets roughly 1 in 20 real photos wrong, and misses about 1 in 5 AI pictures.

**Optional: a second opinion.** Start the detector with `--ensemble clip` added to the end of the Step 5 command. It then also asks a second detector and combines the two answers. In our tests this caught more AI pictures with fewer false alarms, but it is more cautious, so in **Options** lower the threshold to **60%**. It downloads another 1.7 GB the first time. The log then shows both detectors' scores.

To stop keeping copies, start the detector without `--log-dir server/logs`. To clear the history, delete the `server/logs` folder.

### If something doesn't work

- **Nothing is ever flagged:** right-click a picture and choose **Check with AIHound**. If you see "couldn't check", the message says why. Usually the Sightengine codes are wrong (Option A) or the detector's Terminal window is closed (Option B).
- **"AIHound is off for this site":** click the AIHound icon and tick **Enabled on this site**.
- **Right-click option does nothing:** reload the page.

## Install (unpacked)

1. Open `brave://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open the extension's **Options**, pick a provider, and add its API key.

No build step: plain Manifest V3 JavaScript.

## Choosing a detection provider

Detection is pluggable (`src/providers/index.js`); each provider takes an image blob and returns a 0–1 score.

| Provider | Cost | Privacy | Notes |
|---|---|---|---|
| **Metadata** (always runs first by default) | Free | Fully local | Reads IPTC `DigitalSourceType`, C2PA AI source types, Stable Diffusion/ComfyUI chunks. Near-zero false positives, but most social sites strip metadata. |
| **Sightengine** | Free tier, then paid | Images uploaded | Simple API (`genai` model). **Best place to start.** |
| **Hive** | Paid / enterprise | Images uploaded | Strong reputation for accuracy. Uses the v2 sync API; check Hive's docs for your key type. |
| **Custom endpoint** | Your hardware | Local | `server/hf_detector.py` runs an open Hugging Face model (default `haywoodsloan/ai-image-detector-deploy`, the best in `npm run bakeoff`; results in `TODO.md`). Free and private. `npm run detector:log` also saves each checked image and its scores, browsable at `http://127.0.0.1:8765/log`. `--ensemble clip` (`npm run detector:ensemble`) combines it with a CLIP-based layer trained by `npm run train-ensemble`; use a ~60% threshold. |
| **Mock** | — | Local | For testing only: red = AI, green = real. |

Recommendation: start with **Metadata + Sightengine**, and compare against Hive or a local model using the test page.

## How it works

- **`src/content.js`** watches the page for `<img>`/`<video>` elements (MutationObserver + IntersectionObserver), and only checks media near the viewport and at least `minSize` px.
- **`src/background.js`** (service worker) fetches the image bytes with the extension's host permissions, so CORS doesn't get in the way. It then runs the metadata check, normalises the image (JPEG/PNG/WebP, ≤2048px), and calls the provider. It caches scores per URL, runs at most 4 provider calls at a time, and keeps per-tab badge counts.
- **Screen-capture fallback:** videos, and images the worker can't fetch (403, login walls, blob URLs it can't read), are scored by cropping the element out of `chrome.tabs.captureVisibleTab`. This works for cross-origin and streamed (MSE) video without downloading it.
- **On demand:** right-click any image or video and choose **Check with AIHound**. It ignores the size limit and works in both modes; set *When to check* to *Only when I ask* (options or popup) to stop automatic checks, so nothing is uploaded unless you ask. Images that pass show a short green note with the score.
- **Overlays** are a shadow-DOM sibling of the media element, so site CSS can't break them and they scroll along with the media. Blank mode also blurs the element and pauses videos.
- **Logging (local detector):** with `--log-dir`, `server/hf_detector.py` saves each image (deduplicated by hash) to `images/` and appends a line to `log.jsonl`: time, model, score, per-label scores, size, and timing. If *Also send the image and page address* is on (Custom provider options, default on), the extension adds `X-AIHound-Source-Url`, `-Page-Url`, `-Via` (`fetch` or `capture`), `-Threshold`, and `-Action` headers, which the record includes. Images flagged by the metadata check never reach the server, so they aren't logged.
- Settings, including API keys, are stored in `chrome.storage.local`. API keys are never sent to content scripts.

## Testing locally

```sh
npm run fixtures   # regenerate test media (needs ffmpeg) + download third-party samples
npm run serve      # http://localhost:8000 (and a cross-origin copy on :8001)
npm test           # unit tests for the metadata detector
```

In Options, set provider = **Mock** and open http://localhost:8000. Every card on the page states the expected result:

- **Scores:** colours tuned around the 80% threshold (0.91, 0.85, 0.75, 0.50, 0.17).
- **Formats:** JPEG, PNG, GIF, AVIF, a 4000×3000 image (downscaling), SVG (skipped), and a 64px icon (skipped).
- **Metadata:** IPTC XMP in JPEG and PNG, a composite source type, A1111 parameters, and a ComfyUI workflow. All of these are green, so only the metadata check can flag them. Negative controls: a camera `digitalCapture` file and a real C2PA-signed Adobe sample.
- **Videos:** MP4, WebM, a green→red switch (tests multi-frame sampling), a tiny video (skipped), and a MediaStream video with no `src`.
- **Page behaviour:** cross-origin media, a 403 that forces the capture fallback, `data:`/`blob:` URLs, `<picture>`, `srcset`, late insertion, src swapping, detach/re-attach, images inside links, scroll containers and flex rows, iframes, lazy loading.
- **External samples:** list your own AI and real images in `test/real-samples.txt` to try a real provider.

The coloured fixtures only mean something to the Mock provider. To check a real detector, use the external samples.

## Known limitations

- CSS `background-image`, `<canvas>`, and images inside shadow DOM aren't scanned.
- Videos inside iframes aren't checked (capture runs only in the top frame).
- Videos are scored only while visible in the active tab, and `captureVisibleTab` allows about 2 captures per second.
- Using a cloud provider uploads the images you browse. Use the per-site toggle, or Metadata/Custom, for private content.
- No icon yet (Brave shows a letter placeholder).
