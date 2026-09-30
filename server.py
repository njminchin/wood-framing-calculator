"""Floating Frame Calculator - local web server.

Run:  python server.py   (then open http://127.0.0.1:8765)

Zero third-party dependencies. Data is stored in ./data/db.json and
uploaded painting images in ./data/images/ (next to this script, or next to
the packaged .pyz / .exe). Set FRAME_DATA to use a different folder.

By default other devices on your network can connect too (e.g. a phone or
tablet in the workshop). Use --local-only (or FRAME_HOST=127.0.0.1) to allow
only this computer.

Accounts (for hosting on the internet): set FRAME_ACCOUNTS=1 and everyone must
sign in; each user gets a private library in data/users/<id>/. Manage them with:
  --create-user NAME   --reset-password NAME   --delete-user NAME   --list-users
  --set-invite-code CODE   --new-invite-code   --disable-signup   --show-invite-code
  --make-admin NAME   --remove-admin NAME   (admins can manage the invite code in the app)

Environment: FRAME_HOST (default 0.0.0.0 = all network interfaces),
FRAME_PORT (default 8765), FRAME_DATA, FRAME_ACCOUNTS.
"""

import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

from accounts import SESSION_SECONDS, AccountError, Accounts, random_invite_code

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
ACCOUNTS = Accounts(DATA_DIR) if os.environ.get("FRAME_ACCOUNTS") == "1" else None
SESSION_COOKIE = "ff_session"

HOST = "127.0.0.1" if "--local-only" in sys.argv else os.environ.get("FRAME_HOST", "0.0.0.0")
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
    "skuFormat": "{PREFIX}-{YYYY}-{SEQ:4}",
    "skuPrefix": "FF",
    "chimeMinutes": 10,
}

_lock = threading.Lock()


class Store:
    """One library of paintings: db.json plus an images folder."""

    def __init__(self, root):
        self.root = root
        self.db_path = os.path.join(root, "db.json")
        self.image_dir = os.path.join(root, "images")

    def load(self):
        if not os.path.exists(self.db_path):
            return {"settings": dict(DEFAULT_SETTINGS), "paintings": [], "artists": []}
        with open(self.db_path, "r", encoding="utf-8") as f:
            db = json.load(f)
        db["settings"] = {**DEFAULT_SETTINGS, **db.get("settings", {})}
        db.setdefault("paintings", [])
        db.setdefault("artists", [])
        return db

    def save(self, db):
        os.makedirs(self.root, exist_ok=True)
        tmp = self.db_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(db, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.db_path)

    def remove_images(self, painting_id):
        for ext in IMAGE_TYPES.values():
            path = os.path.join(self.image_dir, painting_id + ext)
            if os.path.exists(path):
                os.remove(path)


SHARED_STORE = Store(DATA_DIR)

# Read-only share links: token -> {"user": account id (None without accounts), "painting": id}.
# Kept in one file for the whole site so a link can be opened without signing in.
SHARES_PATH = os.path.join(DATA_DIR, "shares.json")


