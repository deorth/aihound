# Future work

Gaps known from the first version. The test page (`test/site`) has cards marked **limit** for the first two.

- [ ] **CSS background images.** Only `<img>` and `<video>` are scanned. Also missing: `<canvas>` and media inside shadow DOM.
- [ ] **Videos inside iframes.** Screen capture only runs in the top frame, so embedded players (e.g. YouTube embeds) aren't checked. Idea: have the subframe post its rect to the top frame, which adds the iframe's offset and requests the capture.
- [ ] **Videos only checked while visible in the active tab.** This is a `captureVisibleTab` constraint, which also allows only about 2 captures per second. Idea: for same-origin or CORS-enabled videos, grab frames by drawing the `<video>` onto a canvas instead.
- [ ] **Privacy with cloud providers.** Every image browsed is uploaded to Sightengine or Hive. On-demand mode (right-click › Check with AIHound) now avoids uploads unless asked. Still to do: an allowlist mode (only check listed sites) and a clear first-run notice.
- [ ] **Tabs open before install or reload** have no content script, so the menu item does nothing there until the page is reloaded. Could inject on demand with the `scripting` permission.
- [ ] **Extension icon.** None yet; Brave shows a letter placeholder.
- [ ] **Verify the Hive integration.** It was written against the v2 sync API from memory, so test it with a real key.
- [ ] **Self-hosted model accuracy.** `Organika/sdxl-detector` scored Adobe's real C2PA sample photo 100% "artificial" (2026-11-25). Compare other open models against a proper sample set before trusting it.
  - 2026-11-26, 46 Commons samples (`npm run accuracy -- --no-metadata`): 74% accuracy, ROC AUC 0.81. At 80% it caught 14/21 AI images and wrongly flagged 5/25 real photos (20%). Not usable as a default. Next: run the same set through Sightengine.
  - The real sample set is skewed: most photos come from one uploader's recent batch. Broaden it (`commons_samples.py` sorts by recency).
  - 2026-11-26 bake-off (`npm run bakeoff`): 267 Commons samples (116 AI from 11 generators, 151 real from 3 curated categories, max 2 per uploader).

    | model | AUC | caught @0.8 | real flagged @0.8 | caught @5% real flagged |
    |---|---|---|---|---|
    | CLIP ViT-L/14 + logistic layer (leave-one-generator-out) | 0.958 | 16%* | 0% | 86% |
    | haywoodsloan/ai-image-detector-deploy (SwinV2) | 0.957 | 81% | 5% | 79% |
    | Ateeqq/ai-vs-human-image-detector (SigLIP) | 0.915 | 79% | 17% | 62% |
    | Organika/sdxl-detector (previous default) | 0.781 | 65% | 21% | 34% |
    | umm-maybe/AI-image-detector | 0.720 | 33% | 1% | 38% |
    | dima806/ai_vs_real_image_detection | 0.685 | 71% | 36% | 9% |

    \* The CLIP layer's scores aren't calibrated, so 80% is the wrong cut-off for it. Its ranking is what's good.
    Caveats: the 5% cut-offs are picked on this same data (optimistic); Commons "real" photos are curated, high-quality images, cleaner than everyday web photos; haywoodsloan's training data is unknown and may overlap with Commons. haywoodsloan is now the server default (`npm run accuracy -- --no-metadata`: 93/116 caught, 8/151 real flagged, AUC 0.957). Next: try averaging it with the CLIP layer, check that both survive ONNX conversion and 8-bit shrinking, and test on everyday photos (phone shots, social-media recompression, screenshots).
  - 2026-11-27 ensemble (`npm run train-ensemble`, then `--ensemble clip`): haywoodsloan + a logistic layer on CLIP ViT-L/14 features, each turned into a percentile and combined by a logistic regression into a probability. Out-of-fold on the 267 samples: AUC 0.977; at 60% it catches 87% of AI images and flags 3% of real photos (haywoodsloan alone at 80%: 81% / 5%); at 80% it is cautious (59% / 0%). The CLIP layer is trained on these samples, so the in-sample `npm run accuracy` figures (AUC 0.99) are flattering. About 260 ms per image, plus a 1.7 GB model. Off by default until tested on everyday photos. If it proves out: make it the default, and ship the threshold hint in the extension (e.g. the server reports a suggested threshold).
- [ ] **Explain scores.** The local detector now logs each image and its scores (`npm run detector:log`, browse `/log`), but a model score has no stated reasons. Next: an on-demand occlusion heatmap (grey out patches, see which raise the score) in the log viewer; Hive v3's per-generator scores; logging metadata-check hits from the extension side.
- [ ] **Real-world sample set.** Collect licensed AI and real images and videos in `test/real-samples.txt` to compare providers.
