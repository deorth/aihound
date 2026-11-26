# Future work

Gaps known from the first version. The test page (`test/site`) has cards marked **limit** for the first two.

- [ ] **CSS background images.** Only `<img>` and `<video>` are scanned. Also missing: `<canvas>` and media inside shadow DOM.
- [ ] **Videos inside iframes.** Screen capture only runs in the top frame, so embedded players (e.g. YouTube embeds) aren't checked. Idea: have the subframe post its rect to the top frame, which adds the iframe's offset and requests the capture.
- [ ] **Videos only checked while visible in the active tab.** This is a `captureVisibleTab` constraint, which also allows only about 2 captures per second. Idea: for same-origin or CORS-enabled videos, grab frames by drawing the `<video>` onto a canvas instead.
- [ ] **Privacy with cloud providers.** Every image browsed is uploaded to Sightengine or Hive. Ideas: an allowlist mode (only check listed sites), a "check on demand" context-menu item, and a clear first-run notice.
- [ ] **Extension icon.** None yet; Brave shows a letter placeholder.
- [ ] **Verify the Hive integration.** It was written against the v2 sync API from memory, so test it with a real key.
- [ ] **Self-hosted model accuracy.** `Organika/sdxl-detector` scored Adobe's real C2PA sample photo 100% "artificial" (2026-11-25). Compare other open models against a proper sample set before trusting it.
  - 2026-11-26, 46 Commons samples (`npm run accuracy -- --no-metadata`): 74% accuracy, ROC AUC 0.81. At 80% it caught 14/21 AI images and wrongly flagged 5/25 real photos (20%). Not usable as a default. Next: run the same set through Sightengine.
  - The real sample set is skewed: most photos come from one uploader's recent batch. Broaden it (`commons_samples.py` sorts by recency).
- [ ] **Real-world sample set.** Collect licensed AI and real images and videos in `test/real-samples.txt` to compare providers.
