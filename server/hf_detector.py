#!/usr/bin/env python3
"""Self-hosted detector for AIHound's "Custom endpoint" provider.

Runs an open Hugging Face image classifier locally. Free and private. The default
model won the comparison in test/bakeoff.py (see TODO.md); pass --model to try others.

    uv venv --python 3.12 server/.venv          # PyTorch has no wheels for very new Pythons
    uv pip install --python server/.venv/bin/python -r server/requirements.txt
    server/.venv/bin/python server/hf_detector.py --model haywoodsloan/ai-image-detector-deploy --port 8765

Then in AIHound Options: provider = Custom, URL = http://127.0.0.1:8765/detect

Logging (--log-dir DIR): every checked image is saved in DIR/images/, named by a hash of
its bytes, and one JSON line per check is appended to DIR/log.jsonl. The line holds the time,
model, score, each label's score, and, if the extension sends them (Options › "Also send
the image and page address"), the image and page URLs, fetch vs screen capture, and the
threshold and action in use. Browse it at http://127.0.0.1:8765/log.

Ensemble (--ensemble clip): also scores each image with a small layer on top of OpenAI's
CLIP image model (trained by test/train_ensemble.py, stored in server/models/), and combines
the two scores into one probability. It catches more AI images for the same number of false
alarms, but is more cautious, so use a lower threshold in AIHound (about 60%). Loads a further
~1.7 GB model. See TODO.md for the numbers.

The model gives a learned probability, not a list of reasons: the per-label scores are
all it reports. Images flagged by AIHound's metadata check never reach this server.
"""

import argparse
import hashlib
import html
import io
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from PIL import Image
from transformers import pipeline

MODELS_DIR = Path(__file__).resolve().parent / "models"

# Labels that mean "AI-generated" across common detector models.
AI_LABELS = {"artificial", "ai", "ai_generated", "fake", "generated", "synthetic"}
EXT = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}

app = FastAPI()
classifier = None
model_id = None
log_dir = None
ensemble = None


class ClipEnsemble:
    """Base-model score + CLIP-layer score -> one calibrated probability (see test/train_ensemble.py)."""

    def __init__(self, path, base_model):
        import numpy as np
        import torch
        from transformers import CLIPModel, CLIPProcessor

        cfg = json.loads(Path(path).read_text())
        if cfg["base_model"] != base_model:
            print(f"warning: {path} was trained for {cfg['base_model']}, not {base_model}; retrain with "
                  f"`npm run train-ensemble -- --model {base_model}`")
        self.np, self.torch = np, torch
        self.device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
        self.model = CLIPModel.from_pretrained(cfg["clip_model"]).to(self.device).eval()
        self.proc = CLIPProcessor.from_pretrained(cfg["clip_model"])
        self.coef = np.array(cfg["probe"]["coef"])
        self.intercept = cfg["probe"]["intercept"]
        self.ref_base, self.ref_clip = np.array(cfg["ref_base"]), np.array(cfg["ref_clip"])
        self.stack = cfg["stack"]
        self.trained = cfg["trained"]

    def percentile(self, ref, s):
        np = self.np
        return float((np.searchsorted(ref, s, "left") + np.searchsorted(ref, s, "right")) / 2 / len(ref))

    def clip_score(self, image):
        torch = self.torch
        with torch.no_grad():
            px = self.proc(images=image, return_tensors="pt")["pixel_values"].to(self.device)
            f = self.model.visual_projection(self.model.vision_model(pixel_values=px).pooler_output)
            f = torch.nn.functional.normalize(f, dim=-1)[0].float().cpu().numpy()
        return float(1 / (1 + self.np.exp(-(f @ self.coef + self.intercept))))

    def combine(self, image, base):
        clip = self.clip_score(image)
        a, b = self.stack["coef"]
        z = a * self.percentile(self.ref_base, base) + b * self.percentile(self.ref_clip, clip) + self.stack["intercept"]
        return float(1 / (1 + self.np.exp(-z))), clip


@app.post("/detect")
async def detect(request: Request):
    body = await request.body()
    try:
        raw = Image.open(io.BytesIO(body))
        fmt, size = raw.format, raw.size
        image = raw.convert("RGB")
    except Exception as exc:
        raise HTTPException(400, f"could not decode image: {exc}")
    t0 = time.perf_counter()
    results = classifier(image, top_k=None)
    score = sum(r["score"] for r in results if r["label"].lower() in AI_LABELS)
    parts = None
    if ensemble:
        base = score
        score, clip = ensemble.combine(image, base)
        parts = {"base": round(base, 4), "clip": round(clip, 4)}
    elapsed = (time.perf_counter() - t0) * 1000
    if log_dir:
        log_check(body, fmt, size, score, results, parts, elapsed, request.headers)
    return {"score": score, "labels": results, **({"parts": parts} if parts else {})}


