# AIHound

A Brave (and any Chromium browser) extension that spots likely AI-generated images and
videos on web pages, then **watermarks** them or **blanks them out** (click to reveal).

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
| **Custom endpoint** | Your hardware | Local | `server/hf_detector.py` runs an open Hugging Face model. Free, but weaker on new generators. |
| **Mock** | — | Local | For testing only: red = AI, green = real. |

Recommendation: start with **Metadata + Sightengine**, and compare against Hive or a local model using the test page.

## How it works

- **`src/content.js`** watches the page for `<img>`/`<video>` elements (MutationObserver + IntersectionObserver), and only checks media near the viewport and at least `minSize` px.
- **`src/background.js`** (service worker) fetches the image bytes with the extension's host permissions, so CORS doesn't get in the way. It then runs the metadata check, normalises the image (JPEG/PNG/WebP, ≤2048px), and calls the provider. It caches scores per URL, runs at most 4 provider calls at a time, and keeps per-tab badge counts.
- **Screen-capture fallback:** videos, and images the worker can't fetch (403, login walls, blob URLs it can't read), are scored by cropping the element out of `chrome.tabs.captureVisibleTab`. This works for cross-origin and streamed (MSE) video without downloading it.
- **Overlays** are a shadow-DOM sibling of the media element, so site CSS can't break them and they scroll along with the media. Blank mode also blurs the element and pauses videos.
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