def load_shares():
    try:
        with open(SHARES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_shares(shares):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = SHARES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(shares, f, indent=2)
    os.replace(tmp, SHARES_PATH)


def shared_painting(token):
    """(store, db, painting, owner name) for a share token, or None if it's not valid any more."""
    entry = load_shares().get(token) if isinstance(token, str) else None
    if not entry:
        return None
    owner = None
    if ACCOUNTS is None:
        if entry.get("user"):
            return None
        store = SHARED_STORE
    else:
        user = ACCOUNTS.get(entry.get("user"))
        if user is None:
            return None
        store, owner = Store(ACCOUNTS.user_dir(user)), user["username"]
    db = store.load()
    painting = next((p for p in db["paintings"] if p["id"] == entry.get("painting")), None)
    if painting is None or painting.get("shareToken") != token:
        return None
    return store, db, painting, owner


def all_artists(db):
    names = {a.strip() for a in db["artists"] if a and a.strip()}
    names |= {p.get("artist", "").strip() for p in db["paintings"] if p.get("artist", "").strip()}
    return sorted(names, key=str.casefold)


# ---- Build timer ------------------------------------------------------------
# One workshop timer per library. While it runs, the time is shared equally between
# the frames marked "building". Whenever that set changes (or the timer stops), the
# time since the last split is added to each of those frames' timeLog.

def building_paintings(db):
    return [p for p in db["paintings"] if p.get("status") == "building"]


def split_timer(db, now=None):
    """Credit the running timer's time so far to the frames being built right now."""
    timer = db.get("timer") or {}
    if not timer.get("start"):
        return
    now = now or time.time()
    frames = building_paintings(db)
    seconds = now - timer["segmentStart"]
    if frames and seconds > 0:
        for p in frames:
            p.setdefault("timeLog", []).append({
                "id": uuid.uuid4().hex[:8], "session": timer["start"],
                "start": timer["segmentStart"], "end": now,
                "seconds": seconds / len(frames), "frames": len(frames),
            })
    timer["segmentStart"] = now


def stop_timer(db):
    split_timer(db)
    db["timer"] = {"start": None, "segmentStart": None}


def stop_timer_if_idle(db):
    """Stop the timer when nothing is being built any more. True if it was stopped."""
    if (db.get("timer") or {}).get("start") and not building_paintings(db):
        stop_timer(db)
        return True
    return False


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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        # Always serve fresh files; this is a small tool, caching only causes confusion.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- helpers -------------------------------------------------------
    def _json(self, obj, status=HTTPStatus.OK, headers=()):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        headers = list(headers)
        if getattr(self, "_renewed_token", None) and not any(k == "Set-Cookie" for k, _ in headers):
            headers.append(self._session_cookie(self._renewed_token))  # push the expiry back
        for k, v in headers:
            self.send_header(k, v)
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
        body = json.loads(raw.decode("utf-8")) if raw else {}
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object")
        return body

    def _state(self, db):
        return {"settings": db["settings"], "paintings": db["paintings"], "artists": all_artists(db),
                "timer": db.get("timer") or {"start": None, "segmentStart": None}, "now": time.time()}

    # ---- accounts ------------------------------------------------------
    def _client_ip(self):
        ip = self.client_address[0]
        # Behind Caddy on the same machine, the real address is in X-Forwarded-For.
        if ip in ("127.0.0.1", "::1") and self.headers.get("X-Forwarded-For"):
            ip = self.headers["X-Forwarded-For"].split(",")[0].strip()
        return ip

    def _token(self):
        cookie = SimpleCookie(self.headers.get("Cookie") or "")
        return cookie[SESSION_COOKIE].value if SESSION_COOKIE in cookie else None

    def _session_cookie(self, token, max_age=SESSION_SECONDS):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return ("Set-Cookie", f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")

    def _user(self):
        if not ACCOUNTS:
            return None
        token = self._token()
        user, renewed = ACCOUNTS.user_for_token(token)
        if renewed:
            self._renewed_token = token
        return user

    def _store(self):
        """The library for this request, or None after replying 401 (not signed in)."""
        if ACCOUNTS is None:
            return SHARED_STORE
        user = self._user()
        if user is None:
            self._error(HTTPStatus.UNAUTHORIZED, "Please sign in")
            return None
        return Store(ACCOUNTS.user_dir(user))

    def _auth_status(self):
        user = self._user()
        return {
            "accounts": ACCOUNTS is not None,
            "user": user["username"] if user else None,
            "signup": bool(ACCOUNTS and ACCOUNTS.invite_code),
            "admin": bool(user and ACCOUNTS.is_admin(user)),
        }

    def _admin(self):
        """The signed-in admin, or None after replying 401/403."""
        if ACCOUNTS is None:
            self._error(HTTPStatus.NOT_FOUND, "Accounts are not enabled")
            return None
        user = self._user()
        if user is None:
            self._error(HTTPStatus.UNAUTHORIZED, "Please sign in")
            return None
        if not ACCOUNTS.is_admin(user):
            self._error(HTTPStatus.FORBIDDEN, "Only the site admin can do that.")
            return None
        return user

    def _auth_post(self, action, body):
        if ACCOUNTS is None:
            return self._error(HTTPStatus.NOT_FOUND, "Accounts are not enabled")
        ip = self._client_ip()
        if action == "logout":
            ACCOUNTS.end_session(self._token())
            return self._json({"ok": True}, headers=[self._session_cookie("", 0)])

        if action == "password":
            user = self._user()
            if user is None:
                return self._error(HTTPStatus.UNAUTHORIZED, "Please sign in")
            if not ACCOUNTS.verify(user["username"], body.get("current")):
                return self._error(HTTPStatus.FORBIDDEN, "Your current password isn't right.")
            try:
                ACCOUNTS.set_password(user["username"], body.get("new"))
            except AccountError as e:
                return self._error(HTTPStatus.BAD_REQUEST, str(e))
            token = ACCOUNTS.new_session(user)  # other devices were signed out
            return self._json({"ok": True}, headers=[self._session_cookie(token)])

        username = str(body.get("username", "")).strip()
        keys = [f"ip:{ip}", f"user:{username.casefold()}"]
        wait = ACCOUNTS.throttled(*keys)
        if wait:
            return self._error(HTTPStatus.TOO_MANY_REQUESTS, f"Too many attempts. Try again in {max(1, wait // 60)} minute(s).")

        if action == "login":
            user = ACCOUNTS.verify(username, body.get("password"))
            if user is None:
                ACCOUNTS.note_failure(*keys)
                return self._error(HTTPStatus.UNAUTHORIZED, "Wrong username or password.")
        elif action == "signup":
            if not ACCOUNTS.invite_code:
                return self._error(HTTPStatus.FORBIDDEN, "Sign-up is closed. Ask the site owner for an account.")
            if not ACCOUNTS.check_invite(body.get("inviteCode")):
                ACCOUNTS.note_failure(f"ip:{ip}")
                return self._error(HTTPStatus.FORBIDDEN, "That invite code isn't right.")
            try:
                user = ACCOUNTS.create(username, body.get("password"))
            except AccountError as e:
                return self._error(HTTPStatus.BAD_REQUEST, str(e))
        else:
            return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

        ACCOUNTS.clear_failures(*keys)
        token = ACCOUNTS.new_session(user)
        return self._json({"ok": True, "user": user["username"]}, headers=[self._session_cookie(token)])

    # ---- routing -------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/auth":
            return self._json(self._auth_status())
        if path == "/api/admin/invite":
            if self._admin():
                self._json({"inviteCode": ACCOUNTS.invite_code})
            return
        if path == "/api/state":
            store = self._store()
            if store:
                with _lock:
                    self._json(self._state(store.load()))
            return
        m = re.fullmatch(r"/api/share/([A-Za-z0-9_-]+)(/image)?", path)
        if m:
            with _lock:
                found = shared_painting(m.group(1))
            if found is None:
                return self._error(HTTPStatus.NOT_FOUND, "This share link isn't valid any more. Ask the owner for a new one.")
            store, db, painting, owner = found
            if not m.group(2):
                public = {k: v for k, v in painting.items() if k != "timeLog"}
                return self._json({"painting": public, "settings": db["settings"], "owner": owner})
            if not painting.get("image"):
                return self._error(HTTPStatus.NOT_FOUND, "Image not found")
            return self._send_image(os.path.join(store.image_dir, painting["image"]))
        m = re.fullmatch(r"/images/([A-Za-z0-9_-]+\.(?:jpg|png|webp|gif))", path)
        if m:
            store = self._store()
            if not store:
                return
            return self._send_image(os.path.join(store.image_dir, m.group(1)))
        if path.startswith("/api/"):
            return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
        return self._send_static(path)

    def _send_image(self, file_path):
        if not os.path.exists(file_path):
            return self._error(HTTPStatus.NOT_FOUND, "Image not found")
        with open(file_path, "rb") as f:
            data = f.read()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(file_path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_static(self, path):
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
        if path != "/api/settings":
            return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
        store = self._store()
        if not store:
            return
        try:
            body = self._json_body()
        except (ValueError, json.JSONDecodeError) as e:
            return self._error(HTTPStatus.BAD_REQUEST, str(e))
        with _lock:
            db = store.load()
            db["settings"] = {**DEFAULT_SETTINGS, **{k: v for k, v in body.items() if k in DEFAULT_SETTINGS}}
            store.save(db)
            return self._json(self._state(db))

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            m = re.fullmatch(r"/api/auth/(login|signup|logout|password)", path)
            if m:
                return self._auth_post(m.group(1), self._json_body())
            if path == "/api/admin/invite":
                if not self._admin():
                    return
                action = self._json_body().get("action")
                if action == "new":
                    ACCOUNTS.set_invite_code(random_invite_code())
                elif action == "disable":
                    ACCOUNTS.set_invite_code(None)
                else:
                    return self._error(HTTPStatus.BAD_REQUEST, "Unknown action")
                return self._json({"inviteCode": ACCOUNTS.invite_code})
            store = self._store()
            if not store:
                return
            if path == "/api/paintings":
                return self._save_painting(store, self._json_body())
            m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)/image", path)
            if m:
                return self._upload_image(store, m.group(1))
            m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)/share", path)
            if m:
                return self._set_share(store, m.group(1), bool(self._json_body().get("share")))
            if path == "/api/timer":
                return self._timer(store, self._json_body().get("action"))
            m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)/time", path)
            if m:
                return self._add_time(store, m.group(1), self._json_body())
            m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)/status", path)
            if m:
                return self._set_status(store, m.group(1), self._json_body().get("status"))
            if path == "/api/artists":
                name = str(self._json_body().get("name", "")).strip()
                if not name:
                    return self._error(HTTPStatus.BAD_REQUEST, "Artist name required")
                with _lock:
                    db = store.load()
                    if name.casefold() not in {a.casefold() for a in db["artists"]}:
                        db["artists"].append(name)
                        store.save(db)
                    return self._json(self._state(db))
        except (ValueError, json.JSONDecodeError) as e:
            return self._error(HTTPStatus.BAD_REQUEST, str(e))
        return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def do_DELETE(self):
        path = urlparse(self.path).path
        store = self._store()
        if not store:
            return
        m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)/time/([A-Za-z0-9_-]+)", path)
        if m:
            with _lock:
                db = store.load()
                painting = next((p for p in db["paintings"] if p["id"] == m.group(1)), None)
                if painting is None:
                    return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
                painting["timeLog"] = [e for e in painting.get("timeLog", []) if e.get("id") != m.group(2)]
                store.save(db)
                state = self._state(db)
                state["painting"] = painting
                return self._json(state)
        m = re.fullmatch(r"/api/paintings/([A-Za-z0-9_-]+)(/image)?", path)
        if m:
            pid, image_only = m.group(1), bool(m.group(2))
            with _lock:
                db = store.load()
                painting = next((p for p in db["paintings"] if p["id"] == pid), None)
                if painting is None:
                    return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
                store.remove_images(pid)
                if image_only:
                    painting["image"] = None
                else:
                    split_timer(db)
                    db["paintings"] = [p for p in db["paintings"] if p["id"] != pid]
                    stop_timer_if_idle(db)
                    shares = load_shares()
                    if shares.pop(painting.get("shareToken"), None):
                        save_shares(shares)
                store.save(db)
                return self._json(self._state(db))
        m = re.fullmatch(r"/api/artists/(.+)", path)
        if m:
            name = unquote(m.group(1)).strip().casefold()
            with _lock:
                db = store.load()
                db["artists"] = [a for a in db["artists"] if a.strip().casefold() != name]
                store.save(db)
                return self._json(self._state(db))
        return self._error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    # ---- actions -------------------------------------------------------
    def _save_painting(self, store, body):
        with _lock:
            db = store.load()
            pid = body.get("id")
            existing = next((p for p in db["paintings"] if p["id"] == pid), None) if pid else None
            record = dict(existing or {})
            record.update({k: v for k, v in body.items() if k not in ("id", "image", "createdAt", "status", "buildingAt", "madeAt", "shareToken", "timeLog")})
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
            store.save(db)
            state = self._state(db)
            state["painting"] = record
            return self._json(state)

    def _set_share(self, store, pid, share):
        """Make (or keep) a read-only share link for a painting, or stop sharing it."""
        with _lock:
            db = store.load()
            painting = next((p for p in db["paintings"] if p["id"] == pid), None)
            if painting is None:
                return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
            shares = load_shares()
            token = painting.get("shareToken")
            if share and not (token and token in shares):
                token = secrets.token_urlsafe(16)
                user = self._user()
                shares[token] = {"user": user["id"] if user else None, "painting": pid, "createdAt": time.time()}
                painting["shareToken"] = token
            elif not share:
                shares.pop(token, None)
                painting["shareToken"] = None
            save_shares(shares)
            store.save(db)
            state = self._state(db)
            state["painting"] = painting
            return self._json(state)

    def _set_status(self, store, pid, status):
        """Set where the frame is up to: None (not started), "building" or "made", with the time."""
        if status not in (None, "building", "made"):
            return self._error(HTTPStatus.BAD_REQUEST, "Unknown status")
        with _lock:
            db = store.load()
            painting = next((p for p in db["paintings"] if p["id"] == pid), None)
            if painting is None:
                return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
            now = time.time()
            split_timer(db, now)  # time so far goes to the frames that were being built
            if status is None:
                painting["buildingAt"] = painting["madeAt"] = None
            elif status == "building":
                if painting.get("status") != "building":
                    painting["buildingAt"] = now
                painting["madeAt"] = None
            elif painting.get("status") != "made":
                painting["madeAt"] = now
            painting["status"] = status
            stopped = stop_timer_if_idle(db)
            store.save(db)
            state = self._state(db)
            state["painting"] = painting
            state["timerStopped"] = stopped
            return self._json(state)

    def _timer(self, store, action):
        """Start or stop the build timer."""
        with _lock:
            db = store.load()
            timer = db.get("timer") or {}
            if action == "start":
                if not building_paintings(db):
                    return self._error(HTTPStatus.BAD_REQUEST, "Mark at least one frame as Building first.")
                if not timer.get("start"):
                    now = time.time()
                    db["timer"] = {"start": now, "segmentStart": now}
            elif action == "stop":
                stop_timer(db)
            else:
                return self._error(HTTPStatus.BAD_REQUEST, "Unknown action")
            store.save(db)
            return self._json(self._state(db))

    def _add_time(self, store, pid, body):
        """Add (or with negative minutes, take off) time by hand, e.g. when the timer wasn't running."""
        try:
            minutes = float(body.get("minutes"))
        except (TypeError, ValueError):
            return self._error(HTTPStatus.BAD_REQUEST, "Enter a number of minutes")
        if not minutes or abs(minutes) > 100 * 60:
            return self._error(HTTPStatus.BAD_REQUEST, "Enter a number of minutes")
        with _lock:
            db = store.load()
            painting = next((p for p in db["paintings"] if p["id"] == pid), None)
            if painting is None:
                return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
            now = time.time()
            painting.setdefault("timeLog", []).append({
                "id": uuid.uuid4().hex[:8], "start": now, "end": now,
                "seconds": minutes * 60, "manual": True, "note": str(body.get("note") or "")[:200],
            })
            store.save(db)
            state = self._state(db)
            state["painting"] = painting
            return self._json(state)

    def _upload_image(self, store, pid):
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        ext = IMAGE_TYPES.get(ctype)
        if ext is None:
            return self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Use a JPEG, PNG, WebP or GIF image")
        data = self._body(limit=MAX_IMAGE_BYTES)
        if not data:
            return self._error(HTTPStatus.BAD_REQUEST, "Empty image")
        with _lock:
            db = store.load()
            painting = next((p for p in db["paintings"] if p["id"] == pid), None)
            if painting is None:
                return self._error(HTTPStatus.NOT_FOUND, "Painting not found")
            os.makedirs(store.image_dir, exist_ok=True)
            store.remove_images(pid)
            with open(os.path.join(store.image_dir, pid + ext), "wb") as f:
                f.write(data)
            painting["image"] = pid + ext
            painting["updatedAt"] = time.time()
            store.save(db)
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