def log_check(body, fmt, size, score, labels, parts, elapsed_ms, headers):
    digest = hashlib.sha256(body).hexdigest()
    name = digest[:16] + EXT.get(fmt, ".img")
    path = log_dir / "images" / name
    if not path.exists():  # the same image seen twice is stored once
        path.write_bytes(body)
    h = lambda k: headers.get(f"x-aihound-{k}")  # noqa: E731
    threshold = to_float(h("threshold"))
    record = {
        "time": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "image": name,
        "sha256": digest,
        "bytes": len(body),
        "format": fmt,
        "width": size[0],
        "height": size[1],
        "model": model_id + (f" + clip ({ensemble.trained})" if ensemble else ""),
        "score": round(score, 4),
        "labels": {r["label"]: round(r["score"], 4) for r in labels},
        "parts": parts,  # with --ensemble: each detector's own score before combining
        "ms": round(elapsed_ms),
        "source_url": h("source-url"),
        "page_url": h("page-url"),
        "via": h("via"),  # "fetch": the image file itself; "capture": a screenshot of it
        "threshold": threshold,
        "flagged": None if threshold is None else score >= threshold,
        "action": h("action") if threshold is not None and score >= threshold else None,
    }
    with open(log_dir / "log.jsonl", "a") as f:
        f.write(json.dumps(record) + "\n")


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@app.get("/log", response_class=HTMLResponse)
def log_page(flagged: int = 0, limit: int = 200, threshold: float = 0.8):
    """threshold: used for records that don't carry the extension's own (no X-AIHound headers)."""
    if not log_dir:
        return HTMLResponse("<p>Logging is off. Start the server with <code>--log-dir</code> "
                            "(or <code>npm run detector:log</code>).</p>", 404)
    records = []
    if (log_dir / "log.jsonl").exists():
        for line in (log_dir / "log.jsonl").read_text().splitlines():
            try:
                records.append(json.loads(line))
            except ValueError:
                continue
    for r in records:
        thr = r.get("threshold")
        r["_thr"] = thr if thr is not None else threshold
        r["_flagged"] = r["score"] >= r["_thr"]
    total = len(records)
    if flagged:
        records = [r for r in records if r["_flagged"]]
    matching = len(records)
    records = records[::-1][:limit]
    e = html.escape
    rows = []
    for r in records:
        labels = ", ".join(f"{e(k)} {v:.0%}" for k, v in sorted(r["labels"].items(), key=lambda kv: -kv[1]))
        if r.get("parts"):
            labels = f"base model {r['parts']['base']:.0%} · CLIP layer {r['parts']['clip']:.0%}<div class=\"dim\">{labels}</div>"
        links = []
        for key, text in (("page_url", "page"), ("source_url", "image")):
            u = r.get(key) or ""
            if u.startswith(("http://", "https://")):
                links.append(f'<a href="{e(u)}" target="_blank" rel="noreferrer">{text}</a>')
        verdict = "flagged" if r["_flagged"] else "passed"
        rows.append(f"""<tr class="{verdict}">
<td><a href="/log/images/{e(r['image'])}" target="_blank"><img src="/log/images/{e(r['image'])}" loading="lazy"></a></td>
<td class="score">{r['score']:.0%}<div>{verdict} (cut-off {r['_thr']:.0%})</div></td>
<td>{labels}<div class="dim">{e(r.get('model') or '')} · {r['width']}×{r['height']} {e(r.get('format') or '')} · {e(r.get('via') or '')} · {r['ms']} ms</div></td>
<td>{e(r['time'].replace('T', ' '))}<div>{' · '.join(links)}</div></td></tr>""")
    q = {"limit": limit, "threshold": threshold}
    toggle = (f'<a href="/log?{urlencode(q)}">show all</a>' if flagged
              else f'<a href="/log?{urlencode({**q, "flagged": 1})}">show flagged only</a>')
    return f"""<!doctype html><meta charset="utf-8"><title>AIHound log</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#222}}
table{{border-collapse:collapse;width:100%}} td{{border-top:1px solid #ddd;padding:8px;vertical-align:top}}
img{{max-width:160px;max-height:120px;display:block}} .score{{font-size:20px;font-weight:600;white-space:nowrap}}
.score div,.dim{{font-size:12px;font-weight:normal;color:#777;margin-top:4px}}
tr.flagged .score{{color:#c0392b}} tr.passed .score{{color:#2e7d32}}
@media (prefers-color-scheme:dark){{body{{background:#1c1c1e;color:#eee}} td{{border-color:#333}} a{{color:#8ab4f8}}}}
</style>
<h1>AIHound log</h1>
<p>{matching} {'flagged' if flagged else 'checks'} of {total} (showing {len(records)}), newest first · {toggle} · files in <code>{e(str(log_dir))}</code></p>
<p class="dim">Checks that didn't come with AIHound's own cut-off use {threshold:.0%}
(add <code>?threshold=0.5</code> to the address to change it).</p>
<table>{''.join(rows) or '<tr><td>Nothing logged yet.</td></tr>'}</table>"""


@app.get("/log/images/{name}")
def log_image(name: str):
    path = log_dir / "images" / Path(name).name if log_dir else None
    if not path or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


def main():
    global classifier, model_id, log_dir, ensemble
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="haywoodsloan/ai-image-detector-deploy")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--log-dir", help="save every checked image and its result here")
    ap.add_argument("--ensemble", choices=["clip"], help="combine with a CLIP-based layer (use a ~60%% threshold)")
    args = ap.parse_args()
    model_id = args.model
    if args.log_dir:
        log_dir = Path(args.log_dir).resolve()
        (log_dir / "images").mkdir(parents=True, exist_ok=True)
        print(f"logging checks to {log_dir}; browse them at http://127.0.0.1:{args.port}/log")
    classifier = pipeline("image-classification", model=args.model)
    if args.ensemble:
        path = MODELS_DIR / "clip-ensemble.json"
        if not path.exists():
            raise SystemExit(f"{path} is missing; run `npm run train-ensemble` first")
        ensemble = ClipEnsemble(path, args.model)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
