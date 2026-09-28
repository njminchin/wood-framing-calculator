"""Floating Frame Calculator - local web server.

Run:  python server.py   (then open http://127.0.0.1:8765)

Zero third-party dependencies. Data is stored in ./data/db.json and
uploaded painting images in ./data/images/ (next to this script, or next to
the packaged .pyz / .exe). Set FRAME_DATA to use a different folder.

Environment: FRAME_HOST (default 127.0.0.1, use 0.0.0.0 to allow other
devices on the network), FRAME_PORT (default 8765), FRAME_DATA.
"""

import json
import mimetypes
import os
import re
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

# The app can run as a plain script, from a zipapp (.pyz) or as a PyInstaller exe.
_HERE = os.path.dirname(os.path.abspath(__file__))
if getattr(sys, "frozen", False):  # PyInstaller
    STATIC_DIR, STATIC_ZIP = os.path.join(sys._MEIPASS, "static"), None
    APP_DIR = os.path.dirname(os.path.abspath(sys.executable))
elif os.path.isfile(_HERE):  # zipapp: __file__ is inside the .pyz archive
    STATIC_DIR, STATIC_ZIP = None, zipfile.ZipFile(_HERE)
    APP_DIR = os.path.dirname(_HERE)
else:
    STATIC_DIR, STATIC_ZIP = os.path.join(_HERE, "static"), None
    APP_DIR = _HERE

DATA_DIR = os.path.abspath(os.environ.get("FRAME_DATA") or os.path.join(APP_DIR, "data"))
IMAGE_DIR = os.path.join(DATA_DIR, "images")
DB_PATH = os.path.join(DATA_DIR, "db.json")

HOST = os.environ.get("FRAME_HOST", "127.0.0.1")
PORT = int(os.environ.get("FRAME_PORT", "8765"))
MAX_IMAGE_BYTES = 25 * 1024 * 1024

IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

DEFAULT_SETTINGS = {
    "goodThickness": 15,
    "cheapThickness": 12,
    "cheapWidth": 30,
    "cheapPosition": "inside",
    "gap": 5,
    "lip": 3,
    "species": "walnut",
    "tapeDistance": 250,
    "tapeThickness": 0.12,
    "fenceEdge": "outer",
    "kerf": 3,
}

_lock = threading.Lock()


def _empty_db():
    return {"settings": dict(DEFAULT_SETTINGS), "paintings": [], "artists": []}


def load_db():
    if not os.path.exists(DB_PATH):
        return _empty_db()
    with open(DB_PATH, "r", encoding="utf-8") as f:
        db = json.load(f)
    db.setdefault("settings", {})
    db["settings"] = {**DEFAULT_SETTINGS, **db["settings"]}
    db.setdefault("paintings", [])
    db.setdefault("artists", [])
    return db


def save_db(db):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
    os.replace(tmp, DB_PATH)


def all_artists(db):
    names = {a.strip() for a in db["artists"] if a and a.strip()}
    names |= {p.get("artist", "").strip() for p in db["paintings"] if p.get("artist", "").strip()}
    return sorted(names, key=str.casefold)


