#!/usr/bin/env python3
"""Compare AI-image detector models on the labelled samples in test/site/fixtures/external/.

    server/.venv/bin/python test/bakeoff.py [--models a/b c/d ...] [--no-clip] [--json out.json]

Each Hugging Face image-classification model scores every sample; its AI score is the
sum of its "AI-like" label scores (same rule as server/hf_detector.py). The "clip-probe"
entry is a logistic-regression layer on frozen CLIP features (the UnivFD idea), scored
leave-one-generator-out: each AI generator is tested by a probe that never saw it, and
real photos are split into the same number of folds, so every sample is scored once by
a probe that didn't train on it.

Reported per model:
  AUC           chance of ranking a random AI sample above a random real one (0.5 = coin flip)
  @0.80         recall / false-positive rate at the extension's default 80% threshold
  recall@5%FP   recall at the threshold that wrongly flags 5% of real photos. That threshold
                is picked on this same data, so treat it as optimistic.
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFile
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from transformers import CLIPModel, CLIPProcessor, pipeline

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent
EXTERNAL = ROOT / "site" / "fixtures" / "external"
SAMPLES_TXT = ROOT / "real-samples.txt"
AI_LABELS = {"artificial", "ai", "ai_generated", "fake", "generated", "synthetic"}
DEFAULT_MODELS = [
    "Organika/sdxl-detector",
    "umm-maybe/AI-image-detector",
    "Ateeqq/ai-vs-human-image-detector",
    "haywoodsloan/ai-image-detector-deploy",
    "dima806/ai_vs_real_image_detection",
]
CLIP_MODEL = "openai/clip-vit-large-patch14"
DEVICE = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"


def load_samples():
    """[(path, label 1=ai/0=real, group)] with generator groups from real-samples.txt comments."""
    groups, last = {}, None
    if SAMPLES_TXT.exists():
        for line in SAMPLES_TXT.read_text().splitlines():
            if line.startswith("# ") and " | " in line:
                last = line[2:].split(" | ")[0].strip()
            elif re.match(r"^(ai|real) ", line):
                name = urllib.parse.unquote(line.split(None, 1)[1].split("?")[0].rstrip("/").rsplit("/", 1)[-1])
                groups[name] = last
                last = None
    out = []
    for label, sub in ((1, "ai"), (0, "real")):
        for p in sorted((EXTERNAL / sub).glob("*")):
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                out.append((p, label, groups.get(p.name) or ("other ai" if label else "real")))
    return out


def open_rgb(path):
    with Image.open(path) as im:
        im.thumbnail((2048, 2048))  # the extension caps uploads at 2048px too
        return im.convert("RGB")


def score_hf(model_id, samples):
    clf = pipeline("image-classification", model=model_id, device=DEVICE)
    scores, t = [], []
    for path, _, _ in samples:
        img = open_rgb(path)
        t0 = time.perf_counter()
        preds = clf(img, top_k=None)
        t.append(time.perf_counter() - t0)
        scores.append(sum(p["score"] for p in preds if p["label"].lower() in AI_LABELS))
    return np.array(scores), float(np.median(t[1:] or t))  # first call includes warm-up


def clip_features(samples):
    model = CLIPModel.from_pretrained(CLIP_MODEL).to(DEVICE).eval()
    proc = CLIPProcessor.from_pretrained(CLIP_MODEL)
    feats, t = [], []
    with torch.no_grad():
        for path, _, _ in samples:
            inputs = proc(images=open_rgb(path), return_tensors="pt").to(DEVICE)
            t0 = time.perf_counter()
            # Same as get_image_features, whose return type differs between versions.
            f = model.visual_projection(model.vision_model(pixel_values=inputs["pixel_values"]).pooler_output)
            f = torch.nn.functional.normalize(f, dim=-1)
            t.append(time.perf_counter() - t0)
            feats.append(f[0].float().cpu().numpy())
    return np.stack(feats), float(np.median(t[1:] or t))


def score_clip_probe(feats, samples):
    y = np.array([lab for _, lab, _ in samples])
    gens = sorted({g for _, lab, g in samples if lab})
    real_idx = np.flatnonzero(y == 0)
    rng = np.random.default_rng(0)
    real_fold = dict(zip(rng.permutation(real_idx), np.arange(len(real_idx)) % len(gens)))
    scores = np.full(len(samples), np.nan)
    for k, g in enumerate(gens):
        test = np.array([(lab and grp == g) or (not lab and real_fold[i] == k) for i, (_, lab, grp) in enumerate(samples)])
        clf = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced").fit(feats[~test], y[~test])
        scores[test] = clf.predict_proba(feats[test])[:, 1]
    return scores


def metrics(y, s, threshold=0.8):
    real = np.sort(s[y == 0])
    t5 = real[int(np.ceil(0.95 * len(real))) - 1] if len(real) else 1.0  # 95th percentile of real scores
    return {
        "auc": roc_auc_score(y, s),
        "recall@0.8": float(np.mean(s[y == 1] >= threshold)),
        "fpr@0.8": float(np.mean(s[y == 0] >= threshold)),
        "recall@5%fp": float(np.mean(s[y == 1] > t5)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=DEFAULT_MODELS)
    ap.add_argument("--no-clip", action="store_true")
    ap.add_argument("--json")
    args = ap.parse_args()

    samples = load_samples()
    y = np.array([lab for _, lab, _ in samples])
    if not y.sum() or y.all():
        sys.exit("need ai/ and real/ samples; see test/commons_samples.py")
    print(f"{len(samples)} samples ({y.sum()} ai, {(1 - y).sum()} real) on {DEVICE}\n", file=sys.stderr)

    results = {}
    runs = [(m, lambda m=m: score_hf(m, samples)) for m in args.models]
    if not args.no_clip:
        def clip():
            feats, ms = clip_features(samples)
            return score_clip_probe(feats, samples), ms
        runs.append(("clip-probe (ViT-L/14, leave-one-generator-out)", clip))
    for name, run in runs:
        print(f"scoring {name}…", file=sys.stderr)
        try:
            s, sec = run()
        except Exception as e:  # a broken model shouldn't sink the whole comparison
            print(f"  failed: {e}", file=sys.stderr)
            continue
        results[name] = {**metrics(y, s), "ms": sec * 1000, "scores": s.tolist()}

    print(f"\n{'model':48} {'AUC':>5} {'recall@0.8':>10} {'FP@0.8':>7} {'recall@5%FP':>11} {'ms':>6}")
    for name, r in sorted(results.items(), key=lambda kv: -kv[1]["auc"]):
        print(f"{name:48} {r['auc']:5.3f} {r['recall@0.8']:10.0%} {r['fpr@0.8']:7.0%} {r['recall@5%fp']:11.0%} {r['ms']:6.0f}")

    gens = sorted({g for _, lab, g in samples if lab})
    print("\nrecall@5%FP by generator (n):")
    print(f"{'':28}" + "".join(f"{n.split('/')[-1][:14]:>15}" for n in results))
    for g in gens:
        idx = [i for i, (_, lab, grp) in enumerate(samples) if lab and grp == g]
        row = ""
        for r in results.values():
            s = np.array(r["scores"])
            real = np.sort(s[y == 0])
            t5 = real[int(np.ceil(0.95 * len(real))) - 1]
            row += f"{np.mean(s[idx] > t5):15.0%}"
        print(f"{(g[:22] + f' ({len(idx)})'):28}{row}")

    if args.json:
        files = [str(p.relative_to(EXTERNAL)) for p, _, _ in samples]
        Path(args.json).write_text(json.dumps({"files": files, "labels": y.tolist(), "results": results}, indent=1))


if __name__ == "__main__":
    main()
