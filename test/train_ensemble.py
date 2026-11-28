#!/usr/bin/env python3
"""Train the CLIP layer and the combiner for `server/hf_detector.py --ensemble clip`.

    npm run train-ensemble      # = server/.venv/bin/python test/train_ensemble.py

Uses the labelled samples in test/site/fixtures/external/ (see test/commons_samples.py).
Writes server/models/clip-ensemble.json, which holds:

  probe     a logistic-regression layer on CLIP ViT-L/14 image features, trained on all
            samples (the UnivFD idea: CLIP features separate real and generated images well)
  ref_*     each detector's scores on the samples, used to turn a raw score into a
            percentile so the two detectors count equally. The CLIP scores are
            out-of-fold (leave-one-generator-out), like the probe sees on new images.
  stack     a logistic regression from the two percentiles to a probability, so the
            extension's threshold keeps meaning "this likely"

Retrain after adding samples or changing the base model.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bakeoff import CLIP_MODEL, clip_features, load_samples, score_clip_probe, score_hf  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "server" / "models" / "clip-ensemble.json"


def percentile(ref, s):
    """Mid-rank of s within ref (sorted), 0..1. Ties count half, so saturated scores land mid-pack."""
    return (np.searchsorted(ref, s, "left") + np.searchsorted(ref, s, "right")) / 2 / len(ref)


def report(name, y, p):
    real = np.sort(p[y == 0])
    t5 = real[int(np.ceil(0.95 * len(real))) - 1]
    cuts = "  ".join(f"@{t:.0%}: {np.mean(p[y == 1] >= t):.0%}/{np.mean(p[y == 0] >= t):.0%}" for t in (0.5, 0.6, 0.7, 0.8))
    print(f"{name:14} AUC {roc_auc_score(y, p):.3f}  caught@5% real flagged {np.mean(p[y == 1] > t5):.0%}  "
          f"caught/real-flagged {cuts}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="haywoodsloan/ai-image-detector-deploy")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    samples = load_samples()
    y = np.array([lab for _, lab, _ in samples])
    if not y.sum() or y.all():
        sys.exit("need ai/ and real/ samples; see test/commons_samples.py")
    print(f"{len(samples)} samples ({y.sum()} ai, {(1 - y).sum()} real)", file=sys.stderr)

    print(f"scoring {args.model}…", file=sys.stderr)
    h, _ = score_hf(args.model, samples)
    print("computing CLIP features…", file=sys.stderr)
    feats, _ = clip_features(samples)
    c_oof = score_clip_probe(feats, samples)
    probe = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced").fit(feats, y)

    ref_h, ref_c = np.sort(h), np.sort(c_oof)
    X = np.c_[percentile(ref_h, h), percentile(ref_c, c_oof)]
    # Honest estimate of the combined score: each sample scored by a combiner that didn't see it.
    p_oof = cross_val_predict(LogisticRegression(), X, y, cv=StratifiedKFold(5, shuffle=True, random_state=0),
                              method="predict_proba")[:, 1]
    stack = LogisticRegression().fit(X, y)

    print("\ncaught/real-flagged = share of AI images flagged / share of real photos flagged, at each cut-off")
    report(args.model.split("/")[-1][:14], y, h)
    report("clip layer", y, c_oof)
    report("combined", y, p_oof)
    print("(CLIP and combined figures are out-of-fold, but on the same Commons-style images; expect worse on everyday photos)")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "trained": date.today().isoformat(),
        "base_model": args.model,
        "clip_model": CLIP_MODEL,
        "samples": {"ai": int(y.sum()), "real": int((1 - y).sum())},
        "probe": {"coef": probe.coef_[0].round(6).tolist(), "intercept": float(probe.intercept_[0])},
        "ref_base": ref_h.round(6).tolist(),
        "ref_clip": ref_c.round(6).tolist(),
        "stack": {"coef": stack.coef_[0].tolist(), "intercept": float(stack.intercept_[0])},
    }))
    print(f"\nwrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
