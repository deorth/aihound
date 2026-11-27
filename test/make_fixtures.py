#!/usr/bin/env python3
"""Generate deterministic test media for AIHound.

Colours are chosen for the extension's "Mock" provider, which scores by average
colour: score = (R - G + 255) / 510, so red ~ AI, green ~ real, grey = 0.5.
Metadata fixtures are deliberately GREEN, so if they are flagged it can only be
by the metadata check.

    python3 test/make_fixtures.py            # regenerate committed fixtures (needs ffmpeg)
    python3 test/make_fixtures.py --fetch    # also download third-party samples to fixtures/external/

Writes test/site/fixtures/*.{jpg,png,...} and test/site/fixtures/manifest.json.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "site" / "fixtures"
EXTERNAL = OUT / "external"
REAL_SAMPLES = HERE / "real-samples.txt"

RED, ABOVE, BELOW, GREY, GREEN = "E61414", "DC2828", "C84840", "808080", "1EC83C"


def mock_score(hex_color):
    r, g = int(hex_color[0:2], 16), int(hex_color[2:4], 16)
    return round((r - g + 255) / 510, 3)


def ff(*args):
    env = {**os.environ, "SVT_LOG": "1"}  # silence the SVT-AV1 banner
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True, env=env)


def image(name, color, size="512x384", extra=()):
    """Solid colour with film-grain noise (so it is not a trivially flat image)."""
    ff("-f", "lavfi", "-i", f"color=c=0x{color}:s={size}", "-vf", "noise=alls=24:allf=t",
       "-frames:v", "1", *extra, str(OUT / name))


def video(name, segments, size="640x360", codec=("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart")):
    """segments: [(colour, seconds), ...] concatenated, with a moving box so frames differ."""
    inputs, labels = [], []
    for i, (color, secs) in enumerate(segments):
        inputs += ["-f", "lavfi", "-i", f"color=c=0x{color}:s={size}:d={secs}:r=24"]
        labels.append(f"[{i}:v]")
    graph = "".join(labels) + f"concat=n={len(segments)}:v=1:a=0,"
    graph += "drawbox=x='mod(t*140,iw-60)':y=ih/2-30:w=60:h=60:color=white@0.5:t=fill[v]"
    ff(*inputs, "-filter_complex", graph, "-map", "[v]", *codec, str(OUT / name))


# ---- metadata injection -------------------------------------------------------

def xmp(digital_source_type):
    return (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" '
        f'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/{digital_source_type}"/>'
        '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    )


def jpeg_add_xmp(path, digital_source_type):
    data = path.read_bytes()
    assert data[:2] == b"\xff\xd8", "not a JPEG"
    payload = b"http://ns.adobe.com/xap/1.0/\x00" + xmp(digital_source_type).encode()
    segment = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    path.write_bytes(data[:2] + segment + data[2:])


def png_chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def png_add_chunks(path, chunks):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    ihdr_end = 8 + 4 + 4 + 13 + 4
    path.write_bytes(data[:ihdr_end] + b"".join(chunks) + data[ihdr_end:])


def text_chunk(key, text):
    return png_chunk(b"tEXt", key.encode("latin-1") + b"\x00" + text.encode("latin-1"))


def xmp_chunk(digital_source_type):
    return png_chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00" + xmp(digital_source_type).encode())


A1111 = ("a photo of a lighthouse at dusk, highly detailed\nNegative prompt: blurry\n"
         "Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234, Size: 512x384, Model: sd_xl_base_1.0")
COMFY = json.dumps({"3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20}},
                    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdxl.safetensors"}}})


# ---- fixture set -------------------------------------------------------------

def build():
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required (brew install ffmpeg)")
    OUT.mkdir(parents=True, exist_ok=True)
    cases = []

    def add(file, kind, title, expect, why, group):
        cases.append({"file": file, "kind": kind, "title": title, "expect": expect, "why": why, "group": group})

    # Score-driven (Mock provider)
    for name, color, title in [
        ("ai-red.jpg", RED, "Strong AI signal"),
        ("ai-above.jpg", ABOVE, "Just above 80% threshold"),
        ("ai-below.jpg", BELOW, "Just below 80% threshold"),
        ("real-grey.jpg", GREY, "Neutral"),
        ("real-green.jpg", GREEN, "Strong real signal"),
    ]:
        image(name, color)
        s = mock_score(color)
        add(name, "img", title, "flag" if s >= 0.8 else "pass", f"mock score ≈ {s:.2f}", "Scores")

    # Formats
    image("ai-red.png", RED)
    add("ai-red.png", "img", "PNG", "flag", "mock ≈ 0.91", "Formats")
    image("ai-red.gif", RED)
    add("ai-red.gif", "img", "GIF (re-encoded before upload)", "flag", "mock ≈ 0.91", "Formats")
    try:
        image("ai-red.avif", RED, extra=("-c:v", "libsvtav1", "-pix_fmt", "yuv420p"))
        add("ai-red.avif", "img", "AVIF (re-encoded before upload)", "flag", "mock ≈ 0.91", "Formats")
    except subprocess.CalledProcessError:
        print("skipping AVIF: ffmpeg has no AV1 encoder")
    image("ai-red-large.jpg", RED, size="4000x3000")
    add("ai-red-large.jpg", "img", "4000×3000 (downscaled before upload)", "flag", "mock ≈ 0.91", "Formats")
    (OUT / "ai-red.svg").write_text(
        "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='384'><rect width='100%' height='100%' fill='#e61414'/></svg>")
    add("ai-red.svg", "img", "SVG", "skip", "vector images are not checked", "Formats")
    image("icon-red.png", RED, size="64x64")
    add("icon-red.png", "img", "64×64 icon", "skip", "below minimum size (150px)", "Formats")

    # Metadata (all green, so only metadata can flag them)
    image("meta-iptc-ai.jpg", GREEN)
    jpeg_add_xmp(OUT / "meta-iptc-ai.jpg", "trainedAlgorithmicMedia")
    add("meta-iptc-ai.jpg", "img", "JPEG, XMP DigitalSourceType = trainedAlgorithmicMedia", "flag", "metadata", "Metadata")
    image("meta-iptc-composite.jpg", GREEN)
    jpeg_add_xmp(OUT / "meta-iptc-composite.jpg", "compositeWithTrainedAlgorithmicMedia")
    add("meta-iptc-composite.jpg", "img", "JPEG, XMP = compositeWithTrainedAlgorithmicMedia", "flag", "metadata", "Metadata")
    image("meta-png-xmp-ai.png", GREEN)
    png_add_chunks(OUT / "meta-png-xmp-ai.png", [xmp_chunk("trainedAlgorithmicMedia")])
    add("meta-png-xmp-ai.png", "img", "PNG, iTXt XMP = trainedAlgorithmicMedia", "flag", "metadata", "Metadata")
    image("meta-a1111.png", GREEN)
    png_add_chunks(OUT / "meta-a1111.png", [text_chunk("parameters", A1111)])
    add("meta-a1111.png", "img", "PNG, Stable Diffusion (A1111) parameters", "flag", "metadata", "Metadata")
    image("meta-comfyui.png", GREEN)
    png_add_chunks(OUT / "meta-comfyui.png", [text_chunk("prompt", COMFY)])
    add("meta-comfyui.png", "img", "PNG, ComfyUI workflow", "flag", "metadata", "Metadata")
    image("meta-camera.jpg", GREEN)
    jpeg_add_xmp(OUT / "meta-camera.jpg", "digitalCapture")
    add("meta-camera.jpg", "img", "JPEG, XMP = digitalCapture (camera)", "pass", "real-camera metadata must not flag", "Metadata")

    # Videos (scored from screen captures)
    video("ai-red.mp4", [(RED, 6)])
    add("ai-red.mp4", "video", "MP4 (H.264)", "flag", "mock ≈ 0.9", "Videos")
    video("ai-red.webm", [(RED, 6)], codec=("-c:v", "libvpx-vp9", "-b:v", "300k"))
    add("ai-red.webm", "video", "WebM (VP9)", "flag", "mock ≈ 0.9", "Videos")
    video("real-green.mp4", [(GREEN, 6)])
    add("real-green.mp4", "video", "Real video", "pass", "mock ≈ 0.2", "Videos")
    video("switch-green-red.mp4", [(GREEN, 3), (RED, 6)])
    add("switch-green-red.mp4", "video", "Green for 3s, then red", "flag",
        "flagged on the 2nd frame sample (~4s)", "Videos")
    video("tiny-red.mp4", [(RED, 4)], size="128x96")
    add("tiny-red.mp4", "video", "128×96 video", "skip", "below minimum size", "Videos")

    (OUT / "manifest.json").write_text(json.dumps(cases, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(cases)} fixtures to {OUT}")


def fetch():
    """Third-party samples. Not committed; licences are the owners'."""
    EXTERNAL.mkdir(parents=True, exist_ok=True)
    entries = [
        # C2PA conformance sample from Adobe (CC BY-SA 4.0, github.com/c2pa-org/public-testfiles):
        # has a C2PA manifest but is NOT AI-generated -> must not be flagged by metadata.
        ("real", "https://raw.githubusercontent.com/c2pa-org/public-testfiles/main/legacy/1.4/image/jpeg/adobe-20220124-CA.jpg"),
    ]
    if REAL_SAMPLES.exists():
        for line in REAL_SAMPLES.read_text().splitlines():
            parts = line.split()
            if not parts or parts[0].startswith("#"):
                continue
            # "ai <url>" / "real <url>"; a bare URL goes in unlabelled (shown on the page, not scored)
            entries.append((parts[0], parts[1]) if parts[0] in ("ai", "real") and len(parts) > 1 else ("", parts[0]))
    for label, url in entries:
        if not url.startswith(("http://", "https://")):
            print(f"skipping malformed line: {label} {url}".strip())
            continue
        name = urllib.parse.unquote(url.split("?")[0].rstrip("/").rsplit("/", 1)[-1])
        folder = EXTERNAL / label if label else EXTERNAL
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / name
        if dest.exists():
            continue
        old = EXTERNAL / name  # from before labels existed
        if label and old.exists():
            old.rename(dest)
            continue
        print(f"fetching {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "aihound-test-fixtures/0.1"})
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    dest.write_bytes(r.read())
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 5:
                    print(f"  failed: {e}")
                    break
                wait = int(e.headers.get("Retry-After") or 5 * 2 ** attempt)
                print(f"  rate limited, waiting {wait}s")
                time.sleep(wait)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                print(f"  failed: {e}")
                break
        time.sleep(1)  # be polite to the host


if __name__ == "__main__":
    build()
    if "--fetch" in sys.argv:
        fetch()
