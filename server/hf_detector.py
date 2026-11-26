#!/usr/bin/env python3
"""Self-hosted detector for AIHound's "Custom endpoint" provider.

Runs an open Hugging Face image classifier locally. Free and private, but open models
are generally weaker than commercial APIs, especially on newer generators; treat
the scores as a rough signal.

    uv venv --python 3.12 server/.venv          # PyTorch has no wheels for very new Pythons
    uv pip install --python server/.venv/bin/python -r server/requirements.txt
    server/.venv/bin/python server/hf_detector.py --model Organika/sdxl-detector --port 8765

Then in AIHound Options: provider = Custom, URL = http://127.0.0.1:8765/detect
"""

import argparse
import io

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from PIL import Image
from transformers import pipeline

# Labels that mean "AI-generated" across common detector models.
AI_LABELS = {"artificial", "ai", "ai_generated", "fake", "generated", "synthetic"}

app = FastAPI()
classifier = None


@app.post("/detect")
async def detect(request: Request):
    body = await request.body()
    try:
        image = Image.open(io.BytesIO(body)).convert("RGB")
    except Exception as exc:
        raise HTTPException(400, f"could not decode image: {exc}")
    results = classifier(image, top_k=None)
    score = sum(r["score"] for r in results if r["label"].lower() in AI_LABELS)
    return {"score": score, "labels": results}


def main():
    global classifier
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Organika/sdxl-detector")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    classifier = pipeline("image-classification", model=args.model)
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