def read_static(url_path):
    """Bytes of a file under static/ (on disk or inside the .pyz), or None."""
    rel = unquote(url_path).lstrip("/") or "index.html"
    parts = rel.split("/")
    if any(p in ("", ".", "..") or "\\" in p or ":" in p for p in parts):
        return None
    if STATIC_ZIP is not None:
        try:
            return STATIC_ZIP.read("static/" + rel)
        except KeyError:
            return None
    path = os.path.join(STATIC_DIR, *parts)
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def remove_image_files(painting_id):
    for ext in IMAGE_TYPES.values():
        path = os.path.join(IMAGE_DIR, painting_id + ext)
        if os.path.exists(path):
            os.remove(path)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        # Always serve fresh files; this is a local tool, caching only causes confusion.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- helpers -------------------------------------------------------
    def _json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._json({"error": message}, status)

    def _body(self, limit=5 * 1024 * 1024):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ValueError("Request body too large")
        return self.rfile.read(length) if length else b""

    def _json_body(self):
        raw = self._body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _state(self, db):
        return {"settings": db["settings"], "paintings": db["paintings"], "artists": all_artists(db)}

    # ---- routing -------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            with _lock:
                return self._json(self._state(load_db()))
        m = re.fullmatch(r"/images/([A-Za-z0-9_-]+\.(?:jpg|png|webp|gif))", path)
        if m:
            file_path = os.path.join(IMAGE_DIR, m.group(1))
            if not os.path.exists(file_path):
                return self._error(HTTPStatus.NOT_FOUND, "Image not found")
            with open(file_path, "rb") as f:
                data = f.read()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mimetypes.guess_type(file_path)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/api/"):
            return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
        data = read_static(path)
        if data is None:
            return self._error(HTTPStatus.NOT_FOUND, "Not found")
        name = path.rstrip("/").rsplit("/", 1)[-1] or "index.html"
        if "." not in name:
            name = "index.html"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/settings":
                body = self._json_body()
                with _lock:
                    db = load_db()
                    db["settings"] = {**DEFAULT_SETTINGS, **{k: v for k, v in body.items() if k in DEFAULT_SETTINGS}}
                    save_db(db)
                    return self._json(self._state(db))
        except (ValueError, json.JSONDecodeError) as e:
            return self._error(HTTPStatus.BAD_REQUEST, str(e))
        return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/paintings":
                return self._save_painting(self._json_body())
            m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)/image", path)
            if m:
                return self._upload_image(m.group(1))
            if path == "/api/artists":
                name = str(self._json_body().get("name", "")).strip()
                if not name:
                    return self._error(HTTPStatus.BAD_REQUEST, "Artist name required")
                with _lock:
                    db = load_db()
                    if name.casefold() not in {a.casefold() for a in db["artists"]}:
                        db["artists"].append(name)
                        save_db(db)
                    return self._json(self._state(db))
        except (ValueError, json.JSONDecodeError) as e:
            return self._error(HTTPStatus.BAD_REQUEST, str(e))
        return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def do_DELETE(self):
        path = urlparse(self.path).path
        m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)(/image)?", path)
        if m:
            pid, image_only = m.group(1), bool(m.group(2))
            with _lock:
                db = load_db()
                painting = next((p for p in db["paintings"] if p["id"] == pid), None)
                if painting is None:
                    return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
                remove_image_files(pid)
                if image_only:
                    painting["image"] = None
                else:
                    db["paintings"] = [p for p in db["paintings"] if p["id"] != pid]
                save_db(db)
                return self._json(self._state(db))
        m = re.fullmatch(r"/api/artists/(.+)", path)
        if m:
            name = unquote(m.group(1)).strip().casefold()
            with _lock:
                db = load_db()
                db["artists"] = [a for a in db["artists"] if a.strip().casefold() != name]
                save_db(db)
                return self._json(self._state(db))
        return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    # ---- actions -------------------------------------------------------
    def _save_painting(self, body):
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object")
        with _lock:
            db = load_db()
            pid = body.get("id")
            existing = next((p for p in db["paintings"] if p["id"] == pid), None) if pid else None
            record = dict(existing or {})
            record.update({k: v for k, v in body.items() if k not in ("id", "image", "createdAt")})
            if existing is None:
                record["id"] = uuid.uuid4().hex[:12]
                record["createdAt"] = time.time()
                record["image"] = None
                db["paintings"].append(record)
            else:
                existing.clear()
                existing.update(record)
                record = existing
            record["updatedAt"] = time.time()
            artist = str(record.get("artist", "")).strip()
            if artist and artist.casefold() not in {a.casefold() for a in db["artists"]}:
                db["artists"].append(artist)
            save_db(db)
            state = self._state(db)
            state["painting"] = record
            return self._json(state)

    def _upload_image(self, pid):
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        ext = IMAGE_TYPES.get(ctype)
        if ext is None:
            return self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Use a JPEG, PNG, WebP or GIF image")
        data = self._body(limit=MAX_IMAGE_BYTES)
        if not data:
            return self._error(HTTPStatus.BAD_REQUEST, "Empty image")
        with _lock:
            db = load_db()
            painting = next((p for p in db["paintings"] if p["id"] == pid), None)
            if painting is None:
                return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
            os.makedirs(IMAGE_DIR, exist_ok=True)
            remove_image_files(pid)
            with open(os.path.join(IMAGE_DIR, pid + ext), "wb") as f:
                f.write(data)
            painting["image"] = pid + ext
            painting["updatedAt"] = time.time()
            save_db(db)
            state = self._state(db)
            state["painting"] = painting
            return self._json(state)


def _lan_ip():
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 80))  # no packets are sent for UDP connect
            return sock.getsockname()[0]
    except OSError:
        return None


def main():
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    os.makedirs(IMAGE_DIR, exist_ok=True)
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        url = f"http://127.0.0.1:{PORT}/"
        print(f"Could not start on port {PORT} ({e}). Is the app already running? Try {url}")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        sys.exit(1)
    url = f"http://{'127.0.0.1' if HOST in ('0.0.0.0', '') else HOST}:{PORT}/"
    print(f"Floating Frame Calculator running at {url}")
    if HOST in ("0.0.0.0", ""):
        lan_ip = _lan_ip()
        if lan_ip:
            print(f"Other devices on your network: http://{lan_ip}:{PORT}/")
    print("Data folder:", DATA_DIR)
    print("Press Ctrl+C to stop.")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
