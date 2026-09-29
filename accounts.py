"""User accounts for the hosted version (enabled with FRAME_ACCOUNTS=1).

- Each user has a private library in <data>/users/<user id>/.
- Sign-up needs the invite code (none set = sign-up closed).
- Passwords are stored as salted PBKDF2-SHA256 hashes.
- Sessions are random tokens in an HttpOnly cookie; only their SHA-256 is stored.
  They last a year from the last visit.
- Repeated failed sign-ins (or invite codes) are throttled per IP and per username.

Everything is kept in two small JSON files in the data folder, re-read on each
request so that command-line changes (e.g. --create-user) apply immediately.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import threading
import time
import uuid

ITERATIONS = 310_000
# Sessions last a year and are pushed back to a year from "now" whenever they're used
# (at most once a day), so regular users effectively stay signed in.
SESSION_SECONDS = 365 * 24 * 3600
RENEW_AFTER = 24 * 3600
MIN_PASSWORD = 8
NAME_RE = re.compile(r"[A-Za-z0-9._@-]{2,40}")
MAX_FAILURES = 5
FAILURE_WINDOW = 15 * 60
INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I lookalikes


class AccountError(Exception):
    """A problem to show the user (bad password, name taken, ...)."""


def hash_password(password, salt=None, iterations=ITERATIONS):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def check_password(password, stored):
    try:
        _, iterations, salt, _digest = stored.split("$")
        expected = hash_password(password, bytes.fromhex(salt), int(iterations))
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(expected, stored)


# Used when the username doesn't exist, so a failed sign-in takes the same time either way.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def random_invite_code():
    return "-".join("".join(secrets.choice(INVITE_ALPHABET) for _ in range(4)) for _ in range(3))


def _sha(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Accounts:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.accounts_path = os.path.join(data_dir, "accounts.json")
        self.sessions_path = os.path.join(data_dir, "sessions.json")
        self.lock = threading.Lock()
        self.failures = {}  # throttle key -> [count, first failure time]

    # ---- storage --------------------------------------------------------
    @staticmethod
    def _read(path, default):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return default

    @staticmethod
    def _write(path, obj):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)

    def _accounts(self):
        data = self._read(self.accounts_path, {})
        data.setdefault("users", [])
        data.setdefault("inviteCode", None)
        return data

    def user_dir(self, user):
        return os.path.join(self.data_dir, "users", user["id"])

    # ---- users ----------------------------------------------------------
    def list_users(self):
        return self._accounts()["users"]

    def find(self, username):
        key = str(username or "").casefold()
        return next((u for u in self._accounts()["users"] if u["username"].casefold() == key), None)

    def get(self, user_id):
        return next((u for u in self._accounts()["users"] if u["id"] == user_id), None)

    @staticmethod
    def _check_new_password(password):
        if len(password or "") < MIN_PASSWORD:
            raise AccountError(f"Passwords need at least {MIN_PASSWORD} characters.")

    def create(self, username, password):
        """Create an account. The very first account takes over any existing
        single-user library (data/db.json and data/images) so nothing is lost."""
        username = str(username or "").strip()
        if not NAME_RE.fullmatch(username):
            raise AccountError("Usernames need 2-40 characters: letters, numbers and . _ @ -")
        self._check_new_password(password)
        with self.lock:
            data = self._accounts()
            if any(u["username"].casefold() == username.casefold() for u in data["users"]):
                raise AccountError("That username is taken.")
            user = {"id": uuid.uuid4().hex[:12], "username": username,
                    "password": hash_password(password), "createdAt": time.time()}
            first = not data["users"]
            data["users"].append(user)
            self._write(self.accounts_path, data)
        user_dir = self.user_dir(user)
        os.makedirs(user_dir, exist_ok=True)
        if first:
            user["claimedLibrary"] = self._claim_legacy_library(user_dir)
        return user

    def _claim_legacy_library(self, user_dir):
        moved = False
        for name in ("db.json", "images"):
            src = os.path.join(self.data_dir, name)
            if os.path.exists(src) and not os.path.exists(os.path.join(user_dir, name)):
                shutil.move(src, os.path.join(user_dir, name))
                moved = True
        return moved

    def set_password(self, username, password):
        self._check_new_password(password)
        with self.lock:
            data = self._accounts()
            user = next((u for u in data["users"] if u["username"].casefold() == str(username).casefold()), None)
            if user is None:
                raise AccountError(f"There's no account called '{username}'.")
            user["password"] = hash_password(password)
            self._write(self.accounts_path, data)
        self.end_sessions_for(user["id"])  # sign out everywhere else
        return user

    def delete(self, username):
        """Remove the account. Their library folder is left on disk."""
        with self.lock:
            data = self._accounts()
            user = next((u for u in data["users"] if u["username"].casefold() == str(username).casefold()), None)
            if user is None:
                raise AccountError(f"There's no account called '{username}'.")
            data["users"] = [u for u in data["users"] if u["id"] != user["id"]]
            self._write(self.accounts_path, data)
        self.end_sessions_for(user["id"])
        return user

    def verify(self, username, password):
        user = self.find(username)
        ok = check_password(password or "", user["password"] if user else _DUMMY_HASH)
        return user if (user and ok) else None

    # ---- invite code ----------------------------------------------------
    @property
    def invite_code(self):
        return self._accounts()["inviteCode"]

    def set_invite_code(self, code):
        with self.lock:
            data = self._accounts()
            data["inviteCode"] = code or None
            self._write(self.accounts_path, data)

    def check_invite(self, code):
        expected = self.invite_code
        if not expected:
            return False
        norm = lambda c: str(c or "").strip().upper().replace(" ", "")
        return hmac.compare_digest(norm(code), norm(expected))

    # ---- sessions -------------------------------------------------------
    def _sessions(self):
        now = time.time()
        return {k: v for k, v in self._read(self.sessions_path, {}).items() if v.get("expires", 0) > now}

    def new_session(self, user):
        token = secrets.token_urlsafe(32)
        with self.lock:
            sessions = self._sessions()
            sessions[_sha(token)] = {"user": user["id"], "expires": time.time() + SESSION_SECONDS}
            self._write(self.sessions_path, sessions)
        return token

    def user_for_token(self, token):
        """(user, renewed) for a valid session token, else (None, False).
        `renewed` means the expiry was just pushed back, so the cookie should be re-sent."""
        if not token:
            return None, False
        key = _sha(token)
        entry = self._sessions().get(key)
        user = self.get(entry["user"]) if entry else None
        if user is None:
            return None, False
        renewed = False
        if entry["expires"] - time.time() < SESSION_SECONDS - RENEW_AFTER:
            with self.lock:
                sessions = self._sessions()
                if key in sessions:
                    sessions[key]["expires"] = time.time() + SESSION_SECONDS
                    self._write(self.sessions_path, sessions)
                    renewed = True
        return user, renewed

    def end_session(self, token):
        with self.lock:
            sessions = self._sessions()
            if sessions.pop(_sha(token or ""), None) is not None:
                self._write(self.sessions_path, sessions)

    def end_sessions_for(self, user_id, keep_token=None):
        keep = _sha(keep_token) if keep_token else None
        with self.lock:
            sessions = self._sessions()
            sessions = {k: v for k, v in sessions.items() if v["user"] != user_id or k == keep}
            self._write(self.sessions_path, sessions)

    # ---- throttling -----------------------------------------------------
    def throttled(self, *keys):
        """Seconds until these keys may try again (0 = allowed)."""
        now = time.time()
        wait = 0
        for key in keys:
            count, first = self.failures.get(key, (0, now))
            if now - first > FAILURE_WINDOW:
                self.failures.pop(key, None)
            elif count >= MAX_FAILURES:
                wait = max(wait, int(FAILURE_WINDOW - (now - first)) + 1)
        return wait

    def note_failure(self, *keys):
        now = time.time()
        for key in keys:
            count, first = self.failures.get(key, (0, now))
            if now - first > FAILURE_WINDOW:
                count, first = 0, now
            self.failures[key] = [count + 1, first]

    def clear_failures(self, *keys):
        for key in keys:
            self.failures.pop(key, None)
