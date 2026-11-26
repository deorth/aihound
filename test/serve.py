#!/usr/bin/env python3
"""Local test server for AIHound.

    python3 test/serve.py [--port 8000]

Serves test/site on http://localhost:PORT and again on http://127.0.0.1:PORT+1,
so the page can load cross-origin media. Special routes:

  /protected/<file>       fixture that is only served when the Referer is the test page,
                          so the extension's own fetch is refused (403) and it has to
                          fall back to a screen capture.
  /external/index.json    list of files in fixtures/external/ (see make_fixtures.py --fetch)
"""

import argparse
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITE = Path(__file__).resolve().parent / "site"
MEDIA = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".mp4", ".webm", ".mov")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".avif": "image/avif", ".webp": "image/webp", ".webm": "video/webm", ".mp4": "video/mp4",
        ".js": "text/javascript", ".json": "application/json",
    }
    page_port = 8000

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/external/index.json":
            ext = SITE / "fixtures" / "external"
            files = sorted(p.relative_to(ext).as_posix() for p in ext.rglob("*") if p.suffix.lower() in MEDIA) if ext.exists() else []
            return self.send_json(files)
        if path.startswith("/protected/"):
            referer = self.headers.get("Referer", "")
            allowed = (f"http://localhost:{self.page_port}/", f"http://127.0.0.1:{self.page_port}/")
            if not referer.startswith(allowed):
                self.send_error(403, "Referer check failed")
                return
            self.path = "/fixtures/" + path[len("/protected/"):]
        return super().do_GET()

    def send_json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"[{self.server.server_port}] {fmt % args}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    port = ap.parse_args().port
    Handler.page_port = port
    handler = functools.partial(Handler, directory=str(SITE))
    page = ThreadingHTTPServer(("127.0.0.1", port), handler)
    other = ThreadingHTTPServer(("127.0.0.1", port + 1), handler)
    threading.Thread(target=other.serve_forever, daemon=True).start()
    print(f"Test page:      http://localhost:{port}/")
    print(f"Cross-origin:   http://127.0.0.1:{port + 1}/")
    try:
        page.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