def _ask_new_password(username):
    """New password from the terminal (asked twice), or one line from stdin when piped."""
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\n")
    import getpass
    while True:
        pw = getpass.getpass(f"Password for {username} (at least 8 characters): ")
        if len(pw) < 8:
            print("Too short - use at least 8 characters.")
            continue
        if getpass.getpass("Repeat password: ") == pw:
            return pw
        print("Passwords didn't match - try again.")


def account_command(argv):
    """Handle account management options. Returns True if one was run."""
    def arg_after(flag):
        i = argv.index(flag)
        if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
            sys.exit(f"{flag} needs a value.")
        return argv[i + 1]

    accounts = Accounts(DATA_DIR)
    try:
        if "--list-users" in argv:
            users = accounts.list_users()
            print(f"Accounts in {DATA_DIR}:")
            for u in users:
                role = "  [admin]" if accounts.is_admin(u) else ""
                print(f"  {u['username']}{role}  (library: {accounts.user_dir(u)})")
            if not users:
                print("  (none)")
            code = accounts.invite_code
            print(f"Sign-up: {'open with invite code ' + code if code else 'closed'}")
        elif "--create-user" in argv:
            name = arg_after("--create-user")
            user = accounts.create(name, _ask_new_password(name))
            print(f"Created account '{user['username']}'.")
            if user.get("claimedLibrary"):
                print("As the first account, it has taken over the existing library of paintings.")
        elif "--reset-password" in argv:
            name = arg_after("--reset-password")
            if not accounts.find(name):
                raise AccountError(f"There's no account called '{name}'.")
            accounts.set_password(name, _ask_new_password(name))
            print(f"Password changed for '{name}' (signed out everywhere).")
        elif "--delete-user" in argv:
            user = accounts.delete(arg_after("--delete-user"))
            print(f"Deleted account '{user['username']}'. Their library is still in {accounts.user_dir(user)}")
        elif "--set-invite-code" in argv:
            code = arg_after("--set-invite-code").strip()
            if len(code) < 6:
                raise AccountError("Use an invite code of at least 6 characters.")
            accounts.set_invite_code(code)
            print(f"Invite code set: {code}")
        elif "--new-invite-code" in argv:
            code = random_invite_code()
            accounts.set_invite_code(code)
            print(f"New invite code: {code}")
        elif "--disable-signup" in argv:
            accounts.set_invite_code(None)
            print("Sign-up is closed (no invite code).")
        elif "--make-admin" in argv:
            user = accounts.set_admin(arg_after("--make-admin"), True)
            print(f"'{user['username']}' is now an admin.")
        elif "--remove-admin" in argv:
            user = accounts.set_admin(arg_after("--remove-admin"), False)
            print(f"'{user['username']}' is no longer an admin.")
        elif "--show-invite-code" in argv:
            code = accounts.invite_code
            print(f"Invite code: {code}" if code else "Sign-up is closed (no invite code).")
        else:
            return False
    except AccountError as e:
        sys.exit(str(e))
    return True


def main():
    if account_command(sys.argv[1:]):
        return
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    os.makedirs(DATA_DIR, exist_ok=True)
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
            if os.name == "nt":
                print("(If they can't connect, allow the app through Windows Firewall on Private networks.)")
    elif HOST in ("127.0.0.1", "localhost"):
        print("Only this computer can connect (local-only mode).")
    print("Data folder:", DATA_DIR)
    if ACCOUNTS:
        print(f"Accounts are on: {len(ACCOUNTS.list_users())} user(s), sign-up {'open' if ACCOUNTS.invite_code else 'closed'}.")
    print("Press Ctrl+C to stop.")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
